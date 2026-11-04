# Classes do modelo da fábrica. A ORDEM define o índice no YOLO: para um objeto NOVO, acrescente no FIM da lista
# (mudar a ordem invalida todos os rótulos já feitos).
# PROMPTS: descrição em inglês usada pelo YOLOE na pré-anotação automática.
# FALAS: como o app fala o objeto (s/p = singular/plural, g = gênero, prio = 1 baixa, 2 obstáculo, 3 urgente;
#        off = ajuste do limiar de confiança, negativo para objetos que o modelo acerta com nota mais baixa).
#        Vão para modelos/fabrica/rotulos.json: o app aprende o objeto novo sem editar o código JavaScript.
# PREFIXOS: início do nome do arquivo da foto → classe principal da foto (ex.: caixa_frente.jpg).
CLASSES = ['caixa', 'carteira', 'escada', 'lixeira', 'manequim', 'mesa', 'banco', 'planta', 'cadeira', 'pessoa']
PROMPTS = {
    'caixa': 'cardboard box', 'carteira': 'school chair with writing tablet', 'escada': 'step ladder',
    'lixeira': 'trash can', 'manequim': 'mannequin', 'mesa': 'table', 'banco': 'bench', 'planta': 'potted plant', 'cadeira': 'chair', 'pessoa': 'person',
}
FALAS = {
    'caixa': dict(s='caixa', p='caixas', g='f', prio=2, off=0),
    'carteira': dict(s='carteira', p='carteiras', g='f', prio=2, off=-0.15),
    'escada': dict(s='escada', p='escadas', g='f', prio=2, off=0),
    'lixeira': dict(s='lixeira', p='lixeiras', g='f', prio=2, off=0),
    'manequim': dict(s='manequim', p='manequins', g='m', prio=2, off=0),
    'mesa': dict(s='mesa', p='mesas', g='f', prio=2, off=-0.15),
    'banco': dict(s='banco', p='bancos', g='m', prio=2, off=-0.1),
    'planta': dict(s='planta', p='plantas', g='f', prio=1, off=0),
    'cadeira': dict(s='cadeira', p='cadeiras', g='f', prio=2, off=-0.15),
    'pessoa': dict(s='pessoa', p='pessoas', g='f', prio=3, off=0),
}
# Falas de classes que ainda NÃO estão em CLASSES (modelo publicado) mas aparecem em conjuntos novos (ex.: fotos_v2 → cadeira, pessoa).
# Usadas quando se treina a partir de um conjunto exportado por marcacoes.py (que traz a própria lista de classes).
FALAS_EXTRA = {}   # cadeira e pessoa (fotos_v2) entraram em CLASSES no modelo de 03/11/2026 (banco unificado)
PREFIXOS = {'caixa': 'caixa', 'carteira': 'carteira', 'escada': 'escada', 'lixo': 'lixeira', 'lixeira': 'lixeira', 'manequim': 'manequim',
            'multiplos_manequim': 'manequim', 'mesa': 'mesa', 'banco': 'banco', 'planta': 'planta', 'cadeira': 'cadeira', 'humano': 'pessoa', 'vazio': None, 'fundo': None}

assert set(PROMPTS) == set(CLASSES) == set(FALAS), 'toda classe precisa de PROMPTS e FALAS'


def classe_do_arquivo(nome):
    """Classe principal pela convenção de nomes do banco de fotos (ex.: caixa_frente.jpg, multiplos_manequim_lado_1.jpg).
    Fotos 'vazio_*' ou 'fundo_*' não têm objeto: ficam com o rótulo vazio (ensinam o modelo a não inventar obstáculos)."""
    base = nome.lower()
    for p in sorted(PREFIXOS, key=len, reverse=True):
        if base.startswith(p):
            return PREFIXOS[p]
    for c in CLASSES:   # classe nova acrescentada só em CLASSES: o nome da classe já serve de prefixo
        if base.startswith(c):
            return c
    return None


def eh_vazia(nome):
    return nome.lower().startswith(('vazio', 'fundo'))
