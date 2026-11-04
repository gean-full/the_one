# Integração do YOLO no VisioIndústria

Estado em 30/10/2026. Este documento descreve o que **existe e foi testado**, não um plano.

## Resumo: não há "API HTTP" do YOLO; a inferência é local

O YOLO do VisioIndústria **não é um serviço na internet**. É um YOLO11n (Ultralytics) treinado com as fotos do ambiente, exportado para
ONNX e executado **dentro do navegador** pelo ONNX Runtime Web 1.20.1 (WebAssembly, num Web Worker). Não existe servidor, endereço,
token, chave ou formato de resposta HTTP em nenhum arquivo do repositório nem das entregas anteriores, e nenhum foi inventado aqui.

Consequências:

| Item pedido para uma API | Situação real |
|---|---|
| Endereço do serviço | Não há. O modelo é o arquivo `modelos/fabrica/yolo-fabrica.onnx`, servido junto com o app (mesma origem). |
| Autenticação, tokens, chaves | Não há e não são necessários. Nada é enviado para fora do aparelho. Nenhuma credencial no código ou no APK. |
| Formato de envio das imagens | O quadro da câmera nunca sai do aparelho: vira um tensor `float32 [1, 3, 416, 416]` (RGB/255, letterbox cinza 114) entregue ao ONNX Runtime. |
| Formato da resposta | Tensor `[1, 4 + nº de classes, N]` (cx, cy, w, h no espaço 416 + nota por classe), decodificado em `js/yolo.js`. |
| Classes reconhecidas | As de `modelos/fabrica/rotulos.json` (desde 03/11: caixa, carteira, escada, lixeira, manequim, mesa, banco, planta, cadeira, pessoa; pessoa com só 2 fotos; **não** reconhece veículo). Banco de fotos ao vivo: docs/BANCO_DE_FOTOS_NA_CAMERA.md. |
| Sem internet | Funciona depois do 1º uso (o service worker guarda o modelo e o ONNX Runtime). Verificado no Chromium com a rede desligada. |
| Erros HTTP | Aplicam-se aos **arquivos** do modelo: `rotulos.json` com status ≠ 2xx ou JSON inválido recusa a carga com mensagem ("rótulos 404"); `.onnx` ausente falha a criação da sessão → estado "Modelo indisponível". |

Se no futuro o YOLO rodar num servidor (por exemplo, para um modelo maior), faltam informações que **só o responsável pelo servidor tem**:
URL, forma de autenticação, formato do pedido (imagem JPEG? base64? multipart?), formato da resposta, classes, limites de tamanho e de
requisições por segundo. Com isso, a integração entraria como uma nova tarefa do agendador (como a `deteccao`), com `fetch` + `AbortController`
(tempo limite), validação da resposta por `validarPredicoes`, uma requisição por vez e o mesmo tratamento de falha. Nesse caso o app
**deixaria de funcionar sem internet** e isso teria de ser dito na tela. O token nunca poderia ficar no app: precisaria de um backend próprio.

## Caminho de um quadro (o que de fato acontece)

1. **Agendador** (`criarAgendador`, `js/nucleo.js`): uma única cadeia de ciclos. O próximo ciclo só é agendado quando o atual termina, com
   espera `max(30 ms, intervalo − duração do ciclo)`. Não há fila nem acúmulo: quadros atrasados não são processados depois.
2. **Verificação da câmera**: sem imagem → erro `camera_indisponivel`; sem quadro novo desde a última análise (onde o navegador informa,
   `requestVideoFrameCallback`) → ciclo ignorado, e erro `sem_quadros_novos` se passar de 2,5 s.
3. **Captura** (`detect`, `js/yolo.js`): o quadro atual do `<video>` é desenhado com letterbox num canvas 416×416, convertido para
   `float32` NCHW. O instante de captura (`tCaptura`) e o id do quadro acompanham o resultado.
4. **Inferência**: `session.run` no Worker do ONNX Runtime (a página e a voz não travam). **Uma por vez**: se uma inferência anterior ainda
   roda (caso de um ciclo abandonado pelo watchdog), a nova chamada é recusada com o código `modelo_ocupado`, em vez de empilhar execuções.
5. **Decodificação**: maior nota por caixa, limiar 0,3, desfaz o letterbox para pixels do vídeo, recorta na borda, NMS **por classe** (IoU 0,45),
   no máximo 20 caixas. Saída com nº de classes diferente do `rotulos.json` → erro `saida_incompativel`.
   Caixas de classes **diferentes** sobre o mesmo objeto são mantidas de propósito: em caso de dúvida entre duas classes, o obstáculo continua
   sendo anunciado (o custo é falar dois nomes).
6. **Validação** (`validarPredicoes`): nota fora de [0,1], NaN, caixa vazia ou muito fora do quadro invalidam o ciclo inteiro → "análise insuficiente".
7. **Classes → fala**: `CLASSES` do núcleo + as `falas` do `rotulos.json` (`registrarClasses`). Classe sem fala é ignorada e registrada no log.
8. **Zona**: o centro da caixa define esquerda/frente/direita **na imagem**; o limiar por classe (`conf` + `off`) decide se conta como objeto.
9. **Estabilização** (`atualizarTracks`): só vira obstáculo depois de `persist` presenças; some só depois de 3 ausências seguidas.
10. **Decisão e alerta** (`decidirOrientacao`, `planejar`): resultado com mais de 1,5 s desde a captura é "desatualizado" e não orienta.
    A decisão registra a **origem** (`yolo-fabrica@<versão> / <conjunto de fotos>` ou `coco-ssd/<base>`).
11. **Desenho**: caixas no canvas sobreposto ao vídeo (mesmo `object-fit`), com nome e nota; barras de região na base.

## Tempo limite, falhas e estado da conexão (equivalentes locais)

| Requisito | Como está |
|---|---|
| Tempo limite | Watchdog de 15 s por ciclo: ciclo travado é abandonado (`inferencia_expirada`) e o agendador recomeça. Além disso, todo resultado com mais de 1,5 s desde a captura é tratado como desatualizado. |
| Requisições simultâneas | Nunca: uma cadeia de ciclos + recusa `modelo_ocupado` dentro do `js/yolo.js`. |
| Quadros atrasados | Não há fila; resultado de geração antiga (pausa/encerramento durante a inferência) é descartado e contado em "descartados". |
| Frequência | `intervalo` configurável na tela (100–1000 ms, padrão 300 ms); se a inferência demora mais que o intervalo, o próximo ciclo começa 30 ms depois do anterior terminar (o aparelho dita o ritmo). Medido: "acima do intervalo" no painel. |
| Indicador de estado | Selo de estado + painel: estado do modelo, provedor (local/CDN, worker, threads, versão do modelo e conjunto de fotos), última análise ("x s atrás"), erros, expirados. |
| Registro de falhas | Log na tela, contador de falhas, códigos por causa (`errosPorCodigo`) e CSV de desempenho com `codigo_erro` e `versao_modelo`. |
| Falha segura | 3 falhas seguidas → status "Falha", fala "Não foi possível avaliar a passagem. Pare e aguarde." e bipe. Nunca vira "caminho livre". |

## COCO-SSD × YOLO: arquitetura de substituição

Os dois **nunca rodam ao mesmo tempo**. O seletor "Modelo" escolhe um por sessão (travado durante a sessão); trocar libera o anterior
(`dispose`). O TensorFlow.js e o COCO-SSD só são baixados quando escolhidos. Motivo: duas inferências pesadas por quadro dobrariam o
tempo de ciclo no celular, e as classes se sobrepõem (cadeira/banco/mesa/planta) com nomes diferentes.

Papéis: **Fábrica (padrão)** para os objetos do ambiente controlado; **COCO-SSD** quando é preciso reconhecer **pessoas e veículos**
(o modelo da fábrica atual não tem essas classes). O conjunto `fotos_v2` traz a classe **pessoa**: quando um modelo treinado com ele for
publicado, essa lacuna do modelo da fábrica pode ser fechada, desde que a validação mostre que ele detecta pessoas de forma confiável.

## Android / WebView / Capacitor

**Não há projeto Capacitor nem pasta Android** no repositório (`main` no GitHub nem nas entregas de 27–29/10). O app é uma PWA estática.
Se um empacotamento Android for criado, estes pontos precisam ser resolvidos (não foram testados):

- **Voz**: a `speechSynthesis` não existe no Android System WebView. Hoje o app **se recusa a iniciar** sem voz (os avisos não seriam falados).
  Num APK seria preciso um plugin nativo de fala (TTS) ligado à função `falar` de `js/app.js`.
- **Câmera**: `android.permission.CAMERA` no manifesto e o `WebChromeClient.onPermissionRequest` concedendo `RESOURCE_VIDEO_CAPTURE`.
- **WebAssembly/Worker**: o ONNX Runtime precisa servir `.wasm` e `.mjs` com os tipos corretos a partir da origem do app.
- O caminho recomendado continua sendo a PWA instalada pelo Chrome (ver `MEDICAO_E_PWA.md`, seção 4).

## Como verificar

- `npm test`: inclui `testes/integracao-yolo.test.js` (ONNX Runtime **simulado**: letterbox, conversão de coordenadas, erros HTTP dos rótulos,
  uma inferência por vez, saída incompatível, falha segura no app) e um teste com o **modelo real** via `onnxruntime-node`, se instalado
  (`npm i --no-save onnxruntime-node@1.20.1`).
- `ATIVOS=... node testes/navegador/verificar.js`: Chromium real, modelo real, câmera falsa alimentada por uma foto.
- `python treino/avaliar.py --conjunto fotos_v2`: o arquivo `.onnx` publicado foto a foto no conjunto novo (ver `treino/conjuntos/README.md`).
