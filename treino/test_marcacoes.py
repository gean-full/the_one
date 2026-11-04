"""Testes da extração das marcações vermelhas (treino/marcacoes.py) com imagens SINTÉTICAS de teste (não são dados de treino).

  python3 -m unittest treino/test_marcacoes.py        (precisa de numpy, pillow e opencv-python-headless)
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import marcacoes  # noqa: E402

VERMELHO = marcacoes.COR_MARCA


def tela(retangulos=(), borrao_vermelho=None, quadrado_largo=None, ponto=None):
    """Tela branca 600×700 com uma 'foto' cinza em (100,150)-(500,550) e traços vermelhos de 10 px."""
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (600, 700), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.rectangle([100, 150, 499, 549], fill=(120, 130, 140))
    d.rectangle([250, 300, 330, 420], fill=(60, 60, 60))          # o "objeto"
    if quadrado_largo:                                            # vermelho largo DENTRO da foto (ex.: vestido): não é traço
        d.rectangle(quadrado_largo, fill=VERMELHO)
    for r in retangulos:
        d.rectangle(r, outline=VERMELHO, width=10)
    if borrao_vermelho:
        d.ellipse(borrao_vermelho, fill=VERMELHO)
    if ponto:
        d.ellipse(ponto, fill=VERMELHO)
    return im


class Marcacoes(unittest.TestCase):
    def analisar(self, im):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / 'x.png'
            im.save(p)
            return marcacoes.analisar(p)

    def test_caixa_vai_ate_o_meio_do_traco_e_em_coordenadas_do_recorte(self):
        _, foto, caixas, pend, _ = self.analisar(tela([(200, 250, 380, 470)]))
        self.assertEqual(foto, [100, 150, 500, 550])
        self.assertEqual(pend, [])
        self.assertEqual(len(caixas), 1)
        x1, y1, x2, y2 = caixas[0]['caixa_px']
        # traço de 200 a 209 → meio em ~205 → 105 no recorte (tolerância de 3 px para a espessura estimada)
        for v, esperado in ((x1, 105), (y1, 105), (x2, 276), (y2, 316)):
            self.assertAlmostEqual(v, esperado, delta=3)
        self.assertFalse(caixas[0]['marcacao_sai_da_foto'])

    def test_marcacao_que_sai_da_foto_e_recortada_e_sinalizada(self):
        _, _, caixas, _, _ = self.analisar(tela([(60, 250, 380, 470)]))
        self.assertEqual(caixas[0]['caixa_px'][0], 0)
        self.assertTrue(caixas[0]['marcacao_sai_da_foto'])

    def test_vermelho_largo_dentro_da_foto_nao_vira_marcacao_nem_e_apagado(self):
        im = tela([(200, 250, 380, 470)], quadrado_largo=(400, 400, 480, 520))
        img, foto, caixas, pend, _ = self.analisar(im)
        self.assertEqual(len(caixas), 1)
        limpo, _ = marcacoes.limpar(img, foto)               # BGR, recortado
        b, g, r = limpo[440 - 150, 440 - 100]
        self.assertGreater(int(r), 200, 'o vermelho largo (objeto) foi apagado')
        self.assertLess(int(g), 60)

    def test_traco_some_da_imagem_limpa(self):
        img, foto, _, _, _ = self.analisar(tela([(200, 250, 380, 470)]))
        limpo, n = marcacoes.limpar(img, foto)
        self.assertGreater(n, 0)
        b, g, r = limpo[360 - 150, 204 - 100]                  # meio do lado esquerdo do traço
        self.assertLess(abs(int(r) - int(g)), 60, 'traço vermelho ainda visível')

    def test_ponto_solto_e_ignorado_e_duas_marcacoes_separadas_sao_pendencia(self):
        _, _, caixas, pend, q = self.analisar(tela([(200, 250, 380, 470)], ponto=(560, 50, 568, 58)))
        self.assertEqual(len(caixas), 1)
        self.assertEqual(q['pontos_vermelhos_soltos'], 1)
        _, _, caixas, pend, _ = self.analisar(tela([(110, 160, 220, 300), (330, 380, 490, 540)]))
        self.assertEqual(len(caixas), 2)
        self.assertTrue(any('2 marcações' in p for p in pend))

    def test_traco_partido_por_borrao_vira_uma_marcacao(self):
        im = tela([(200, 250, 380, 470)], borrao_vermelho=(190, 330, 222, 362))
        _, _, caixas, pend, _ = self.analisar(im)
        self.assertEqual(len(caixas), 1, pend)

    def test_divisao_por_grupo_e_estavel(self):
        regs = [{'classe': 'caixa', 'grupo_objeto': g} for g in ('a', 'b', 'c', 'd', 'e')] + [{'classe': 'mesa', 'grupo_objeto': 'm'}]
        p1 = marcacoes.separar(regs, {'val': .2, 'test': .15}, 7)
        self.assertEqual(p1, marcacoes.separar(list(reversed(regs)), {'val': .2, 'test': .15}, 7))
        self.assertEqual(p1['m'], 'train', 'classe com um só objeto fica no treino')
        self.assertEqual(sorted(p1[g] for g in 'abcde').count('train'), 3)

    def test_grupo_do_objeto_tira_o_sufixo_de_vista(self):
        self.assertEqual(marcacoes.grupo_do_objeto('lixeira_vista_cima.png', ['_lado', '_vista_cima']), 'lixeira')
        self.assertEqual(marcacoes.classe_por_nome('humano_lado.png', {'humano': 'pessoa'}), ('pessoa', 'humano'))
        self.assertEqual(marcacoes.classe_por_nome('branco.png', {'banco': 'banco'}), (None, None))


if __name__ == '__main__':
    unittest.main()
