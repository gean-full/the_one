# VisioIndústria: revisão final, integração do YOLO e fotos_v2 (30/10/2026)

Branch `revisao-yolo-fotos-v2`, a partir de `main` (000dced) do GitHub. O 1º commit da branch (4dbd324) reproduz a entrega de 29/10
(`vs_indus_final.zip`), que nunca chegou ao GitHub; os 2 commits seguintes são desta revisão. **Nada foi enviado ao GitHub** (sem autorização
de push e sem conta do GitHub conectada a esta sessão).

## A. Auditoria: o que foi encontrado

O `main` do GitHub ainda é a versão de 22/10 (um HTML de 89 KB com tudo embutido). As revisões de 27–29/10 (núcleo separado, ciclo de vida,
modelo próprio YOLO, PWA offline) só existem nos pacotes entregues. Sobre essa base, os problemas encontrados foram:

1. **Arquivos citados no pedido que não existem**: não há `capacitor.config.*`, pasta `android/`, nem dependências npm no repositório ou nas entregas. O app é uma PWA estática.
2. **Não existe "API do YOLO" por HTTP.** O YOLO roda dentro do navegador (ONNX Runtime Web). Não há endereço, token nem formato de resposta para conectar (ver C).
3. **Inferências concorrentes possíveis**: quando o watchdog abandonava um ciclo travado, o ciclo seguinte chamava `session.run` de novo enquanto a anterior ainda rodava no Worker.
4. **Origem errada nos registros**: a tarefa de detecção se chamava `coco-ssd` e a decisão registrava `origem: 'coco-ssd'` mesmo com o YOLO da fábrica em uso. Os CSVs não diziam qual modelo/treino gerou cada linha, o que impede comparar antes/depois de um retreino.
5. **Modelo publicado treinado só com as fotos antigas**: medido nas fotos novas, confunde lixeira com banco (nota 0,94–0,99), chama cadeira de "carteira" e não tem a classe pessoa.
6. **Regra de anotação antiga conflita com a nova**: `treino/README.md` mandava marcar "toda ocorrência" das classes; a regra nova manda considerar só o que está dentro da marcação vermelha.
7. **Fotos novas trazem o traço vermelho desenhado**: treinar com elas sem limpar ensinaria o modelo a procurar retângulos vermelhos.
8. **Android WebView** (se o app for empacotado): `speechSynthesis` não existe nele e o app não inicia sem voz.
9. Suíte de testes lenta (~90 s), por usar tempo real nos testes do agendador. Não alterado.

Itens verificados **sem** problema: ciclo de vida da câmera (liberação das trilhas, sessão invalidada no encerramento), validação das
predições (NaN, caixas fora do quadro), watchdog, descarte de resultados velhos (> 1,5 s), CSP/SRI, carga sob demanda do COCO-SSD,
service worker. Não há código morto relevante: o ponto de integração de segmentação/profundidade é intencional e foi mantido.

## B. Alterações e por quê

| Alteração | Justificativa |
|---|---|
| `js/yolo.js`: uma inferência por vez (`modelo_ocupado`) | Evita duas execuções simultâneas no mesmo Worker depois de um ciclo travado; a falha fica visível e conta no painel |
| `js/yolo.js`: códigos `saida_incompativel`, `modelo_liberado`; classe repetida no `rotulos.json` recusada | Falhas distinguíveis nos registros; rótulos de outro treino não trocam nomes de objetos |
| `js/yolo.js`/`app.js`: `conjunto` do `rotulos.json` no painel e nos CSVs (`versao_modelo`, `modelo`), origem real na decisão | Comparar resultados de modelos/conjuntos de fotos diferentes |
| `js/app.js`: tarefa `deteccao` (era `coco-ssd`) | Nome refletia só um dos dois modelos |
| `sw.js` casca v4, `package.json` 0.5.0 | Regra de publicação do projeto |
| CSVs: colunas novas no **fim** | Quem lê as colunas antigas por posição não quebra |

Não alterado de propósito: limiares de confiança, persistência, watchdog, NMS por classe (classes diferentes sobre o mesmo objeto
continuam sendo anunciadas: em caso de dúvida, o obstáculo não some), avisos de limitação, códigos de erro, mecanismos de falha segura.

## C. Integração YOLO

Detalhes em [`docs/INTEGRACAO_YOLO.md`](INTEGRACAO_YOLO.md). Resumo: YOLO11n (Ultralytics) exportado para ONNX, entrada 416×416,
executado pelo ONNX Runtime Web 1.20.1 (WebAssembly, em Worker, cópia local em `vendor/`). O quadro do `<video>` vira um tensor
(letterbox cinza, RGB/255), a saída `[1, 4+nc, N]` é decodificada (limiar 0,3, NMS por classe), as caixas voltam a pixels do vídeo, são
validadas, viram zonas esquerda/frente/direita, passam pela estabilização e geram decisão, fala, bipe e caixas desenhadas.

Os requisitos de "API" foram tratados no que se aplica a uma inferência local: tempo limite (watchdog 15 s + resultado velho > 1,5 s
descartado), uma execução por vez, sem fila de quadros, ritmo ditado pelo aparelho, indicador de estado, registro de falhas e falha segura.
Erros HTTP valem para os **arquivos** do modelo (rótulos/ONNX) e são tratados. **Não há servidor**: integração HTTP não foi feita nem simulada;
o que faltaria para ela (URL, autenticação, formato) está listado no documento. Nenhuma credencial existe no código.

**Testado de verdade**: modelo real no Chromium (câmera falsa alimentada por uma foto **nova**, `caixa_individual` limpa): detecta e fala
"Caixa à frente" (caixa 98% desenhada); modelo real via `onnxruntime-node` (formato de saída × `rotulos.json`); modelo real em Python nas 27 fotos novas (item G).
**Com mock** (identificado nos arquivos de teste): erros HTTP dos rótulos, concorrência, saída incompatível, falha repetida no app.

## D. Imagens e classes

- `treino/marcacoes.py` lê cada foto, acha o traço da caneta (RGB 231,25,31, só estruturas finas: o vestido vermelho, a faixa do piso e a
  madeira avermelhada não contam), transforma a marcação em caixa, remove o traço da imagem, recorta a foto da tela branca e grava
  `marcacoes.json` (sha256, caixa, qualidade, pendências). Só o que está dentro da marcação vira rótulo.
- `fotos_v2` é um conjunto **separado** do piloto (`fotos_v1`), com versão e classes próprias: `banco, cadeira, caixa, lixeira, manequim, mesa, pessoa, planta`
  (todas vindas dos nomes dos arquivos/marcações; nenhuma do cenário). Novas: cadeira, pessoa. Sem fotos novas: carteira, escada.
- **14 fotos prontas, 13 pendentes** (tabela em `treino/conjuntos/README.md`). Pendências registradas, sem inventar classe:
  marcações com vários objetos (pilhas de caixas, 2 cadeiras, 3 manequins), `objeto_estranho.png` (não identificado), `branco.png`
  (nome não bate; parece "banco"), e objetos de classe-alvo fora da marcação (bancos ao fundo, caixas atrás das cadeiras, outros manequins).
- Exportação YOLO só com fotos prontas, divisão por objeto físico (vistas do mesmo objeto nunca ficam em treino e validação ao mesmo tempo).
- As fotos não vão para o git (repositório público, pessoa identificável); vão num .zip à parte.

## E. Arquivos

Criados: `docs/INTEGRACAO_YOLO.md`, `docs/RELATORIO_REVISAO_2026-10-30.md`, `.gitignore`, `testes/integracao-yolo.test.js`,
`testes/conjunto-fotos.test.js`, `treino/marcacoes.py`, `treino/avaliar.py`, `treino/test_marcacoes.py`, `treino/conjuntos/README.md`,
`treino/conjuntos/fotos_v2/{conjunto.json, revisao_manual.json, marcacoes.json, avaliacoes/20261029-piloto.json}`.
Modificados: `js/yolo.js`, `js/app.js`, `js/nucleo.js` (origem na decisão), `modelos/fabrica/rotulos.json` (campo `conjunto`), `sw.js`,
`package.json`, `treino/treinar.py`, `treino/classes.py`, `treino/.gitignore`, `treino/README.md`, `README.md`, `.github/workflows/testes.yml`.
Removidos: nenhum.

## F. Testes executados (resultados reais)

| Comando | Antes | Depois |
|---|---|---|
| `npm test` | 147/147 | **161/161** (com `onnxruntime-node` instalado; sem ele, 160 + 1 pulado) |
| `npm run check` | ok | ok |
| `python3 -m unittest treino/test_marcacoes.py` | — | **8/8** |
| `ATIVOS=… node testes/navegador/verificar.js` (Chromium real) | 26/26 (29/10) | **26/26**, 3 execuções |

Classificação pedida:

| # | Teste | Situação | Como |
|---|---|---|---|
| 1 | Inicialização da aplicação | APROVADO | Chromium real + app com stubs |
| 2 | Carregamento das bibliotecas | APROVADO | Chromium: ONNX Runtime local em worker, COCO-SSD só sob demanda, sem violação de CSP/SRI |
| 3 | Inicialização da câmera | APROVADO (câmera falsa do Chromium) / NÃO EXECUTADO em celular | — |
| 4 | Permissões | APROVADO (simulado: negada, em uso, indisponível) / BLOQUEADO em Android (sem aparelho) | — |
| 5 | Comunicação com o YOLO | APROVADO (local, modelo real) / BLOQUEADO via HTTP (não existe servidor) | Chromium, onnxruntime-node, Python |
| 6 | Respostas válidas | APROVADO | mock + modelo real |
| 7 | Erros HTTP | APROVADO para os arquivos do modelo (mock de `fetch`: 404, 503, JSON inválido) / BLOQUEADO para servidor | — |
| 8 | Tempo limite | APROVADO (watchdog, resultado velho, `modelo_ocupado`) / BLOQUEADO para HTTP | — |
| 9 | Interpretação das classes | APROVADO | rótulos × falas × núcleo |
| 10 | Conversão das coordenadas | APROVADO | letterbox 640×480 → 416 → pixels |
| 11 | Renderização das caixas | APROVADO (captura de tela do Chromium com "caixa 98%") | verificação visual |
| 12 | Acompanhamento de objetos | APROVADO | testes de `atualizarTracks` |
| 13 | Alertas | APROVADO (texto falado registrado, bipe) / NÃO EXECUTADO com voz real | — |
| 14 | Pausa, retomada, encerramento | APROVADO | Chromium + simulação |
| 15 | Exportação de registros | NÃO EXECUTADO (download real); cabeçalhos dos CSVs verificados por teste estático | — |
| 16 | Desempenho sob conexão lenta | NÃO EXECUTADO | o modelo Fábrica não usa rede depois do 1º uso; a 1ª carga lenta não foi medida |
| 17 | Sem conexão | APROVADO | Chromium offline: modelo Fábrica carrega do cache e detecta; COCO-SSD avisa e não finge |

## G. Desempenho (medido)

- Chromium sem interface, contêiner na nuvem, 1 thread, 3 execuções: carga do modelo 1,0–2,6 s; inferência média 153–179 ms, p95
  183–242 ms; ~3,4 análises/s com intervalo 300 ms; 0 erros, 0 expirados. **Não representa celular.**
- Python/CPU deste contêiner, mesmo `.onnx`: 16 ms por foto (só referência).
- Modelo publicado nas fotos_v2 (`treino/avaliar.py`): **7 de 11** acertos nas fotos prontas de classes que ele conhece (caixa 2/3,
  lixeira 0/3, mesa 2/2, planta 3/3); 3 fotos prontas de classe que ele não tem (cadeira, pessoa). Critério: classe certa, nota ≥ 0,3,
  IoU ≥ 0,3 com a marcação. Amostra pequena demais para conclusão estatística.
- Não medido: celular, memória, CPU/GPU, bateria, aquecimento (procedimento em `MEDICAO_E_PWA.md`).

## H. Limitações e pendências

- Sem push: a branch está no pacote (bundle git). Para abrir o PR é preciso conectar o GitHub (https://claude.ai/connect-github).
- 13 fotos pendentes dependem de decisões suas (lista acima). 14 fotos prontas são poucas: não há validação para banco, cadeira, lixeira, manequim, mesa e pessoa.
- A caixa da marcação é folgada em volta do objeto; a remoção do traço deixa manchas leves. Fotos originais sem marcação seriam melhores.
- O modelo publicado continua sendo o piloto `fotos_v1`. Ele não reconhece pessoas: para pessoas, use o COCO-SSD.
- Android/Capacitor inexistente; em WebView falta a voz. Celular real, voz real e conexão lenta não testados.

## I. Próximos passos (quando as fotos novas chegarem)

1. Responder às pendências (vários objetos numa marcação, objetos-alvo fora da marcação, `objeto_estranho`, `branco`) e decidir se carteira/escada continuam.
2. Mandar, por classe, **40–80 fotos** de objetos variados (distâncias, ângulos, luz), com a mesma regra da marcação e, se possível, também as originais sem traço; e fotos sem nenhum objeto.
3. `marcacoes.py preparar` → revisar `revisao/` → `exportar` (o conjunto ganha versão nova, por exemplo `fotos_v3`).
4. Treinar (`treinar.py treino/conjuntos/<conjunto>/yolo`), conferir mAP por classe **no teste** e rodar `avaliar.py` comparando com `avaliacoes/20261029-piloto.json`.
5. Só publicar o modelo novo se ele for melhor nas classes medidas; testar no celular da apresentação (com e sem internet).
