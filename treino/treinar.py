"""Treina o YOLO nano da fábrica e exporta para o navegador (ONNX + rotulos.json em ../modelos/fabrica/).

Uso:  python treinar.py PASTA_ANOTADA [--epocas 150] [--tamanho 416] [--base yolo11n.pt]
PASTA_ANOTADA tem images/ e labels/ (formato YOLO, mesma ordem de classes de classes.py), como sai de pre_anotar.py depois da revisão,
OU é a exportação de um conjunto marcado (treino/conjuntos/<nome>/yolo, de marcacoes.py exportar): aí valem a lista de classes e a
divisão treino/validação/teste DO CONJUNTO (data.yaml, classes.txt, divisao.json), e o rotulos.json registra de qual conjunto veio.
Usa a placa de vídeo se houver (Google Colab), senão a CPU.
"""
import argparse
import json
import random
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path

from classes import CLASSES, FALAS, FALAS_EXTRA

RAIZ = Path(__file__).resolve().parent
SAIDA_APP = RAIZ.parent / 'modelos' / 'fabrica'


def contar(pasta, classes=CLASSES):
    """Fotos com cada classe e fotos vazias. Detecta rótulo com classe fora da lista (ordem de classes trocada)."""
    fotos, caixas, vazias, erros = Counter(), Counter(), 0, []
    for img in sorted((pasta / 'images').rglob('*.jpg')):
        rot = img.parent.parent.parent / 'labels' / img.parent.name / (img.stem + '.txt') if img.parent.name in ('train', 'val', 'test') \
            else pasta / 'labels' / (img.stem + '.txt')
        ids = [int(l.split()[0]) for l in (rot.read_text().splitlines() if rot.exists() else []) if l.strip()]
        if not ids:
            vazias += 1
        for i in ids:
            if not 0 <= i < len(classes):
                erros.append(f'{rot.name}: classe {i}')
                continue
            caixas[classes[i]] += 1
        for i in set(ids):
            if 0 <= i < len(classes):
                fotos[classes[i]] += 1
    return fotos, caixas, vazias, erros


def separar(pasta, dados, frac_val=0.2, semente=7):
    """Separa treino/validação por classe principal (a 1ª caixa), para toda classe ter foto nos dois lados quando possível."""
    grupos = defaultdict(list)
    for img in sorted((pasta / 'images').glob('*.jpg')):
        rot = pasta / 'labels' / (img.stem + '.txt')
        linhas = rot.read_text().split() if rot.exists() else []
        grupos[linhas[0] if linhas else 'vazia'].append(img)
    rnd = random.Random(semente)
    for parte in ('train', 'val'):
        for sub in ('images', 'labels'):
            d = dados / parte / sub
            shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True)
    for imgs in grupos.values():
        rnd.shuffle(imgs)
        n_val = max(1, round(len(imgs) * frac_val)) if len(imgs) >= 3 else 0
        for i, img in enumerate(imgs):
            parte = 'val' if i < n_val else 'train'
            shutil.copy(img, dados / parte / 'images' / img.name)
            rot = pasta / 'labels' / (img.stem + '.txt')
            if rot.exists():
                shutil.copy(rot, dados / parte / 'labels' / rot.name)
    yaml = dados / 'fabrica.yaml'
    yaml.write_text(f'path: {dados}\ntrain: train/images\nval: val/images\nnames:\n' +
                    ''.join(f'  {i}: {c}\n' for i, c in enumerate(CLASSES)))
    return yaml


def treinar(pasta, epocas=150, tamanho=416, base='yolo11n.pt'):
    import torch
    from ultralytics import YOLO
    pasta = Path(pasta)
    conjunto = None
    if (pasta / 'data.yaml').exists() and (pasta / 'classes.txt').exists():
        # Conjunto exportado por marcacoes.py: classes e divisão próprias (não se mistura com o banco antigo).
        classes = [c for c in (pasta / 'classes.txt').read_text(encoding='utf-8').split('\n') if c]
        div = json.loads((pasta / 'divisao.json').read_text(encoding='utf-8')) if (pasta / 'divisao.json').exists() else {}
        conjunto = f"{pasta.parent.name} {div.get('versao', '')}".strip()
        sem_fala = [c for c in classes if c not in FALAS and c not in FALAS_EXTRA]
        if sem_fala:
            raise SystemExit('Classes sem FALAS em classes.py (como o app fala o objeto): ' + ', '.join(sem_fala))
    else:
        classes = CLASSES
    fotos, caixas, vazias, erros = contar(pasta, classes)
    if erros:
        raise SystemExit('Rótulos com classe inexistente (a ordem de CLASSES mudou?):\n' + '\n'.join(erros[:20]))
    print('Fotos por classe:', dict(fotos), '| fotos vazias:', vazias)
    for c in classes:
        if fotos[c] < 40:
            print(f'  aviso: {c} tem só {fotos[c]} foto(s); o recomendado é 40 a 80')
    dados = RAIZ / 'dados'
    yaml = (pasta / 'data.yaml') if conjunto else separar(pasta, dados)
    disp = 0 if torch.cuda.is_available() else 'cpu'
    modelo = YOLO(base)
    # Aumento de dados forte (cor, escala, recorte, mosaico) e espelhamento horizontal. Sem espelho vertical (o piso fica embaixo).
    modelo.train(data=str(yaml), epochs=epocas, imgsz=tamanho, batch=16 if disp == 0 else 8, device=disp, workers=2, patience=50,
                 project=str(RAIZ / 'execucoes'), name='fabrica', exist_ok=True,
                 hsv_h=0.02, hsv_s=0.6, hsv_v=0.5, degrees=5, translate=0.15, scale=0.6, fliplr=0.5, mosaic=1.0,
                 mixup=0.1, close_mosaic=min(20, max(1, epocas // 5)), plots=True)
    melhor = RAIZ / 'execucoes' / 'fabrica' / 'weights' / 'best.pt'
    metr = YOLO(str(melhor)).val(data=str(yaml), imgsz=tamanho, device=disp, plots=False)
    onnx = YOLO(str(melhor)).export(format='onnx', imgsz=tamanho, opset=12, simplify=True, dynamic=False)
    por_classe = {classes[int(i)]: round(float(v), 3) for i, v in zip(metr.box.ap_class_index, metr.box.ap50)}
    anterior = SAIDA_APP / 'rotulos.json'
    antes = json.loads(anterior.read_text()) if anterior.exists() else {}
    SAIDA_APP.mkdir(parents=True, exist_ok=True)
    # Cópia do modelo que estava no app: se o novo for pior na apresentação, basta copiar de volta (treino/modelo-anterior/ → modelos/fabrica/).
    if (SAIDA_APP / 'yolo-fabrica.onnx').exists():
        bkp = RAIZ / 'modelo-anterior'
        bkp.mkdir(exist_ok=True)
        for f in ('yolo-fabrica.onnx', 'rotulos.json', 'banco_referencia.json'):
            if (SAIDA_APP / f).exists():
                shutil.copy(SAIDA_APP / f, bkp / f)
    # Saídas extras p4/p5 (características): ligam a detecção ao vivo ao banco de fotos (js/banco.js). A detecção não muda.
    from exportar_banco import acrescentar_caracteristicas, gerar_banco
    acrescentar_caracteristicas(onnx, SAIDA_APP / 'yolo-fabrica.onnx')
    falas = {**FALAS_EXTRA, **FALAS}
    rotulos = {'tamanho': tamanho, 'classes': classes, 'versao': time.strftime('%Y%m%d-%H%M'),
               'conjunto': conjunto or 'banco treino/banco (pre_anotar + revisão)',
               'mAP50': round(float(metr.box.map50), 3), 'mAP50_95': round(float(metr.box.map), 3), 'mAP50_por_classe': por_classe,
               'fotos_por_classe': {c: fotos[c] for c in classes}, 'fotos_vazias': vazias, 'epocas': epocas,
               'falas': {c: falas[c] for c in classes}, 'caracteristicas': ['p4', 'p5']}
    anterior.write_text(json.dumps(rotulos, ensure_ascii=False, indent=1) + '\n')
    # Banco de referência: uma assinatura por objeto das fotos de treino, gerada com ESTE modelo (o app recusa banco de outro modelo).
    if (pasta / 'images' / 'train').exists():
        calib = RAIZ / 'conjuntos' / 'banco_unificado' / 'calibracao.json'
        gerar_banco(SAIDA_APP / 'yolo-fabrica.onnx', pasta, anterior, SAIDA_APP / 'banco_referencia.json', calib)
    else:
        print('Aviso: pasta sem images/train: banco de referência NÃO regenerado; o app vai recusar o banco antigo (outro modelo).')
    shutil.copy(melhor, SAIDA_APP.parent.parent / 'treino' / 'ultimo-best.pt')
    print(f"\nModelo {rotulos['versao']} gravado em {SAIDA_APP}")
    print(f"mAP50 {rotulos['mAP50']} (antes: {antes.get('mAP50', '–')})   mAP50-95 {rotulos['mAP50_95']} (antes: {antes.get('mAP50_95', '–')})")
    for c in classes:
        print(f'  {c:10s} fotos {fotos[c]:4d}   mAP50 {por_classe.get(c, "–")}')
    return rotulos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pasta')
    ap.add_argument('--epocas', type=int, default=150)
    ap.add_argument('--tamanho', type=int, default=416)
    ap.add_argument('--base', default='yolo11n.pt')
    a = ap.parse_args()
    treinar(a.pasta, a.epocas, a.tamanho, a.base)


if __name__ == '__main__':
    main()
