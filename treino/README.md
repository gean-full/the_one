# Treino do modelo da fábrica (YOLO nano)

Modelo próprio para o ambiente controlado, no lugar do COCO-SSD. Roda no navegador (ONNX Runtime Web, WebAssembly), escolhido no app em **Modelo → Fábrica**.
Nada de Teachable Machine: é um YOLO11n treinado com o Ultralytics e exportado para ONNX.

Classes (a ordem importa e precisa bater com `js/nucleo.js`): `caixa, carteira, escada, lixeira, manequim, mesa, banco, planta` (ver `classes.py`).

## Banco unificado e banco de referência (03/11/2026)

O modelo publicado é treinado com `banco_unificado.py` (fotos_v1 + fotos_v2) e o `treinar.py` também gera
`modelos/fabrica/banco_referencia.json` (assinaturas das fotos usadas pelo app ao vivo). Ver `docs/BANCO_DE_FOTOS_NA_CAMERA.md`.

## Fotos com marcações vermelhas (fotos_v2 em diante)

A partir de 30/10/2026 as fotos chegam com **marcações vermelhas** e só o objeto dentro delas é alvo. Esse fluxo é o de
[`conjuntos/README.md`](conjuntos/README.md) (`marcacoes.py preparar → revisão → exportar → treinar.py <conjunto>/yolo`) e substitui a
pré-anotação automática abaixo para esses conjuntos. A regra "toda ocorrência das classes na foto precisa de caixa" (abaixo) vale para o
banco antigo; nos conjuntos marcados, um objeto de classe-alvo fora da marcação deixa a foto **pendente** até uma decisão.

## Retreinar com fotos novas (o caminho normal)

```bash
python3 -m venv venv && . venv/bin/activate
pip install -r treino/requirements.txt          # uma vez (instala o PyTorch: demora)

# 0. (só na 1ª vez neste computador) traga o banco já anotado das 33 fotos do piloto:
python treino/retreinar.py preparar banco_anotado.zip

# 1. junte as fotos/vídeos novos: pasta ou .zip, do jeito que vier do celular
python treino/retreinar.py preparar fotos_novas.zip
#    → pula o que já está no banco, transforma vídeos em fotos (2 por segundo), pré-anota com o YOLOE
#      e mostra quantas fotos cada classe tem

# 2. REVISE as caixas novas em treino/banco/revisao/ (ver "Revisão" abaixo)

# 3. treina, exporta e coloca no app (modelos/fabrica/); o modelo anterior fica em treino/modelo-anterior/
python treino/retreinar.py treinar --epocas 150
```

Depois, publique `modelos/fabrica/yolo-fabrica.onnx` e `modelos/fabrica/rotulos.json`. Não precisa mexer em `sw.js` nem no código: o
`rotulos.json` traz a versão do treino e os celulares baixam o modelo novo sozinhos (e apagam o antigo do cache).

**Como mandar as fotos.** Qualquer uma destas formas funciona (pode misturar):
- uma pasta por objeto: `caixa/`, `manequim/`, `escada/`... e `vazio/` para fotos sem nenhum objeto;
- ou o nome do arquivo começando pelo objeto: `caixa_perto_1.jpg`, `manequim_corredor.mp4`, `vazio_porta.jpg`;
- vídeos curtos andando em volta do objeto rendem dezenas de fotos de uma vez.

**Objeto novo** (ex.: palete): acrescente-o no **fim** de `CLASSES` em `treino/classes.py`, com um `PROMPTS` (descrição em inglês para a
pré-anotação) e um `FALAS` (como o app fala: singular, plural, gênero, prioridade). Não precisa editar o JavaScript: o app lê as falas do
`rotulos.json`. Não mude a ordem das classes já existentes (isso invalidaria os rótulos já feitos; o `treinar` recusa rótulo com classe inexistente).

**Revisão.** Abra `treino/banco/revisao/*.jpg` (as caixas desenhadas em vermelho). Para corrigir, use https://www.makesense.ai: carregue
`treino/banco/images`, importe `treino/banco/labels` + `treino/banco/classes.txt` (formato YOLO), ajuste e exporte de volta para `treino/banco/labels`.

Sem placa de vídeo, o treino roda na CPU (o piloto de 33 fotos levou cerca de 20 minutos em 4 núcleos). Com centenas de fotos, o Google Colab
com GPU é bem mais rápido: os mesmos comandos funcionam lá, e o script usa a GPU sozinho quando ela existe.

`retreinar.py contar` mostra quantas fotos cada classe tem. Os scripts antigos (`extrair_quadros.py`, `pre_anotar.py`, `treinar.py`) continuam
funcionando sozinhos, para quem quiser rodar uma etapa de cada vez.

## Regras para as fotos

- **40 a 80 fotos por classe**, no mínimo. Distâncias variadas (perto, 2 m, 5 m), ângulos e alturas da câmera do celular como o usuário vai segurar.
- Luz diferente (manhã, tarde, luz acesa/apagada), objeto cortado na borda, mais de um objeto na cena.
- **Fotos sem nenhum objeto** (corredor vazio, parede, porta): ensinam o modelo a não inventar obstáculos. Basta deixar o .txt vazio.
- **Toda** ocorrência das classes na foto precisa de caixa, inclusive no fundo. Objeto sem caixa ensina o modelo a ignorá-lo.
- A carteira inclui a prancheta; o manequim inclui o pedestal (é o que bate na pessoa).

## Limites

- O modelo da fábrica **não** detecta pessoas nem veículos (não estavam no treino). Para isso, continue usando o COCO-SSD ou inclua essas classes nas fotos.
- O piloto foi treinado com só 33 fotos (2 a 8 por classe): serve para provar o caminho de ponta a ponta, não para uso real. A métrica medida em fotos do próprio banco (otimista) fica em `modelos/fabrica/rotulos.json`, junto com as fotos por classe.
- O mAP de um treino novo não é diretamente comparável ao do anterior quando o conjunto de validação muda (mais fotos). O teste que vale é no ambiente da apresentação, com o app.
