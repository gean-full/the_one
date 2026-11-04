"""Mede um modelo ONNX publicado (o mesmo arquivo que o app usa) num conjunto de fotos marcadas, para comparar modelos antes/depois.

  python treino/avaliar.py --conjunto fotos_v2 [--modelo modelos/fabrica/yolo-fabrica.onnx --rotulos modelos/fabrica/rotulos.json]
  → treino/conjuntos/<conjunto>/avaliacoes/<versao do modelo>.json  e um resumo na tela

Mesmo pré-processamento e decodificação do app (js/yolo.js): letterbox cinza 114 no tamanho do modelo, RGB/255, NMS por classe com IoU 0,45.
Acerto = o modelo achou a CLASSE da marcação com nota >= --nota e IoU >= --iou com a caixa da marcação. A marcação é desenhada à mão e é
folgada em volta do objeto, por isso o IoU padrão é 0,3 (não 0,5). Isto NÃO é o mAP do treino: é um teste do arquivo publicado, foto a foto.
Fotos com pendência entram no relatório separadas e não contam no total. Classe que o modelo não conhece aparece como "fora do modelo".
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np

RAIZ = Path(__file__).resolve().parent
APP = RAIZ.parent


def letterbox(img, T):
    from PIL import Image
    W, H = img.size
    e = min(T / W, T / H)
    w, h = round(W * e), round(H * e)
    px, py = (T - w) / 2, (T - h) / 2
    tela = Image.new('RGB', (T, T), (114, 114, 114))
    tela.paste(img.resize((w, h), Image.BILINEAR), (int(px), int(py)))
    x = np.asarray(tela, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    return x, e, int(px), int(py)


def iou(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    i = w * h
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i)


def decodificar(saida, classes, e, px, py, W, H, nota_min=0.3, iou_max=0.45, max_det=20):
    d = saida[0]   # [4 + nc, N]
    nc = d.shape[0] - 4
    notas = d[4:]
    melhor = notas.argmax(0)
    s = notas[melhor, np.arange(d.shape[1])]
    cand = []
    for j in np.nonzero(s > nota_min)[0]:
        cx, cy, w, h = d[:4, j]
        b = [max(0, (cx - w / 2 - px) / e), max(0, (cy - h / 2 - py) / e), min(W, (cx + w / 2 - px) / e), min(H, (cy + h / 2 - py) / e)]
        cand.append((int(melhor[j]), float(s[j]), b))
    cand.sort(key=lambda k: -k[1])
    fica = []
    for c in cand:
        if len(fica) >= max_det:
            break
        if not any(f[0] == c[0] and iou(f[2], c[2]) > iou_max for f in fica):
            fica.append(c)
    return [{'classe': classes[c] if c < nc else f'classe_{c}', 'nota': round(n, 3), 'caixa_px': [round(float(v), 1) for v in b]} for c, n, b in fica]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--conjunto', default='fotos_v2')
    ap.add_argument('--modelo', default=str(APP / 'modelos' / 'fabrica' / 'yolo-fabrica.onnx'))
    ap.add_argument('--rotulos', default=str(APP / 'modelos' / 'fabrica' / 'rotulos.json'))
    ap.add_argument('--nota', type=float, default=0.3, help='nota mínima (o app usa 0,3 na inferência e o limiar da tela depois)')
    ap.add_argument('--iou', type=float, default=0.3)
    a = ap.parse_args()
    import onnxruntime as ort
    from PIL import Image
    pasta = RAIZ / 'conjuntos' / a.conjunto
    man = json.loads((pasta / 'marcacoes.json').read_text(encoding='utf-8'))
    rot = json.loads(Path(a.rotulos).read_text(encoding='utf-8'))
    T, classes = rot['tamanho'], rot['classes']
    sessao = ort.InferenceSession(a.modelo, providers=['CPUExecutionProvider'])
    ent = sessao.get_inputs()[0].name
    fotos, tempos = [], []
    for r in man['fotos']:
        img = Image.open(pasta / 'limpas' / r['imagem_limpa']).convert('RGB')
        x, e, px, py = letterbox(img, T)
        t0 = time.perf_counter()
        y = sessao.run(None, {ent: x})[0]
        tempos.append((time.perf_counter() - t0) * 1000)
        dets = decodificar(y, classes, e, px, py, img.width, img.height, a.nota)
        alvo = r['classe']
        resultado = 'sem_classe' if not alvo else 'fora_do_modelo' if alvo not in classes else 'acerto' if any(
            d['classe'] == alvo and any(iou(d['caixa_px'], m['caixa_px']) >= a.iou for m in r['marcacoes']) for d in dets) else 'erro'
        fotos.append({'arquivo': r['arquivo'], 'classe_marcada': alvo, 'situacao_no_conjunto': r['situacao'], 'resultado': resultado,
                      'deteccoes': dets})
    prontas = [f for f in fotos if f['situacao_no_conjunto'] == 'pronta']
    medidas = [f for f in prontas if f['resultado'] in ('acerto', 'erro')]
    rel = {'modelo': {'arquivo': Path(a.modelo).name, 'versao': rot.get('versao'), 'conjunto_de_treino': rot.get('conjunto'), 'classes': classes},
           'conjunto_avaliado': {'nome': a.conjunto, 'versao': man['versao']}, 'criterio': {'nota_min': a.nota, 'iou_min': a.iou},
           'medido_em': time.strftime('%Y-%m-%dT%H:%M:%S'),
           'resumo': {'fotos_prontas': len(prontas), 'medidas': len(medidas), 'acertos': sum(f['resultado'] == 'acerto' for f in medidas),
                      'fora_do_modelo': sum(f['resultado'] == 'fora_do_modelo' for f in prontas),
                      'inferencia_ms_cpu_python': {'media': round(float(np.mean(tempos)), 1), 'p95': round(float(np.percentile(tempos, 95)), 1)}},
           'fotos': fotos}
    saida = pasta / 'avaliacoes' / f"{rot.get('versao', 'modelo')}.json"
    saida.parent.mkdir(exist_ok=True)
    saida.write_text(json.dumps(rel, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    s = rel['resumo']
    print(f"Modelo {rot.get('versao')} ({rot.get('conjunto', '?')}) no conjunto {a.conjunto}: {s['acertos']}/{s['medidas']} acertos nas fotos prontas"
          f" com classe conhecida; {s['fora_do_modelo']} foto(s) pronta(s) de classe fora do modelo.")
    for f in fotos:
        ach = ', '.join(f"{d['classe']} {d['nota']:.2f}" for d in f['deteccoes'][:4]) or 'nada'
        print(f"  {f['resultado']:15s} {f['arquivo']:34s} marcada: {f['classe_marcada'] or '?':9s} achou: {ach}"
              + ('' if f['situacao_no_conjunto'] == 'pronta' else '   [pendente]'))
    print(f"Inferência (CPU deste computador, Python, não é o celular): média {s['inferencia_ms_cpu_python']['media']} ms. Relatório: {saida}")


if __name__ == '__main__':
    main()
