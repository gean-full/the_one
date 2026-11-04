# Banco de fotos na câmera (03/11/2026)

Até a versão 0.5 o banco de fotos e a câmera eram duas coisas separadas: as fotos serviam só para treinar, e o modelo publicado ainda era
o piloto de 29/10 (só fotos_v1, sem cadeira nem pessoa, confundindo lixeira com banco). Agora as duas funções trabalham juntas, em dois níveis.

## 1. O modelo da câmera aprendeu com o banco inteiro

- `treino/banco_unificado.py` junta as 33 fotos anotadas de fotos_v1 com 26 das 27 fotos_v2 (marcações vermelhas) num só conjunto YOLO,
  com 10 classes: `caixa, carteira, escada, lixeira, manequim, mesa, banco, planta, cadeira, pessoa` (a ordem antiga foi mantida e as
  duas classes novas ficaram no fim).
- As 13 fotos pendentes foram destravadas com **decisões padrão** em `treino/conjuntos/banco_unificado/anotacoes.json` (feitas por Claude
  olhando as fotos; **confira**): uma caixa por objeto nas marcações com vários objetos (mesma regra do fotos_v1), objetos de classe-alvo
  fora da marcação **cobertos de cinza** (nem positivo nem negativo, a regra da marcação continua valendo), `branco.png` = banco,
  `objeto_estranho.png` fora do treino. carteira e escada continuam (só existem nas fotos_v1).
- Validação cruzada em 2 dobras **por objeto físico**: cada foto nova foi avaliada por um modelo que nunca viu aquele objeto. Com as
  mesmas fotos e o mesmo critério do app (nota ≥ limiar da tela 60%, IoU ≥ 0,3, classe certa), nos 36 objetos das fotos novas:

| | certos | nome errado | alarme falso |
|---|---|---|---|
| Modelo publicado antes (piloto fotos_v1) | 15 | 6 | 8 |
| Modelo novo (fotos_v1 + fotos_v2) | 21 | 2 | 3 |
| Modelo novo + banco de referência | **23** | 2 | 3 |
| Só fotos_v2 (dobra A apenas) | 10 de 18 | 0 | 0 (mAP50 0,56 contra 0,70 com as fotos antigas) |

  mAP50 fora da amostra: 0,70 (dobra A) e 0,81 (dobra B). Os 2 nomes errados são as duas fotos de pessoa avaliadas por um modelo sem
  nenhuma foto de pessoa no treino (só há 2 fotos de pessoa, da mesma pessoa). Lixeira só foi medida pelo modelo que não tinha a lixeira nova:
  ela virou "caixa" com nota baixa e não foi anunciada. **Amostra pequena**: é indicação, não estatística.
- O modelo publicado (`20261103-banco-unificado`) foi treinado com todas as 59 fotos (100 épocas, CPU). Ele substitui o piloto; a cópia
  antiga fica em `treino/modelo-anterior/` (fora do git).

## 2. O banco é consultado ao vivo, a cada quadro

`treino/exportar_banco.py` acrescenta ao `.onnx` duas saídas (`p4`, `p5`: características internas do próprio YOLO, a detecção não muda)
e gera `modelos/fabrica/banco_referencia.json`: **104 objetos de 59 fotos**, cada um com uma assinatura (int8, 384 números) e uma miniatura
(fotos de pessoa sem miniatura). No app (`js/banco.js`), cada caixa detectada ganha a mesma assinatura e é comparada com o banco:

| Situação | Quando | Efeito |
|---|---|---|
| confirmado | o objeto mais parecido é da mesma classe | painel mostra a foto do banco e a semelhança; rótulo "· banco ✓" |
| recuperado | nota abaixo do limiar, mas semelhança ≥ 0,9 com objetos da mesma classe | conta como detecção (é anunciado) |
| nome corrigido | banco discorda com folga e o detector estava em dúvida (nota < 0,5) | fala o nome do banco; a caixa continua sendo obstáculo |
| divergente | banco discorda, detector confiante | vale o modelo |

- O banco **nunca** faz um obstáculo sumir: no máximo muda o nome ou faz contar uma caixa que o modelo quase descartou.
- Limiares calibrados com a validação cruzada (`treino/calibrar_banco.js`, mesmo código do app), com a regra de não criar alarme falso:
  `treino/conjuntos/banco_unificado/calibracao.json`. Ganho medido: +2 objetos certos (manequins recuperados), 0 alarme falso a mais.
- Custo: 0,4–0,9 ms por quadro no Chromium (a inferência é ~150–160 ms).
- Seletor **Uso do banco**: Ligado / Só mostrar (compara, não muda os avisos) / Desligado.
- Banco gerado com outro modelo é recusado (as assinaturas dependem dos pesos). Sem o arquivo, a detecção segue só com o modelo.

### Ensinar pela câmera

Botão **Guardar objeto no banco**: a maior caixa do quadro (ou o centro, se nada foi detectado) vira referência nova **neste aparelho**
(IndexedDB) com o nome escolhido, e vale já no quadro seguinte, sem retreinar. Referência ensinada quase idêntica (≥ 0,9) impõe o nome
escolhido. A foto e o rótulo YOLO ficam guardados: **Exportar fotos guardadas (.zip)** gera `images/`, `labels/` e `classes.txt` para
revisar e somar ao banco no próximo treino. **Apagar o que foi ensinado** limpa tudo. Nada é enviado.

## Verificação

- `npm test`: 171 passaram, 1 pulado (onnxruntime-node não instalado), 0 falhas. Novos: `testes/banco.test.js` (12 testes, inclusive o app
  inteiro com o banco real: nome corrigido, "Só mostrar", recuperação).
- `CAMERA=video.y4m node testes/navegador/verificar-banco.js lixeira` (Chromium real, câmera falsa com a foto `lixeira_frente`, sem
  internet): banco carregado, "Parece com lixeira — lixeira_vista_cima · 0,96 · confirmado", fala "Lixeira à frente", ensinar, exportar .zip,
  recarregar mantendo o ensinado, apagar, sem erro de CSP. Com `pilha_de_caixas_lado`: "Três caixas à frente". Essas fotos estão no
  treino do modelo final: isto prova a integração, não a precisão.
- **Não testado**: celular real, câmera física em cena nova, voz real.

## Retreinar (fluxo completo)

```bash
python treino/marcacoes.py preparar fotos_novas.zip --conjunto fotos_v3      # se vierem com marcação vermelha
python treino/banco_unificado.py --v1 BANCO_V1 --v2 treino/conjuntos/fotos_v2 --dobra final --saida treino/conjuntos/banco_unificado/yolo-final
python treino/treinar.py treino/conjuntos/banco_unificado/yolo-final --epocas 100   # publica modelo + rotulos.json + banco_referencia.json
# opcional, para recalibrar: --dobra a / --dobra b, treinar cada uma, exportar_banco.py consultas, node treino/calibrar_banco.js
```
