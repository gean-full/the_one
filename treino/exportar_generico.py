"""Exporta o detector GENÉRICO do app (objetos desconhecidos → "equipamento"): YOLO11n pré-treinado no COCO (80 tipos), em ONNX.

    python treino/exportar_generico.py                 # baixa yolo11n.pt (assets do Ultralytics no GitHub), exporta 256 px
    python treino/exportar_generico.py --tamanho 320   # acha objetos menores/mais longe, ~1,8× mais lento

Gera modelos/generico/yolo-generico.onnx e modelos/generico/rotulos.json (mesmo formato do modelo da fábrica, lido por js/yolo.js).
Não há treino: os pesos são os do COCO. Os nomes falados vêm de js/nucleo.js (fundirGenericos): pessoa, cadeira, banco, planta e mesa
mantêm o nome; o resto vira "equipamento".
"""
import argparse, json, shutil, time
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / 'modelos' / 'generico'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pesos', default='yolo11n.pt')
    ap.add_argument('--tamanho', type=int, default=256)
    a = ap.parse_args()
    from ultralytics import YOLO
    m = YOLO(a.pesos)
    nomes = [m.names[i] for i in range(len(m.names))]
    saida = Path(m.export(format='onnx', imgsz=a.tamanho, opset=17, simplify=True, dynamic=False, nms=False))
    DESTINO.mkdir(parents=True, exist_ok=True)
    shutil.copy(saida, DESTINO / 'yolo-generico.onnx')
    rot = {'tamanho': a.tamanho, 'classes': nomes, 'versao': f'{Path(a.pesos).stem}-coco-{a.tamanho}-{time.strftime("%Y%m%d")}',
           'conjunto': 'COCO 2017 (pesos pré-treinados do Ultralytics, sem fotos da fábrica)',
           'leia': 'Detector genérico: só avisa o que o modelo da fábrica não conhece, como "equipamento". Ver docs/SETAS_E_EQUIPAMENTO.md.'}
    (DESTINO / 'rotulos.json').write_text(json.dumps(rot, ensure_ascii=False, indent=1), encoding='utf-8')
    print('ok:', DESTINO / 'yolo-generico.onnx', (DESTINO / 'yolo-generico.onnx').stat().st_size // 1024, 'KB', rot['versao'])


if __name__ == '__main__':
    main()
