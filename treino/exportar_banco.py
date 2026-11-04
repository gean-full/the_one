"""Gera o BANCO DE REFERÊNCIA do app a partir das fotos anotadas e do modelo treinado (liga as fotos do banco à câmera ao vivo).

  python treino/exportar_banco.py caracteristicas MODELO.onnx SAIDA.onnx
      → acrescenta ao .onnx as saídas 'p4' e 'p5' (mapas de características do pescoço da rede; a detecção não muda)
  python treino/exportar_banco.py banco MODELO.onnx PASTA_YOLO --rotulos modelos/fabrica/rotulos.json --saida modelos/fabrica/banco_referencia.json
      → uma assinatura por objeto anotado (images/train + labels/train de banco_unificado.py), com miniatura, para o app comparar
  python treino/exportar_banco.py consultas MODELO_DA_DOBRA.onnx PASTA_YOLO_DA_DOBRA --saida consultas.json
      → banco com as fotos de TREINO da dobra + as detecções do modelo nas fotos de VALIDAÇÃO (objetos que ele nunca viu),
        para calibrar os limiares de js/banco.js com treino/calibrar_banco.js

A assinatura é calculada exatamente como em js/banco.js (mediaNaCaixa + assinatura): letterbox cinza 114 para o tamanho da entrada,
média de P4 e de P5 dentro da caixa (no espaço da entrada), cada uma normalizada, concatenadas e normalizadas; quantizada em int8.
Fotos da classe 'pessoa' não ganham miniatura (o repositório é público e a pessoa é identificável); a assinatura não é uma imagem.
"""
import argparse
import base64
import io
import json
import re
import time
from pathlib import Path

import numpy as np

CAMADAS = {'p4': 19, 'p5': 22}      # YOLO11: saídas dos blocos C3k2 do pescoço que alimentam a cabeça (P4/16 e P5/32)
SEM_MINIATURA = {'pessoa'}


def acrescentar_caracteristicas(entrada, saida):
    import onnx
    from onnx import helper
    m = onnx.shape_inference.infer_shapes(onnx.load(entrada))
    g = m.graph
    nomes = {n.name: n for n in g.node}
    formas = {v.name: v.type for v in g.value_info}
    for nome, camada in CAMADAS.items():
        alvo = f'/model.{camada}/cv2/act/Mul'
        if alvo not in nomes:
            raise SystemExit(f'nó {alvo} não encontrado: o modelo não é um YOLO11 exportado pelo Ultralytics?')
        g.node.append(helper.make_node('Identity', [nomes[alvo].output[0]], [nome], name='saida_' + nome))
        dims = [d.dim_value for d in formas[nomes[alvo].output[0]].tensor_type.shape.dim]
        g.output.append(helper.make_tensor_value_info(nome, onnx.TensorProto.FLOAT, dims))
    onnx.checker.check_model(m)
    onnx.save(m, saida)
    return saida


def sessao(caminho):
    import onnxruntime as ort
    s = ort.InferenceSession(str(caminho), providers=['CPUExecutionProvider'])
    nomes = [o.name for o in s.get_outputs()]
    if 'p4' not in nomes or 'p5' not in nomes:
        raise SystemExit('o .onnx não tem as saídas p4/p5: rode antes "exportar_banco.py caracteristicas"')
    return s, nomes


def letterbox(img, T):
    from PIL import Image
    W, H = img.size
    esc = min(T / W, T / H)
    w, h = round(W * esc), round(H * esc)
    px, py = (T - w) / 2, (T - h) / 2
    tela = Image.new('RGB', (T, T), (114, 114, 114))
    tela.paste(img.resize((w, h), Image.BILINEAR), (int(round(px)), int(round(py))))
    x = np.asarray(tela, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    return x, esc, px, py


def media_na_caixa(mapa, caixa, T):
    """Igual a mediaNaCaixa de js/banco.js. mapa [C, Hf, Wf]; caixa [x1,y1,x2,y2] no espaço da entrada."""
    import math
    C, Hf, Wf = mapa.shape
    ex, ey = Wf / T, Hf / T
    x0, y0 = math.floor(caixa[0] * ex), math.floor(caixa[1] * ey)
    x1, y1 = math.ceil(caixa[2] * ex), math.ceil(caixa[3] * ey)
    x0, y0 = min(Wf - 1, max(0, x0)), min(Hf - 1, max(0, y0))
    x1, y1 = min(Wf, max(x0 + 1, x1)), min(Hf, max(y0 + 1, y1))
    v = mapa[:, y0:y1, x0:x1].mean(axis=(1, 2))
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def assinatura(mapas, caixa, T):
    v = np.concatenate([media_na_caixa(m, caixa, T) for m in mapas])
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def codificar(v):
    q = np.clip(np.round(v * 127), -127, 127).astype(np.int8)
    return base64.b64encode(q.tobytes()).decode('ascii')


def miniatura(img, caixa_px):
    from PIL import Image
    x1, y1, x2, y2 = caixa_px
    c = img.crop((int(x1), int(y1), int(x2), int(y2)))
    c.thumbnail((96, 96), Image.BILINEAR)
    b = io.BytesIO()
    c.save(b, 'JPEG', quality=70)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode('ascii')


def rotulos_da_foto(rot):
    saida = []
    for l in (rot.read_text().splitlines() if rot.exists() else []):
        if l.strip():
            i, cx, cy, w, h = l.split()
            saida.append((int(i), float(cx), float(cy), float(w), float(h)))
    return saida


def decodificar(saida, nc, esc, px, py, W, H, nota_min=0.3, iou_max=0.45, max_det=20):
    """Igual a decodificar de js/yolo.js (maior nota por caixa, NMS por classe)."""
    d = saida[0]
    notas = d[4:4 + nc]
    cls = notas.argmax(0)
    sc = notas.max(0)
    cand = []
    for j in np.nonzero(sc > nota_min)[0]:
        cx, cy, w, h = d[0, j], d[1, j], d[2, j], d[3, j]
        b = [max(0, (cx - w / 2 - px) / esc), max(0, (cy - h / 2 - py) / esc), min(W, (cx + w / 2 - px) / esc), min(H, (cy + h / 2 - py) / esc)]
        cand.append((float(sc[j]), int(cls[j]), b))
    cand.sort(key=lambda c: -c[0])
    fica = []
    for c in cand:
        if len(fica) >= max_det:
            break
        if not any(f[1] == c[1] and iou(f[2], c[2]) > iou_max for f in fica):
            fica.append(c)
    return fica


def iou(a, b):
    w, h = min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    i = w * h
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i)


def referencias(s, pasta, parte, classes, T, com_miniatura=True):
    from PIL import Image
    refs, fotos = [], 0
    for img_p in sorted((pasta / 'images' / parte).glob('*.jpg')):
        img = Image.open(img_p).convert('RGB')
        W, H = img.size
        x, esc, px, py = letterbox(img, T)
        out = dict(zip([o.name for o in s.get_outputs()], s.run(None, {s.get_inputs()[0].name: x})))
        mapas = [out['p4'][0], out['p5'][0]]
        fotos += 1
        for i, cx, cy, w, h in rotulos_da_foto(pasta / 'labels' / parte / (img_p.stem + '.txt')):
            caixa_px = [(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H]
            caixa = [caixa_px[0] * esc + px, caixa_px[1] * esc + py, caixa_px[2] * esc + px, caixa_px[3] * esc + py]
            classe = classes[i]
            r = {'classe': classe, 'foto': re.sub(r'^v[12]_', '', img_p.stem),
                 'conjunto': 'fotos_v2' if img_p.stem.startswith('v2_') else 'fotos_v1', 'v': codificar(assinatura(mapas, caixa, T))}
            if com_miniatura and classe not in SEM_MINIATURA:
                r['mini'] = miniatura(img, caixa_px)
            refs.append(r)
    return refs, fotos


def gerar_banco(onnx_p, pasta, rotulos_p, saida_p, limiares_p=None):
    s, _ = sessao(onnx_p)
    rot = json.loads(Path(rotulos_p).read_text(encoding='utf-8'))
    pasta = Path(pasta)
    classes = [c for c in (pasta / 'classes.txt').read_text(encoding='utf-8').split('\n') if c]
    if classes != rot['classes']:
        raise SystemExit('classes da pasta e do rotulos.json diferentes: ' + str(classes) + ' × ' + str(rot['classes']))
    refs, fotos = referencias(s, pasta, 'train', classes, rot['tamanho'])
    meta = {'versao_banco': time.strftime('%Y%m%d-%H%M'), 'versao_modelo': rot['versao'], 'conjunto': rot.get('conjunto', ''),
            'dim': int(len(base64.b64decode(refs[0]['v']))), 'fotos': fotos, 'referencias': refs}
    if limiares_p and Path(limiares_p).exists():
        meta['limiares'] = json.loads(Path(limiares_p).read_text(encoding='utf-8'))['limiares']
    Path(saida_p).write_text(json.dumps(meta, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'{len(refs)} objetos de {fotos} fotos → {saida_p} ({Path(saida_p).stat().st_size // 1024} KB)')


def gerar_consultas(onnx_p, pasta, saida_p):
    """Banco = fotos de treino da dobra; consultas = detecções do modelo da dobra nas fotos de validação, com a classe verdadeira."""
    from PIL import Image
    s, _ = sessao(onnx_p)
    pasta = Path(pasta)
    classes = [c for c in (pasta / 'classes.txt').read_text(encoding='utf-8').split('\n') if c]
    T = s.get_inputs()[0].shape[2]
    refs, fotos = referencias(s, pasta, 'train', classes, T, com_miniatura=False)
    consultas = []
    for img_p in sorted((pasta / 'images' / 'val').glob('*.jpg')):
        img = Image.open(img_p).convert('RGB')
        W, H = img.size
        x, esc, px, py = letterbox(img, T)
        out = dict(zip([o.name for o in s.get_outputs()], s.run(None, {s.get_inputs()[0].name: x})))
        mapas = [out['p4'][0], out['p5'][0]]
        verdade = [(classes[i], [(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H])
                   for i, cx, cy, w, h in rotulos_da_foto(pasta / 'labels' / 'val' / (img_p.stem + '.txt'))]
        for nota, c, b in decodificar(out[s.get_outputs()[0].name], len(classes), esc, px, py, W, H):
            par = max(verdade, key=lambda v: iou(v[1], b), default=None)
            casa = par is not None and iou(par[1], b) >= 0.3
            caixa = [b[0] * esc + px, b[1] * esc + py, b[2] * esc + px, b[3] * esc + py]
            consultas.append({'foto': img_p.stem, 'classe_detector': classes[c], 'nota': round(nota, 4),
                              'classe_verdadeira': par[0] if casa else None, 'v': codificar(assinatura(mapas, caixa, T))})
        consultas.append({'foto': img_p.stem, 'objetos': [v[0] for v in verdade]})
    meta = {'dim': int(len(base64.b64decode(refs[0]['v']))), 'classes': classes, 'referencias': refs, 'consultas': consultas}
    Path(saida_p).write_text(json.dumps(meta, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{len(refs)} referências, {sum(1 for c in consultas if "v" in c)} detecções em {sum(1 for c in consultas if "objetos" in c)} fotos → {saida_p}')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('caracteristicas'); a.add_argument('entrada'); a.add_argument('saida')
    b = sub.add_parser('banco'); b.add_argument('onnx'); b.add_argument('pasta'); b.add_argument('--rotulos', required=True)
    b.add_argument('--saida', required=True); b.add_argument('--limiares')
    c = sub.add_parser('consultas'); c.add_argument('onnx'); c.add_argument('pasta'); c.add_argument('--saida', required=True)
    x = ap.parse_args()
    if x.cmd == 'caracteristicas':
        print(acrescentar_caracteristicas(x.entrada, x.saida))
    elif x.cmd == 'banco':
        gerar_banco(x.onnx, x.pasta, x.rotulos, x.saida, x.limiares)
    else:
        gerar_consultas(x.onnx, x.pasta, x.saida)


if __name__ == '__main__':
    main()
