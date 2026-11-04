# VisioIndústria

Protótipo experimental, no navegador, de **alertas falados de obstáculos** a partir da câmera do celular: um modelo de detecção (por padrão o YOLO próprio da fábrica, ou o COCO-SSD) reconhece os objetos, o app indica se estão à esquerda, à frente ou à direita **na imagem** e fala o aviso em português.

> **Ferramenta complementar.** Não confirma que o caminho está livre, não mede distância, não evita colisões e não substitui bengala, cão-guia, EPI, procedimentos de segurança ou avaliação profissional. Não tem certificação de segurança industrial e não controla máquinas. Ausência de detecção **não** é ausência de obstáculo.

## O que funciona hoje

| Capacidade | Situação |
|---|---|
| Câmera traseira/escolhida, prévia e caixas sobre a imagem | Implementado |
| Detecção com o modelo próprio da fábrica (YOLO11n, ONNX Runtime local, em worker) | Implementado e **padrão**; piloto com 33 fotos antigas (`fotos_v1`), precisão em campo **não validada**. Ver [docs/INTEGRACAO_YOLO.md](docs/INTEGRACAO_YOLO.md) |
| Conjunto de fotos novo com marcações vermelhas (`fotos_v2`) | Preparado (extração das marcações, limpeza do traço, pendências, exportação YOLO); **modelo ainda não retreinado**. Ver [treino/conjuntos/README.md](treino/conjuntos/README.md) |
| Detecção COCO-SSD (modelo Leve ou Preciso, carregado só quando escolhido) | Implementado; precisão em cena industrial **não validada** |
| Avisos falados (pt-BR) com prioridade, sem fila e com intervalo entre repetições | Implementado; voz real só verificável no aparelho |
| Pausar, retomar (descarta evidências antigas), encerrar (libera a câmera) | Implementado e testado com simulação |
| “Possível passagem” pela heurística de cor do piso (modo padrão) | **Experimental**, sem validação em campo |
| Modo pista controlada | **Experimental**: assume disponibilidade, não comprova |
| Segmentação semântica, profundidade, distância em metros, rastreamento | **Não existem** (há só o ponto de integração `registrarSegmentador`) |
| Instalação como app (PWA) | Implementado; o modelo da fábrica funciona **sem internet** depois do 1º uso; o COCO-SSD exige internet (ver abaixo) |

## Como rodar

A câmera só funciona em **contexto seguro** (https ou `localhost`).

```bash
python3 -m http.server 8080      # ou: npm run serve
# abra http://localhost:8080/visioindustria.html
```

No celular, publique por https (por exemplo, GitHub Pages: Settings → Pages → branch `main`, pasta raiz) e abra `https://<usuário>.github.io/<repositório>/`. O `index.html` redireciona para `visioindustria.html`. Não há etapa de build nem backend.

### O que é baixado pela rede

Com o modelo **Fábrica** (padrão), nada vem de fora: o modelo (`modelos/fabrica/`, 10,6 MB) e o ONNX Runtime Web 1.20.1 (`vendor/onnxruntime-web-1.20.1/`, 11,3 MB, licença MIT) vão junto com o app. **Publique as pastas `modelos/` e `vendor/`**; se a `vendor/` faltar, o app baixa o mesmo ONNX Runtime do jsDelivr (mesmo hash SRI). Os itens abaixo só são baixados quando um modelo COCO-SSD é escolhido:

| Arquivo | Origem | Tamanho medido |
|---|---|---|
| TensorFlow.js 4.22.0 (`tf.min.js`) | cdn.jsdelivr.net (SRI sha384) | — |
| COCO-SSD 2.2.3 (`coco-ssd.min.js`) | cdn.jsdelivr.net (SRI sha384) | — |
| Pesos do modelo **Leve** (`ssdlite_mobilenet_v2`) | storage.googleapis.com | 18,6 MB |
| Pesos do modelo **Preciso** (`ssd_mobilenet_v2`) | storage.googleapis.com | 67,8 MB |

Os tamanhos dos pesos foram medidos baixando os arquivos listados no `model.json` de cada modelo em 27/10/2026. Os hashes SRI foram calculados sobre os arquivos dos pacotes publicados no npm, que é de onde o jsDelivr os serve; a equivalência com o que o jsDelivr entrega precisa ser conferida num navegador com acesso ao CDN (se o hash não bater, o navegador recusa o script e a página mostra o aviso “Sem a biblioteca de detecção”).

A política de segurança (CSP, no `<meta>` do HTML) só permite scripts da mesma origem e do jsDelivr, conexões só com a mesma origem e com o Google Storage (pesos do modelo), e proíbe scripts e estilos embutidos. Ela inclui `'unsafe-eval'` porque o TensorFlow.js 4.22 usa `Function()` internamente: sem isso a carga do modelo falha (verificado no Chromium). Se a hospedagem permitir cabeçalhos HTTP, a mesma política pode ir para o cabeçalho `Content-Security-Policy`.

Nenhuma imagem sai do aparelho: a inferência é local e nada é gravado (o app não usa armazenamento local nem envia dados; isso é verificado por teste estático).

## Testes

```bash
npm test          # = node --test testes/*.test.js   (Node 21 ou mais novo; sem dependências)
npm run check     # verificação de sintaxe dos scripts
```

| Arquivo | O que cobre |
|---|---|
| `testes/visioindustria.test.js` | Suíte original: agendador, decisão de orientação, mensagens, estabilização, modo pista, contratos de fonte, app com stubs |
| `testes/nucleo.test.js` | Validação de predições, máquina de estados do ciclo de vida, mensagens de erro, invariantes de segurança |
| `testes/ciclo-de-vida.test.js` | App inteiro com câmera, modelo e voz simulados: início repetido, cancelar durante permissão/carga, permissão negada, câmera perdida, teclado, predições malformadas |
| `testes/pwa-e-publicacao.test.js` | Manifesto, ícones, CSP, referências do HTML, service worker em ambiente falso |
| `testes/yolo.test.js` | Decodificação da saída do YOLO (letterbox, limiar, NMS), rótulos e falas do modelo publicado |
| `testes/integracao-yolo.test.js` | `js/yolo.js` com ONNX Runtime **simulado** (erros HTTP dos rótulos, pré-processamento, coordenadas, uma inferência por vez, saída incompatível) e app inteiro com o modelo Fábrica simulado; teste com o **modelo real** se `onnxruntime-node` estiver instalado |
| `testes/conjunto-fotos.test.js` | Integridade do conjunto `fotos_v2` (regra das marcações, pendências fora da exportação) e rastreabilidade do modelo publicado |
| `treino/test_marcacoes.py` | Extração das marcações vermelhas com imagens sintéticas (`python -m unittest treino/test_marcacoes.py`) |
| `testes/navegador/verificar.js` | **Opcional**, fora do `npm test`: Chromium real (Playwright) com câmera falsa e o modelo real. Instruções no topo do arquivo |

Os testes do `npm test` usam dados **sintéticos** ou modelos **simulados** (mocks identificados no topo de cada arquivo): validam a lógica, não a precisão dos modelos, a câmera física, a voz real nem o desempenho em celular. A suíte leva cerca de 90 s (testes do agendador com tempo real).

## Arquitetura

```
visioindustria.html   marcação, CSP, carregamento dos scripts (sem JS nem CSS embutidos)
css/visioindustria.css
js/nucleo.js          lógica PURA (sem DOM, câmera, voz ou relógio global), testável no Node:
                        CLASSES · agendador de inferência · contrato temporal das fontes · decisão de orientação
                        · texto falado · validação das predições · ciclo de vida (máquina de estados)
js/yolo.js            detector próprio (YOLO em ONNX): carga do ONNX Runtime, pré-processamento, decodificação e NMS; mesma interface do COCO-SSD;
                        uma inferência por vez (código modelo_ocupado)
js/app.js             efeitos colaterais: interface, câmera, carga do modelo, voz, painel; usa window.VisioNucleo
js/pwa.js             registro do service worker
sw.js                 casca do app (rede primeiro, com versão) e modelo da fábrica (guardado no 1º uso, por versão do treino)
modelos/fabrica/      yolo-fabrica.onnx + rotulos.json (classes, versão do treino, métricas, como falar cada objeto)
vendor/               ONNX Runtime Web 1.20.1 (cópia local, sem alterações)
treino/               scripts Python: conjuntos de fotos marcadas (marcacoes.py), avaliação do modelo publicado (avaliar.py), treino
treino/conjuntos/     um conjunto por versão de fotos (fotos_v2: JSON no git, fotos fora do git)
docs/                 INTEGRACAO_YOLO.md (como o YOLO está ligado ao app), relatórios das revisões
manifest.webmanifest, icones/
```

Decisões principais:

- **Ciclo de vida explícito** (`criarCicloDeVida`): `ocioso → solicitando_camera → carregando_modelo → ativo ⇄ pausado`, com `camera_indisponivel` e `modelo_indisponivel`. Cada sessão tem um número; encerrar troca o número, então permissão ou carga do modelo que chegam atrasadas não reativam nada, e a câmera que chegar depois é liberada na hora. Botões e selo de estado derivam desse estado.
- **Uma cadeia de inferência** (`criarAgendador`): nunca há duas inferências ao mesmo tempo; o próximo ciclo só é agendado quando o atual termina; resultados de uma geração pausada/encerrada são descartados; watchdog para inferência travada.
- **Saída do modelo é dado não confiável** (`validarPredicoes`): `score` NaN, caixas com NaN, vazias ou fora do quadro invalidam o resultado do ciclo, que vira “análise insuficiente”.
- **Observação ≠ conclusão** (`decidirOrientacao`): só um objeto detectado e estável vira obstáculo; uma direção só é sugerida com evidência positiva, recente e do mesmo quadro. Dados velhos, incompletos ou com falha resultam em “Não foi possível avaliar… / Pare e aguarde”.
- **Sem framework nem build**: o app continua sendo arquivos estáticos publicáveis no GitHub Pages.

Histórico das etapas anteriores: `docs/historico/` (patches de referência, não fazem parte da execução). Procedimento de medição em celular e análise de PWA/APK: [`MEDICAO_E_PWA.md`](MEDICAO_E_PWA.md).

## PWA: o que funciona offline

O service worker guarda a **casca** (HTML, CSS, JS do app, manifesto e ícones) e, no **primeiro uso do modelo da fábrica**, o modelo e o ONNX Runtime local. Depois disso a página abre e o modelo da fábrica detecta **sem internet** (verificado no Chromium com a rede desligada). Para a apresentação: abra o app uma vez com internet no celular que será usado e toque em *Iniciar assistência*. O COCO-SSD continua exigindo internet (TensorFlow.js e pesos vêm de fora e não são guardados); sem rede, a página avisa.

Ao publicar uma versão nova do app, altere `VERSAO` em `sw.js`. Um modelo retreinado **não** precisa disso: o `rotulos.json` traz a versão do treino e o app pede `yolo-fabrica.onnx?v=<versão>`, então o celular baixa o modelo novo e apaga o antigo sozinho.

## Limitações conhecidas

- Nenhuma medição em aparelho real foi feita (latência, FPS, bateria, aquecimento): ver `MEDICAO_E_PWA.md`.
- O COCO-SSD não reconhece parede, porta, palete, carrinho, degrau ou buraco. O modelo da fábrica reconhece só as classes do treino (não reconhece pessoas).
- O modelo da fábrica publicado foi treinado com as fotos **antigas** (`fotos_v1`). Nas fotos novas (`fotos_v2`) ele acertou 7 de 11 objetos medidos e confundiu lixeira com banco (`treino/conjuntos/fotos_v2/avaliacoes/`). Ele precisa ser retreinado com o conjunto novo, numa etapa própria.
- Não há projeto Android/Capacitor no repositório. Num WebView Android a síntese de voz não existe e o app não inicia (ver `docs/INTEGRACAO_YOLO.md`).
- Limiares (`LIM`) são provisórios e não calibrados em campo.
- Voz, vibração de câmera, rotação do aparelho e interrupções do sistema (chamada, tela bloqueada) precisam de verificação manual no celular.

## Banco de fotos na câmera

O modelo Fábrica foi retreinado com o banco de fotos inteiro (fotos_v1 + fotos_v2, 10 classes, com cadeira e pessoa) e o banco é
consultado ao vivo: cada objeto detectado é comparado com as 104 referências das fotos, o painel mostra a foto mais parecida, o banco
confirma, corrige o nome em caso de dúvida ou recupera objetos que o modelo quase descartou, e dá para **ensinar um objeto pela câmera**.
Detalhes, medições e limites: [`docs/BANCO_DE_FOTOS_NA_CAMERA.md`](docs/BANCO_DE_FOTOS_NA_CAMERA.md).

## Guia por probabilidade (modo padrão)

O app sempre indica uma direção: a de menor **chance de bloqueio** estimada (esquerda, frente ou direita), com o nível e a porcentagem
("Caixa à frente. Vá pela esquerda com cuidado, chance de bloqueio média, 30%."). Se todas passam de 90%, pede para parar e pedir ajuda.
A chance é uma pontuação por regras, não uma medida. Detalhes: [`docs/GUIA_POR_PROBABILIDADE.md`](docs/GUIA_POR_PROBABILIDADE.md).

## Objetos desconhecidos e setas da parede

Um detector genérico (YOLO11n do COCO, `modelos/generico/`) roda junto com o modelo da fábrica e avisa como **"equipamento"** o que a
fábrica não conhece, sem nunca apagar nem renomear um objeto conhecido. As **setas amarelas** da parede são lidas por cor e forma
(`js/setas.js`, sem treino) e faladas uma vez: "Seta: vire à esquerda". Seta não é obstáculo.
Detalhes, medições, leitura da planta da sala e as fotos que faltam: [`docs/SETAS_E_EQUIPAMENTO.md`](docs/SETAS_E_EQUIPAMENTO.md).

## Modelo próprio da fábrica

**Modelo → Fábrica** (padrão) usa um YOLO11 nano treinado com as fotos do ambiente (`modelos/fabrica/`), rodando no navegador com o
ONNX Runtime Web 1.20.1 em WebAssembly, **num Worker** (a página, os botões e a voz não travam durante a análise). A 1ª inferência é feita na carga
(aquecimento), para o 1º ciclo real não sair lento. No Chromium sem interface, em contêiner (30/10/2026, 3 execuções): carga 1,0–2,6 s, inferência média 153–179 ms, p95 183–242 ms (1 thread); celular não medido.
Classes atuais: caixa, carteira, escada, lixeira, manequim, mesa, banco, planta. Ele **não** detecta pessoas nem veículos.

Retreinar com fotos novas são dois comandos (`treino/retreinar.py preparar` e `treinar`), e um objeto novo só precisa ser acrescentado em
`treino/classes.py`: o nome falado vai no `rotulos.json` e o app aprende sem mexer no JavaScript. Passo a passo: [treino/README.md](treino/README.md).
