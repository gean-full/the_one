"""Pré-anotação automática: desenha as caixas com o YOLOE (vocabulário aberto, prompts de texto) e grava rótulos no formato YOLO.

Uso:  python pre_anotar.py PASTA_FOTOS PASTA_SAIDA
Aceita subpastas: uma pasta com o nome da classe (caixa/, manequim/...) define a classe principal das fotos dentro dela;
fora disso vale o início do nome do arquivo (caixa_frente.jpg). Fotos 'vazio_*' ou numa pasta vazio/ ficam sem caixas.
Fotos que já existem em PASTA_SAIDA/images são puladas: dá para juntar lotes novos ao mesmo banco sem perder as revisões feitas.
Saída: PASTA_SAIDA/images/*.jpg, PASTA_SAIDA/labels/*.txt (classe cx cy w h, normalizados), PASTA_SAIDA/revisao/*.jpg (caixas desenhadas)
       e PASTA_SAIDA/classes.txt (para importar no makesense.ai, CVAT ou Label Studio e corrigir à mão).
As caixas são um RASCUNHO: revise todas antes de treinar.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from classes import CLASSES, PROMPTS, classe_do_arquivo, eh_vazia

CONF = 0.08          # baixo de propósito: melhor sobrar caixa para apagar do que faltar
CONF_OUTRAS = 0.25   # objetos de outra classe que aparecem na foto precisam de mais confiança
EXTENSOES = ('.jpg', '.jpeg', '.png', '.webp', '.heic')


def listar_fotos(origem):
    """(foto, nome de saída, classe principal ou None, vazia?) para cada foto da pasta, incluindo subpastas."""
    for foto in sorted(p for p in Path(origem).rglob('*') if p.suffix.lower() in EXTENSOES and not p.name.startswith('.')):
        pasta = foto.parent.name.lower()
        if pasta in CLASSES:
            nome = foto.stem if foto.stem.lower().startswith(pasta) else f'{pasta}_{foto.stem}'
            yield foto, nome, pasta, False
        elif pasta in ('vazio', 'fundo'):
            yield foto, foto.stem if eh_vazia(foto.stem) else f'vazio_{foto.stem}', None, True
        else:
            yield foto, foto.stem, classe_do_arquivo(foto.name), eh_vazia(foto.name)


def abrir(foto):
    if foto.suffix.lower() == '.heic':
        from pillow_heif import register_heif_opener   # fotos de iPhone
        register_heif_opener()
    return ImageOps.exif_transpose(Image.open(foto)).convert('RGB')   # aplica a rotação do celular


def main(origem, destino):
    destino = Path(destino)
    for sub in ('images', 'labels', 'revisao'):
        (destino / sub).mkdir(parents=True, exist_ok=True)
    (destino / 'classes.txt').write_text('\n'.join(CLASSES) + '\n')
    fotos = [f for f in listar_fotos(origem) if not (destino / 'images' / (f[1] + '.jpg')).exists()]
    if not fotos:
        print('Nenhuma foto nova em', origem)
        return []
    from ultralytics import YOLOE
    modelo = YOLOE('yoloe-11l-seg.pt')   # pesos e codificador de texto (MobileCLIP) vêm dos assets do Ultralytics no GitHub
    textos = [PROMPTS[c] for c in CLASSES]
    modelo.set_classes(textos, modelo.get_text_pe(textos))
    resumo = []
    for foto, nome, principal, vazia in fotos:
        img = abrir(foto)
        if max(img.size) > 1600:   # fotos de 12 MP não ajudam o treino (416 px) e deixam o banco pesado
            img.thumbnail((1600, 1600))
        img.save(destino / 'images' / (nome + '.jpg'), quality=92)
        W, H = img.size
        caixas = []
        if not vazia:
            r = modelo.predict(img, conf=CONF, iou=0.5, verbose=False)[0]
            for b, c, s in zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist()):
                n = CLASSES[int(c)]
                if n != principal and s < CONF_OUTRAS:
                    continue
                caixas.append((n, s, b))
            # a classe da foto tem que aparecer: se o detector não achou, fica a melhor caixa de qualquer classe reetiquetada
            if principal and not any(n == principal for n, _, _ in caixas) and len(r.boxes):
                i = int(r.boxes.conf.argmax())
                caixas.append((principal, float(r.boxes.conf[i]), r.boxes.xyxy[i].tolist()))
        linhas, desenho = [], ImageDraw.Draw(img)
        for n, s, (x1, y1, x2, y2) in caixas:
            linhas.append(f'{CLASSES.index(n)} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}')
            desenho.rectangle([x1, y1, x2, y2], outline='red', width=max(3, W // 150))
            desenho.text((x1 + 6, y1 + 6), f'{n} {s:.2f}', fill='red')
        (destino / 'labels' / (nome + '.txt')).write_text('\n'.join(linhas) + ('\n' if linhas else ''))
        img.save(destino / 'revisao' / (nome + '.jpg'), quality=80)
        resumo.append((nome, principal or ('vazia' if vazia else '? (sem classe no nome nem na pasta: revise com atenção)'), [(n, round(s, 2)) for n, s, _ in caixas]))
    for linha in resumo:
        print(*linha)
    return resumo


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
