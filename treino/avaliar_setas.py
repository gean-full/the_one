"""Confere a leitura das setas (js/setas.js) em fotos novas, antes de ir para a sala.

    python treino/avaliar_setas.py FOTOS_SETA_ESQUERDA --esperado esquerda   # também confere as fotos espelhadas (direita)
    python treino/avaliar_setas.py FOTOS_SEM_SETA --esperado nenhuma           # fotos da sala sem seta: não pode achar seta
    (FOTOS = pasta ou .zip com .jpg/.jpeg/.png; tamanho de análise igual ao do app: lado maior 320 px)

Imprime, por foto, a direção lida e as medidas de forma, e no fim certos / erros / perdidas / alarmes falsos.
Precisa de Pillow e do Node (o mesmo código do app faz a leitura).
"""
import argparse, json, subprocess, sys, tempfile, zipfile
from pathlib import Path
from PIL import Image, ImageOps

RAIZ = Path(__file__).resolve().parent.parent
EXT = {'.jpg', '.jpeg', '.png'}


def fotos(origem, tmp):
    p = Path(origem)
    if p.suffix.lower() == '.zip':
        with zipfile.ZipFile(p) as z:
            z.extractall(tmp / 'zip')
        p = tmp / 'zip'
    return sorted(f for f in p.rglob('*') if f.suffix.lower() in EXT and not f.name.startswith('.'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('origem')
    ap.add_argument('--esperado', choices=['esquerda', 'direita', 'nenhuma'], required=True)
    ap.add_argument('--tamanho', type=int, default=320)
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t); idx = []
        espelho = {'esquerda': 'direita', 'direita': 'esquerda', 'nenhuma': 'nenhuma'}
        for f in fotos(a.origem, tmp):
            im = ImageOps.exif_transpose(Image.open(f)).convert('RGB'); im.thumbnail((a.tamanho, a.tamanho))
            for esp in (False, True):
                x = ImageOps.mirror(im) if esp else im
                n = f'{len(idx):04d}.rgb'; (tmp / n).write_bytes(x.tobytes())
                idx.append({'arq': n, 'w': x.size[0], 'h': x.size[1], 'foto': f.name + (' (espelhada)' if esp else ''),
                            'esperado': espelho[a.esperado] if esp else a.esperado})
        if not idx:
            sys.exit('nenhuma foto em ' + a.origem)
        (tmp / 'indice.json').write_text(json.dumps(idx))
        sys.exit(subprocess.call(['node', str(RAIZ / 'treino' / 'avaliar_setas.js'), str(tmp)]))


if __name__ == '__main__':
    main()
