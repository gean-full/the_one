"""Extrai fotos de vídeos (o jeito mais rápido de juntar dezenas de fotos por objeto).

Uso:  python extrair_quadros.py VIDEO_OU_PASTA PASTA_SAIDA [--por-segundo 2]
O nome do vídeo vira o prefixo das fotos (grave como caixa_1.mp4, manequim_corredor.mp4...), então a classe principal continua no nome.
"""
import argparse
from pathlib import Path

import cv2


def extrair(video, saida, por_segundo=2):
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    passo, i, n = max(1, round(fps / por_segundo)), 0, 0
    while True:
        ok, quadro = cap.read()
        if not ok:
            break
        if i % passo == 0:
            cv2.imwrite(str(saida / f'{video.stem}_q{n:04d}.jpg'), quadro, [cv2.IMWRITE_JPEG_QUALITY, 92])
            n += 1
        i += 1
    cap.release()
    print(video.name, n, 'fotos')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('origem')
    ap.add_argument('saida')
    ap.add_argument('--por-segundo', type=float, default=2)
    a = ap.parse_args()
    origem, saida = Path(a.origem), Path(a.saida)
    saida.mkdir(parents=True, exist_ok=True)
    videos = [origem] if origem.is_file() else sorted(p for p in origem.iterdir() if p.suffix.lower() in ('.mp4', '.mov', '.avi', '.mkv', '.webm'))
    for v in videos:
        extrair(v, saida, a.por_segundo)


if __name__ == '__main__':
    main()
