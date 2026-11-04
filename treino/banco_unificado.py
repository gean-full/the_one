"""Banco unificado de fotos da fábrica → conjunto YOLO único para o modelo da câmera (e para o banco de referência do app).

Junta as fotos já anotadas do piloto (fotos_v1, banco_anotado: images/ + labels/ + classes.txt) com as fotos marcadas de fotos_v2
(limpas/ + marcacoes.json, de marcacoes.py preparar), aplicando as decisões de treino/conjuntos/banco_unificado/anotacoes.json
(uma caixa por objeto nas marcações com vários objetos, objetos-alvo fora da marcação cobertos de cinza, fotos excluídas).

  python treino/banco_unificado.py --v1 BANCO_V1 --v2 treino/conjuntos/fotos_v2 --dobra a   → treina com v1 + dobra b, valida na dobra a
  python treino/banco_unificado.py ... --dobra b
  python treino/banco_unificado.py ... --dobra final                                         → tudo no treino (modelo publicado)
  --sem-v1: só fotos_v2 (para comparar).

Saída: treino/conjuntos/banco_unificado/yolo-<dobra>[-sem-v1]/ com images/ e labels/ em train/val, data.yaml, classes.txt, divisao.json.
A validação usa SÓ fotos novas de objetos que o treino não viu (exceto na dobra 'final', em que ela é só referência, dentro da amostra).
"""
import argparse
import json
import shutil
from collections import Counter
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
PASTA = RAIZ / 'conjuntos' / 'banco_unificado'
# Ordem do piloto (índices compatíveis com o modelo publicado) + classes novas das fotos_v2 no fim.
CLASSES = ['caixa', 'carteira', 'escada', 'lixeira', 'manequim', 'mesa', 'banco', 'planta', 'cadeira', 'pessoa']
CINZA = (114, 114, 114)   # mesma cor do letterbox do YOLO


def caixas_v2(foto, decisao, largura, altura):
    """Caixas [(classe, x1, y1, x2, y2) normalizadas] de uma foto de fotos_v2: as da decisão manual ou a da marcação."""
    if decisao.get('objetos'):
        return [tuple(o) for o in decisao['objetos']]
    classe = decisao.get('classe') or foto.get('classe')
    return [(classe, m['caixa_px'][0] / largura, m['caixa_px'][1] / altura, m['caixa_px'][2] / largura, m['caixa_px'][3] / altura)
            for m in foto['marcacoes']]


def linha_yolo(classe, x1, y1, x2, y2):
    x1, y1, x2, y2 = (min(1.0, max(0.0, v)) for v in (x1, y1, x2, y2))
    return f'{CLASSES.index(classe)} {(x1 + x2) / 2:.6f} {(y1 + y2) / 2:.6f} {x2 - x1:.6f} {y2 - y1:.6f}'


def registros_v2(pasta_v2, anot):
    """Uma entrada por foto nova utilizável: {nome, origem, grupo, imagem (PIL), linhas}."""
    from PIL import Image, ImageDraw
    marc = json.loads((pasta_v2 / 'marcacoes.json').read_text(encoding='utf-8'))
    saida, excluidas = [], []
    for foto in marc['fotos']:
        dec = anot['fotos'].get(foto['arquivo'], {})
        if dec.get('excluir'):
            excluidas.append((foto['arquivo'], dec['excluir']))
            continue
        img = Image.open(pasta_v2 / 'limpas' / foto['imagem_limpa']).convert('RGB')
        W, H = img.size
        for x1, y1, x2, y2 in dec.get('cobrir', []):
            ImageDraw.Draw(img).rectangle([x1 * W, y1 * H, x2 * W, y2 * H], fill=CINZA)
        caixas = caixas_v2(foto, dec, W, H)
        if any(c[0] not in CLASSES for c in caixas):
            excluidas.append((foto['arquivo'], 'classe fora da lista: ' + ', '.join(str(c[0]) for c in caixas)))
            continue
        saida.append({'nome': 'v2_' + Path(foto['imagem_limpa']).stem, 'origem': 'fotos_v2', 'grupo': foto['grupo_objeto'],
                      'imagem': img, 'linhas': [linha_yolo(*c) for c in caixas]})
    return saida, excluidas


def registros_v1(pasta_v1):
    from PIL import Image
    classes_v1 = [c for c in (pasta_v1 / 'classes.txt').read_text(encoding='utf-8').split('\n') if c]
    saida = []
    for img in sorted((pasta_v1 / 'images').glob('*.jpg')):
        rot = pasta_v1 / 'labels' / (img.stem + '.txt')
        linhas = []
        for l in (rot.read_text().splitlines() if rot.exists() else []):
            if not l.strip():
                continue
            i, *resto = l.split()
            linhas.append(' '.join([str(CLASSES.index(classes_v1[int(i)]))] + resto))
        saida.append({'nome': 'v1_' + img.stem, 'origem': 'fotos_v1', 'grupo': 'v1', 'caminho': img, 'imagem': None, 'linhas': linhas})
    return saida


def montar(v1, v2, dobra, sem_v1=False, saida=None):
    anot = json.loads((PASTA / 'anotacoes.json').read_text(encoding='utf-8'))
    novos, excluidas = registros_v2(Path(v2), anot)
    antigos = [] if sem_v1 or not v1 else registros_v1(Path(v1))
    grupos_val = set(anot['dobras'][dobra]) if dobra in ('a', 'b') else None
    destino = Path(saida) if saida else PASTA / ('yolo-' + dobra + ('-sem-v1' if sem_v1 else ''))
    shutil.rmtree(destino, ignore_errors=True)
    for parte in ('train', 'val'):
        for sub in ('images', 'labels'):
            (destino / sub / parte).mkdir(parents=True)
    contagem = {'train': Counter(), 'val': Counter()}
    divisao = {}

    def gravar(r, parte):
        alvo = destino / 'images' / parte / (r['nome'] + '.jpg')
        if r['imagem'] is not None:
            r['imagem'].save(alvo, quality=92)
        else:
            shutil.copy(r['caminho'], alvo)
        (destino / 'labels' / parte / (r['nome'] + '.txt')).write_text('\n'.join(r['linhas']) + ('\n' if r['linhas'] else ''))
        for l in r['linhas']:
            contagem[parte][CLASSES[int(l.split()[0])]] += 1
        divisao.setdefault(parte, []).append(r['nome'])

    for r in antigos:
        gravar(r, 'train')
    for r in novos:
        if grupos_val is None:
            gravar(r, 'train')
            gravar(r, 'val')        # dobra final: validação só de referência (dentro da amostra)
        else:
            gravar(r, 'val' if r['grupo'] in grupos_val else 'train')
    (destino / 'classes.txt').write_text('\n'.join(CLASSES) + '\n', encoding='utf-8')
    (destino / 'data.yaml').write_text(f'path: {destino}\ntrain: images/train\nval: images/val\nnames:\n' +
                                       ''.join(f'  {i}: {c}\n' for i, c in enumerate(CLASSES)), encoding='utf-8')
    info = {'versao': 'banco-unificado-20261103-' + dobra + ('-sem-v1' if sem_v1 else ''), 'dobra': dobra, 'com_v1': not sem_v1,
            'validacao_fora_da_amostra': grupos_val is not None, 'caixas_por_parte_e_classe': {p: dict(c) for p, c in contagem.items()},
            'fotos': divisao, 'excluidas': excluidas}
    (destino / 'divisao.json').write_text(json.dumps(info, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return destino, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--v1', help='pasta do banco fotos_v1 anotado (images/, labels/, classes.txt)')
    ap.add_argument('--v2', default=str(RAIZ / 'conjuntos' / 'fotos_v2'))
    ap.add_argument('--dobra', choices=['a', 'b', 'final'], default='final')
    ap.add_argument('--sem-v1', action='store_true')
    ap.add_argument('--saida')
    a = ap.parse_args()
    destino, info = montar(a.v1, a.v2, a.dobra, a.sem_v1, a.saida)
    print(destino)
    print(json.dumps({k: info[k] for k in ('versao', 'caixas_por_parte_e_classe', 'excluidas')}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
