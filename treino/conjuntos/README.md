# Conjuntos de fotos marcadas

Cada conjunto de fotos tem a sua pasta, a sua versão e a sua lista de classes. **Conjuntos não se misturam** sem uma decisão explícita
(registrada no `conjunto.json` do conjunto novo). O piloto de 29/10 (`fotos_v1`, 33 fotos do `banco_de_fotos.zip`, em `treino/banco/`)
continua disponível só para comparação: ele **não** é a referência da identificação daqui em diante.

## Regra das marcações vermelhas

**Só o objeto DENTRO da marcação vermelha é alvo.** Equipamentos, ferramentas, estruturas e outros objetos fora da marcação são ignorados:
não viram classe, não viram exemplo positivo. A marcação **não** é o objeto: o traço é removido da imagem antes do treino, para o modelo
não aprender "retângulo vermelho = objeto". Quando uma marcação tem mais de um objeto, ou o objeto não é identificável, a foto fica
**pendente** e a dúvida é registrada; nenhuma classe é inventada.

## Estrutura

```
treino/conjuntos/fotos_v2/
  conjunto.json          (git)  versão, regra, classes do conjunto, tabela nome-do-arquivo → classe, divisão treino/val/teste
  revisao_manual.json    (git)  decisões e pendências de quem olhou as fotos (classe, grupo do objeto, ambiguidades)
  marcacoes.json         (git)  gerado: uma entrada por foto (sha256, área da foto, caixa da marcação, qualidade, pendências, situação)
  avaliacoes/*.json      (git)  gerado por avaliar.py: um modelo publicado medido nas fotos do conjunto
  originais/             (fora do git) as fotos como chegaram, intactas
  limpas/                (fora do git) foto recortada da tela branca, sem o traço vermelho (é a que vai para o treino)
  revisao/               (fora do git) a caixa que vai para o rótulo desenhada sobre a foto limpa (verde = pronta, laranja = pendente)
  yolo/                  (fora do git) exportação: images/ e labels/ em train/val/test, data.yaml, classes.txt, divisao.json
```

As fotos ficam **fora do repositório** (que é público): há uma pessoa identificável no conjunto. Elas são entregues num .zip à parte.

## Passo a passo

```bash
pip install numpy pillow opencv-python-headless onnxruntime
python treino/marcacoes.py preparar fotos_v2.zip --conjunto fotos_v2   # extrai marcações, limpa o traço, lista pendências
#   → revise treino/conjuntos/fotos_v2/revisao/*.jpg; resolva pendências editando revisao_manual.json; rode preparar de novo
python treino/marcacoes.py exportar --conjunto fotos_v2               # só fotos sem pendência; divisão por objeto físico
python treino/avaliar.py --conjunto fotos_v2                          # (opcional) mede o modelo publicado nessas fotos
python -m unittest treino/test_marcacoes.py                           # testes da extração (imagens sintéticas)
```

Treinar é uma **etapa separada**, com validação, e só deve acontecer quando houver fotos suficientes por classe (ver "Próximos passos"):

```bash
python treino/treinar.py treino/conjuntos/fotos_v2/yolo --epocas 150   # usa as classes e a divisão do conjunto
```

O `rotulos.json` gerado registra o conjunto (`"conjunto": "fotos_v2 v2.0-..."`); o app mostra isso no painel e grava nos CSVs.
Receber fotos novas **não** melhora o modelo publicado: só um treino validado e publicado muda o que o app reconhece.

## Como a caixa é obtida da marcação

1. Pixels da cor da caneta (RGB 231,25,31 ± 40) em estruturas **finas** (abertura morfológica 25 px): vermelho largo do cenário (vestido,
   faixa do piso, madeira avermelhada) não conta como marcação e não é apagado.
2. Pedaços de traço que se tocam viram uma marcação; pontos soltos (< 1% da imagem) são ignorados.
3. A caixa vai até o meio do traço, recortada à área da foto (as fotos_v2 vêm coladas numa tela branca 1080×1350). Marcação que sai da foto é sinalizada.
4. O traço (± 4 px) é removido por *inpainting* (OpenCV Telea). Pode deixar uma leve mancha: se existirem as fotos originais **sem**
   marcação, prefira-as (mesmo nome de arquivo) e use as marcadas só para as caixas.

Limite: a marcação feita à mão é **folgada** em volta do objeto. Isso basta para dizer esquerda/frente/direita, mas o modelo aprende caixas
um pouco maiores que o objeto. Para caixas justas, ajuste os rótulos exportados no https://www.makesense.ai (formato YOLO).

## fotos_v2 (30/10/2026): situação

27 fotos, 9 tipos de objeto pelos nomes dos arquivos. **14 prontas, 13 pendentes.** Classes propostas a partir das marcações:
`banco, cadeira, caixa, lixeira, manequim, mesa, pessoa, planta`.

| Classe | Fotos | Prontas | Pendências |
|---|---|---|---|
| banco | 2 | 0 | `branco.png` (nome não bate com classe; parece "banco"); `banco_lado.png` (bancos fora da marcação ao fundo) |
| cadeira | 4 | 1 | 2 cadeiras numa marcação (`cadeiras_enfileiradas*`); caixa fora da marcação em 2 fotos |
| caixa | 6 | 3 | pilhas de 3 caixas numa marcação (`pilha_de_caixas*`): caixa por caixa ou a pilha inteira? |
| lixeira | 3 | 3 | — |
| manequim | 4 | 0 | 3 manequins numa marcação; outros manequins fora da marcação em todas as fotos |
| mesa | 2 | 2 | — |
| pessoa | 2 | 2 | — (nome dos arquivos: `humano_*`) |
| planta | 3 | 3 | — |
| ? | 1 | 0 | `objeto_estranho.png`: objeto não identificado com segurança |

Mudanças em relação às classes do modelo publicado (`fotos_v1`): **cadeira** e **pessoa** são novas; **carteira** e **escada** não
aparecem nas fotos_v2. Manter carteira/escada exige decidir se as fotos antigas delas entram no conjunto novo.

Objeto de uma classe-alvo **fora** da marcação (bancos ao fundo, caixas atrás das cadeiras, outros manequins) é um conflito: pela regra
ele não é alvo naquela foto, mas sem rótulo o YOLO aprende que aquilo é "fundo". Essas fotos ficam pendentes até a decisão
(marcar também, cobrir na foto, ou descartar a foto).

Medição do modelo publicado (piloto `fotos_v1`) nestas fotos: `avaliacoes/20261029-piloto.json` (7 de 11 acertos nas fotos prontas com
classe conhecida; nenhuma lixeira reconhecida: duas foram chamadas de "banco" com nota alta e uma não foi detectada; uma caixa
não foi detectada; cadeiras saem como "carteira"; pessoas não são detectadas).
