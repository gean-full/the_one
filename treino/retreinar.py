"""Retreino do modelo da fábrica em dois comandos, juntando fotos novas ao banco que já existe.

  python treino/retreinar.py preparar FOTOS_NOVAS      (pasta ou .zip: fotos, vídeos ou um banco já anotado com images/ e labels/)
  → revise as caixas em treino/banco/revisao/ (ver treino/README.md)
  python treino/retreinar.py treinar [--epocas 150]    (grava modelos/fabrica/yolo-fabrica.onnx e rotulos.json)
  python treino/retreinar.py contar                    (fotos por classe no banco)

Organização aceita das fotos novas: pastas com o nome da classe (caixa/, manequim/, vazio/...) ou nome do arquivo começando
pela classe (caixa_perto_1.jpg). Vídeos viram fotos (2 por segundo). Fotos já presentes no banco são puladas.
"""
import argparse
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classes import CLASSES, classe_do_arquivo, eh_vazia  # noqa: E402

RAIZ = Path(__file__).resolve().parent
BANCO = RAIZ / 'banco'
VIDEOS = ('.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp')


def abrir_entrada(entrada, tmp):
    entrada = Path(entrada)
    if entrada.suffix.lower() == '.zip':
        with zipfile.ZipFile(entrada) as z:
            z.extractall(tmp)
        return tmp
    return entrada


def bancos_prontos(pasta):
    """Pastas que já são um banco anotado (images/ + labels/), como o banco_anotado.zip."""
    return [p.parent for p in pasta.rglob('images') if p.is_dir() and (p.parent / 'labels').is_dir()]


def importar_banco(origem, banco):
    n = 0
    for img in sorted((origem / 'images').glob('*.jpg')):
        if (banco / 'images' / img.name).exists():
            continue
        shutil.copy(img, banco / 'images' / img.name)
        rot = origem / 'labels' / (img.stem + '.txt')
        (banco / 'labels' / rot.name).write_text(rot.read_text() if rot.exists() else '')
        rev = origem / 'revisao' / img.name
        if rev.exists():
            shutil.copy(rev, banco / 'revisao' / img.name)
        n += 1
    print(f'{n} foto(s) anotada(s) importada(s) de {origem}')


def preparar(entrada, banco):
    for sub in ('images', 'labels', 'revisao'):
        (banco / sub).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        pasta = abrir_entrada(entrada, Path(tmp) / 'entrada')
        prontos = bancos_prontos(pasta)
        for b in prontos:
            importar_banco(b, banco)
        videos = [v for v in pasta.rglob('*') if v.suffix.lower() in VIDEOS]
        if videos:
            from extrair_quadros import extrair
            quadros = Path(tmp) / '_quadros'
            for v in videos:   # mantém a pasta da classe: caixa/video1.mp4 → _quadros/caixa/video1_q0000.jpg
                destino = quadros / (v.parent.name if v.parent.name.lower() in CLASSES + ['vazio', 'fundo'] else '')
                destino.mkdir(parents=True, exist_ok=True)
                extrair(v, destino, 2)
        import pre_anotar
        ignorar = {p.resolve() for b in prontos for p in b.rglob('*')}
        soltas = Path(tmp) / '_fotos'
        for f in pasta.rglob('*'):
            if f.suffix.lower() in pre_anotar.EXTENSOES and f.resolve() not in ignorar and '_quadros' not in f.parts:
                rel = f.relative_to(pasta)
                if prontos and rel.parent.name.lower() not in CLASSES + ['vazio', 'fundo'] and not classe_do_arquivo(f.name) and not eh_vazia(f.name):
                    print('ignorada (junto de um banco anotado, sem classe no nome):', rel)
                    continue
                alvo = soltas / (rel.parent.name if rel.parent.name.lower() in CLASSES + ['vazio', 'fundo'] else '') / f.name
                alvo.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(f, alvo)
        for origem in (soltas, Path(tmp) / '_quadros'):
            if origem.exists():
                pre_anotar.main(origem, banco)
    contar(banco)
    print(f'\nAgora revise as caixas: abra {banco / "revisao"} e corrija em https://www.makesense.ai (ver treino/README.md).')
    print('Depois: python treino/retreinar.py treinar')


def contar(banco):
    from treinar import contar as c
    fotos, caixas, vazias, erros = c(banco)
    print(f'\nBanco {banco}: {sum(1 for _ in (banco / "images").glob("*.jpg"))} fotos, {vazias} sem objeto')
    for k in CLASSES:
        print(f'  {k:10s} {fotos[k]:4d} fotos  {caixas[k]:4d} caixas' + ('   (abaixo de 40)' if fotos[k] < 40 else ''))
    for e in erros:
        print('  ERRO', e)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('preparar')
    p.add_argument('entrada')
    t = sub.add_parser('treinar')
    t.add_argument('--epocas', type=int, default=150)
    t.add_argument('--tamanho', type=int, default=416)
    t.add_argument('--base', default='yolo11n.pt')
    sub.add_parser('contar')
    for s in (p, t):
        s.add_argument('--banco', type=Path, default=BANCO)
    a = ap.parse_args()
    banco = getattr(a, 'banco', BANCO)
    if a.cmd == 'preparar':
        preparar(a.entrada, banco)
    elif a.cmd == 'contar':
        contar(banco)
    else:
        from treinar import treinar
        treinar(banco, a.epocas, a.tamanho, a.base)


if __name__ == '__main__':
    main()
