"""Conjunto de fotos com MARCAÇÕES VERMELHAS → anotações YOLO, com rastreabilidade (fotos_v2 em diante).

Regra do conjunto: só o objeto DENTRO da marcação vermelha é alvo. Tudo fora dela é ignorado (não vira classe nem exemplo positivo).
A marcação é desenhada à mão sobre a foto; ela NÃO é o objeto: é removida da imagem (inpainting) antes de a foto ir para o treino.

  python treino/marcacoes.py preparar FOTOS.zip --conjunto fotos_v2
      → treino/conjuntos/fotos_v2/: originais/ (cópia intacta), limpas/ (foto recortada, sem o traço vermelho),
        revisao/ (caixa proposta desenhada), marcacoes.json (uma entrada por foto, versionada no git)
  python treino/marcacoes.py exportar --conjunto fotos_v2
      → treino/conjuntos/fotos_v2/yolo/: images/ e labels/ em train/val/test + data.yaml, SÓ com fotos sem pendência
  python treino/marcacoes.py resumo --conjunto fotos_v2

Nada aqui treina modelo nem gera imagem artificial. A classe vem da tabela CLASSE_POR_NOME de conjunto.json (nome do arquivo) e as
pendências (marcação com vários objetos, objeto não identificado, nome duvidoso...) vêm de revisao_manual.json: ambos são editados por
uma pessoa. Foto com pendência fica FORA da exportação até a pendência ser resolvida.
"""
import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import time
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
CONJUNTOS = RAIZ / 'conjuntos'
EXTENSOES = ('.png', '.jpg', '.jpeg', '.webp')

# Cor do traço da marcação (medida nas fotos_v2: RGB 231,25,31 no centro do traço, bordas suavizadas).
COR_MARCA = (231, 25, 31)
TOL_COR = 40            # distância máxima por canal para um pixel contar como traço
BORDA_TRACO = 4         # pixels em volta do traço (antisserrilhado) removidos junto no inpainting
LARGURA_MAX_TRACO = 25  # vermelho mais largo que isto não é traço de caneta...
BORRAO_MAX_PX = 4000     # ...exceto um borrão pequeno encostado no traço
JUNTAR_PX = 20          # pedaços de traço a até 20 px da caixa de outro pedaço são a MESMA marcação
AREA_MIN_MARCA = 0.01   # componente vermelho menor que 1% da imagem é ponto solto, não marcação
BRANCO = 245            # fundo da tela onde a foto foi colada (as fotos_v2 vêm numa tela 1080×1350 branca)


def sha256(caminho):
    h = hashlib.sha256()
    with open(caminho, 'rb') as f:
        for bloco in iter(lambda: f.read(1 << 20), b''):
            h.update(bloco)
    return h.hexdigest()


def dhash(img, n=8):
    """Hash de diferença (64 bits) para achar fotos repetidas ou quase iguais."""
    from PIL import Image
    g = img.convert('L').resize((n + 1, n), Image.LANCZOS)
    px = list(g.tobytes())
    bits = 0
    for y in range(n):
        for x in range(n):
            bits = (bits << 1) | (px[y * (n + 1) + x] > px[y * (n + 1) + x + 1])
    return f'{bits:016x}'


def hamming(a, b):
    return bin(int(a, 16) ^ int(b, 16)).count('1')


def mascara_vermelha(rgb, tol):
    import numpy as np
    d = np.abs(rgb.astype(int) - np.array(COR_MARCA)).max(axis=2)
    return d <= tol


def mascara_do_traco(rgb):
    """Só o TRAÇO da marcação: pixels da cor da caneta em estruturas FINAS. Regiões vermelhas largas (vestido, faixa do piso, madeira
    avermelhada) sobrevivem a uma abertura morfológica maior que a espessura do traço e são excluídas: não são marcação."""
    import numpy as np
    import cv2
    cor = mascara_vermelha(rgb, TOL_COR).astype(np.uint8)
    largo = cv2.morphologyEx(cor, cv2.MORPH_OPEN, np.ones((LARGURA_MAX_TRACO, LARGURA_MAX_TRACO), np.uint8))
    fino = (cor > 0) & (largo == 0)
    # Borrão pequeno colado ao traço (a caneta passou duas vezes no mesmo lugar) também é traço; um vermelho grande nunca é.
    perto = cv2.dilate(fino.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    n, rot, stats, _ = cv2.connectedComponentsWithStats(largo, 8)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] <= BORRAO_MAX_PX:
            comp = rot == i
            if (comp & perto).any():
                fino |= comp
    return fino


def area_da_foto(rgb, traco):
    """Retângulo da fotografia dentro da tela branca, sem contar o traço vermelho (que às vezes sai da foto)."""
    import numpy as np
    import cv2
    sem_traco = cv2.dilate(traco.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    conteudo = (rgb.min(axis=2) < BRANCO) & ~sem_traco
    H, W = conteudo.shape
    linhas = np.nonzero(conteudo.sum(1) > 0.25 * W)[0]
    colunas = np.nonzero(conteudo.sum(0) > 0.25 * H)[0]
    if not len(linhas) or not len(colunas):
        return [0, 0, W, H]
    return [int(colunas.min()), int(linhas.min()), int(colunas.max()) + 1, int(linhas.max()) + 1]


def analisar(caminho):
    """Lê uma foto marcada: área da foto, marcações vermelhas (caixas) e pendências AUTOMÁTICAS (geométricas)."""
    import numpy as np
    import cv2
    from PIL import Image
    img = Image.open(caminho).convert('RGB')
    rgb = np.asarray(img)
    traco = mascara_do_traco(rgb)
    foto = area_da_foto(rgb, traco)
    H, W = traco.shape
    # Liga falhas pequenas do traço feito à mão antes de separar os componentes.
    ligado = cv2.dilate(traco.astype(np.uint8), np.ones((7, 7), np.uint8))
    n, rotulos, stats, _ = cv2.connectedComponentsWithStats(ligado, 8)
    marcas, pontos = [], 0
    for i in range(1, n):
        x, y, w, h, _a = stats[i]
        if w * h < AREA_MIN_MARCA * W * H:
            pontos += 1
            continue
        ys, xs = np.nonzero((rotulos == i) & traco)
        if not len(xs):
            continue
        # O traço tem espessura: a caixa vai até o MEIO do traço (metade da espessura mediana para dentro).
        esp = espessura(traco, xs, ys)
        x1, y1, x2, y2 = xs.min() + esp / 2, ys.min() + esp / 2, xs.max() + 1 - esp / 2, ys.max() + 1 - esp / 2
        marcas.append({'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'espessura_traco_px': round(float(esp), 1)})
    marcas = juntar(marcas)
    pend = []
    if not marcas:
        pend.append('nenhuma marcação vermelha encontrada')
    if len(marcas) > 1:
        pend.append(f'{len(marcas)} marcações na mesma foto: confirmar a classe de cada uma')
    fx1, fy1, fx2, fy2 = foto
    caixas = []
    for m in marcas:
        bx1, by1, bx2, by2 = max(m['x1'], fx1), max(m['y1'], fy1), min(m['x2'], fx2), min(m['y2'], fy2)
        saiu = m['x1'] < fx1 - 2 or m['y1'] < fy1 - 2 or m['x2'] > fx2 + 2 or m['y2'] > fy2 + 2
        if bx2 - bx1 < 8 or by2 - by1 < 8:
            pend.append('marcação fora da foto')
            continue
        # Coordenadas no RECORTE da foto (é a imagem que vai para o treino), em pixels.
        caixa = [round(bx1 - fx1, 1), round(by1 - fy1, 1), round(bx2 - fx1, 1), round(by2 - fy1, 1)]
        frac = (caixa[2] - caixa[0]) * (caixa[3] - caixa[1]) / ((fx2 - fx1) * (fy2 - fy1))
        caixas.append({'caixa_px': caixa, 'fracao_da_foto': round(frac, 3), 'marcacao_sai_da_foto': bool(saiu),
                       'espessura_traco_px': m['espessura_traco_px'], 'pedacos_do_traco': m.get('pedacos', 1)})
    # Qualidade da foto (só aviso): nitidez pela variância do laplaciano e brilho médio, medidos no recorte.
    rec = cv2.cvtColor(rgb[fy1:fy2, fx1:fx2], cv2.COLOR_RGB2GRAY)
    nitidez = float(cv2.Laplacian(rec, cv2.CV_64F).var())
    brilho = float(rec.mean())
    return img, foto, caixas, pend, {'pontos_vermelhos_soltos': pontos, 'nitidez_laplaciano': round(nitidez, 1),
                                     'brilho_medio': round(brilho, 1), 'recorte_px': [fx2 - fx1, fy2 - fy1]}


def juntar(marcas):
    """Um traço feito à mão pode sair em pedaços (falha ou borrão no meio): pedaços que se tocam ou se sobrepõem viram uma marcação só.
    Marcações separadas por mais de JUNTAR_PX continuam separadas."""
    marcas = [dict(m) for m in marcas]
    mudou = True
    while mudou:
        mudou = False
        for i in range(len(marcas)):
            for j in range(i + 1, len(marcas)):
                a, b = marcas[i], marcas[j]
                if a['x1'] - JUNTAR_PX <= b['x2'] and b['x1'] - JUNTAR_PX <= a['x2'] and a['y1'] - JUNTAR_PX <= b['y2'] and b['y1'] - JUNTAR_PX <= a['y2']:
                    a.update(x1=min(a['x1'], b['x1']), y1=min(a['y1'], b['y1']), x2=max(a['x2'], b['x2']), y2=max(a['y2'], b['y2']),
                             espessura_traco_px=max(a['espessura_traco_px'], b['espessura_traco_px']), pedacos=a.get('pedacos', 1) + b.get('pedacos', 1))
                    del marcas[j]
                    mudou = True
                    break
            if mudou:
                break
    return marcas


def espessura(traco, xs, ys):
    """Espessura típica do traço: mediana dos trechos contínuos de pixels vermelhos ao longo das linhas da caixa."""
    import numpy as np
    corridas = []
    for y in np.unique(ys)[::5]:
        linha = traco[y, xs.min():xs.max() + 1].astype(np.int8)
        d = np.diff(np.concatenate([[0], linha, [0]]))
        ini, fim = np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]
        corridas += list(fim - ini)
    corridas = [c for c in corridas if c < 60]   # trechos horizontais longos são o lado de cima/baixo da caixa
    return float(np.median(corridas)) if corridas else 8.0


def limpar(img, foto):
    """Remove o traço vermelho (inpainting só sobre o traço) e recorta a foto da tela branca. Não altera o resto da imagem."""
    import numpy as np
    import cv2
    rgb = np.asarray(img)
    k = 2 * BORDA_TRACO + 1
    traco = cv2.dilate(mascara_do_traco(rgb).astype(np.uint8), np.ones((k, k), np.uint8))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    limpo = cv2.inpaint(bgr, traco, 5, cv2.INPAINT_TELEA)
    x1, y1, x2, y2 = foto
    return limpo[y1:y2, x1:x2], int(traco[y1:y2, x1:x2].sum())


def carregar_conjunto(pasta):
    cfg = json.loads((pasta / 'conjunto.json').read_text(encoding='utf-8'))
    manual = pasta / 'revisao_manual.json'
    rev = json.loads(manual.read_text(encoding='utf-8')) if manual.exists() else {}
    return cfg, rev


def classe_por_nome(nome, tabela):
    base = Path(nome).stem.lower()
    for prefixo in sorted(tabela, key=len, reverse=True):
        if base.startswith(prefixo):
            return tabela[prefixo], prefixo
    return None, None


def grupo_do_objeto(nome, sufixos):
    """Mesmo objeto físico fotografado de outro ângulo fica no MESMO grupo: treino e validação nunca dividem um objeto."""
    base = Path(nome).stem.lower()
    for s in sorted(sufixos, key=len, reverse=True):
        if base.endswith(s):
            return base[:-len(s)]
    return base


def preparar(entrada, conjunto):
    import cv2
    from PIL import ImageDraw
    pasta = CONJUNTOS / conjunto
    cfg, rev = carregar_conjunto(pasta)
    for sub in ('originais', 'limpas', 'revisao'):
        (pasta / sub).mkdir(parents=True, exist_ok=True)
    entrada = Path(entrada)
    origem_zip = {'arquivo': entrada.name, 'sha256': sha256(entrada)} if entrada.is_file() else {'pasta': str(entrada)}
    registros, hashes = [], {}
    with tempfile.TemporaryDirectory() as tmp:
        if entrada.suffix.lower() == '.zip':
            with zipfile.ZipFile(entrada) as z:
                z.extractall(tmp)
            raiz = Path(tmp)
        else:
            raiz = entrada
        fotos = sorted(f for f in raiz.rglob('*') if f.suffix.lower() in EXTENSOES and not f.name.startswith('.'))
        for f in fotos:
            h = sha256(f)
            if h in hashes:
                print('repetida (mesmo arquivo):', f.name, '=', hashes[h])
            hashes.setdefault(h, f.name)
            shutil.copy(f, pasta / 'originais' / f.name)
            img, foto, caixas, pend, qual = analisar(f)
            limpo, px_traco = limpar(img, foto)
            nome_limpo = Path(f.name).stem + '.jpg'
            cv2.imwrite(str(pasta / 'limpas' / nome_limpo), limpo, [cv2.IMWRITE_JPEG_QUALITY, 95])
            classe, prefixo = classe_por_nome(f.name, cfg['classe_por_nome'])
            m = rev.get(f.name, {})
            if 'classe' in m:
                classe = m['classe']
            pend = pend + list(m.get('pendencias', []))
            if not classe:
                pend.append('classe não identificada pelo nome do arquivo')
            elif classe not in cfg['classes']:
                pend.append(f'classe "{classe}" fora da lista do conjunto')
            if qual['nitidez_laplaciano'] < cfg.get('nitidez_min', 0):
                pend.append(f'foto possivelmente tremida (nitidez {qual["nitidez_laplaciano"]})')
            from PIL import Image
            limpa = Image.open(pasta / 'limpas' / nome_limpo)
            reg = {'arquivo': f.name, 'sha256': h, 'imagem_limpa': nome_limpo, 'dhash': dhash(limpa),
                   'tamanho_original_px': list(img.size), 'area_da_foto_px': foto,
                   'classe': classe, 'classe_origem': ('revisao_manual' if 'classe' in m else f'nome do arquivo ("{prefixo}")') if classe else None,
                   'grupo_objeto': m.get('grupo') or grupo_do_objeto(f.name, cfg.get('sufixos_de_vista', [])),
                   'marcacoes': caixas, 'pixels_de_traco_removidos': px_traco, 'qualidade': qual,
                   'observacoes': m.get('observacoes', []), 'pendencias': pend,
                   'situacao': 'pendente' if pend else 'pronta'}
            registros.append(reg)
            # Revisão visual: a caixa que irá para o rótulo, desenhada sobre a foto JÁ LIMPA (verde = pronta, laranja = pendente).
            d = ImageDraw.Draw(limpa)
            cor = (40, 200, 90) if not pend else (255, 150, 0)
            for c in caixas:
                d.rectangle(c['caixa_px'], outline=cor, width=4)
            d.rectangle([0, 0, limpa.width, 28], fill=(0, 0, 0))
            d.text((6, 8), f"{classe or '?'} | {reg['situacao']}" + (f" | {pend[0][:70]}" if pend else ''), fill=cor)
            limpa.save(pasta / 'revisao' / nome_limpo, quality=90)
    # Quase repetidas: hash de diferença com até 6 bits diferentes entre fotos LIMPAS.
    for i, a in enumerate(registros):
        for b in registros[i + 1:]:
            if hamming(a['dhash'], b['dhash']) <= 6:
                for x, y in ((a, b), (b, a)):
                    x.setdefault('parecida_com', []).append(y['arquivo'])
                b['pendencias'].append(f'quase igual a {a["arquivo"]}: manter só uma')
                b['situacao'] = 'pendente'
    manifesto = {'conjunto': conjunto, 'versao': cfg['versao'], 'gerado_em': time.strftime('%Y-%m-%dT%H:%M:%S'),
                 'origem': origem_zip, 'regra': cfg['regra'], 'classes': cfg['classes'], 'fotos': registros}
    (pasta / 'marcacoes.json').write_text(json.dumps(manifesto, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    resumo(conjunto)


def separar(registros, frac, semente):
    """Divide por GRUPO de objeto (todas as vistas do mesmo objeto ficam do mesmo lado) e por classe, de forma estável (hash do grupo +
    semente). Cada classe manda primeiro um grupo para o treino; validação só com 2 grupos ou mais e teste só com 4 ou mais.
    Com poucos objetos por classe a validação mede pouco: o resumo da exportação mostra o que ficou sem medição."""
    def posicao(g):
        return int(hashlib.sha256(f'{semente}:{g}'.encode()).hexdigest()[:8], 16)
    grupos_da_classe = defaultdict(set)
    for r in registros:
        grupos_da_classe[r['classe']].add(r['grupo_objeto'])
    parte = {}
    for c in sorted(grupos_da_classe):
        gs = sorted((g for g in grupos_da_classe[c] if g not in parte), key=posicao)
        n = len(gs)
        n_test = max(1, round(n * frac['test'])) if n >= 4 else 0
        n_val = max(1, round(n * frac['val'])) if n >= 2 else 0
        for k, g in enumerate(gs):
            parte[g] = 'train' if k < n - n_val - n_test else 'val' if k < n - n_test else 'test'
    return parte


def exportar(conjunto):
    pasta = CONJUNTOS / conjunto
    cfg, _ = carregar_conjunto(pasta)
    man = json.loads((pasta / 'marcacoes.json').read_text(encoding='utf-8'))
    prontas = [r for r in man['fotos'] if r['situacao'] == 'pronta']
    if not prontas:
        raise SystemExit('Nenhuma foto sem pendência: nada para exportar.')
    destino = pasta / 'yolo'
    shutil.rmtree(destino, ignore_errors=True)
    parte = separar(prontas, cfg['divisao'], cfg.get('semente', 7))
    idx = {c: i for i, c in enumerate(cfg['classes'])}
    cont = defaultdict(Counter)
    for r in prontas:
        p = parte[r['grupo_objeto']]
        for sub in ('images', 'labels'):
            (destino / sub / p).mkdir(parents=True, exist_ok=True)
        shutil.copy(pasta / 'limpas' / r['imagem_limpa'], destino / 'images' / p / r['imagem_limpa'])
        W, H = r['qualidade']['recorte_px']
        linhas = []
        for c in r['marcacoes']:
            x1, y1, x2, y2 = c['caixa_px']
            linhas.append(f"{idx[r['classe']]} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}")
        (destino / 'labels' / p / (Path(r['imagem_limpa']).stem + '.txt')).write_text('\n'.join(linhas) + '\n')
        cont[p][r['classe']] += 1
    (destino / 'data.yaml').write_text(
        f"# {conjunto} {cfg['versao']}: gerado por treino/marcacoes.py exportar. Só fotos sem pendência.\n"
        f"path: {destino}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n" +
        ''.join(f'  {i}: {c}\n' for i, c in enumerate(cfg['classes'])), encoding='utf-8')
    (destino / 'classes.txt').write_text('\n'.join(cfg['classes']) + '\n', encoding='utf-8')
    (destino / 'divisao.json').write_text(json.dumps({'versao': cfg['versao'], 'grupos': parte,
        'fotos_por_parte_e_classe': {p: dict(c) for p, c in cont.items()}}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    for p in ('train', 'val', 'test'):
        print(f'{p:5s}', dict(cont.get(p, {})))
    faltam = [c for c in cfg['classes'] if not any(cont[p][c] for p in ('val', 'test'))]
    if faltam:
        print('Sem foto de validação/teste (o resultado delas não será medido):', ', '.join(faltam))


def resumo(conjunto):
    man = json.loads((CONJUNTOS / conjunto / 'marcacoes.json').read_text(encoding='utf-8'))
    fotos = man['fotos']
    por = Counter(r['classe'] or '?' for r in fotos)
    prontas = Counter(r['classe'] for r in fotos if r['situacao'] == 'pronta')
    print(f"{conjunto} {man['versao']}: {len(fotos)} fotos, {sum(prontas.values())} prontas, {len(fotos) - sum(prontas.values())} pendentes")
    for c in sorted(por):
        print(f'  {c:10s} {por[c]:3d} fotos  {prontas.get(c, 0):3d} prontas')
    for r in fotos:
        if r['pendencias']:
            print(f"  PENDENTE {r['arquivo']}: " + '; '.join(r['pendencias']))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('preparar')
    p.add_argument('entrada')
    for s in (p, sub.add_parser('exportar'), sub.add_parser('resumo')):
        s.add_argument('--conjunto', default='fotos_v2')
    a = ap.parse_args()
    if not (CONJUNTOS / a.conjunto / 'conjunto.json').exists():
        sys.exit(f'Falta {CONJUNTOS / a.conjunto / "conjunto.json"} (classes e tabela nome→classe do conjunto).')
    {'preparar': lambda: preparar(a.entrada, a.conjunto), 'exportar': lambda: exportar(a.conjunto), 'resumo': lambda: resumo(a.conjunto)}[a.cmd]()


if __name__ == '__main__':
    main()
