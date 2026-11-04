# Guia por probabilidade (04/11/2026)

Pedido do Ryan: o sistema deve **sempre** dizer para onde ir, mesmo sem certeza de que o caminho está livre, guiando para a direção com
**menor chance de estar bloqueada**. Se até a menor passar de **90%**, ele pede para o usuário parar e pedir ajuda.

Este é agora o modo **padrão** ("Modo de orientação" → "Guia por probabilidade"). Os modos antigos (Padrão, que exige passagem validada, e
Pista controlada) continuam no seletor, sem mudança.

## Como a chance é calculada (`decidirProbabilidade` em `js/nucleo.js`)

Para cada região (esquerda, frente, direita), uma pontuação de 0 a 100%. **Não é uma probabilidade medida**: são regras fixas, e os números
devem ser ajustados com testes na sala (todos ficam em `PROB`, no mesmo arquivo).

| Evidência | Efeito |
|---|---|
| Nada visto | frente 20%, lados 30% (a câmera vê pior os lados) |
| Heurística de piso por cor (se ligada e válida) | substitui o valor acima: pouco piso visível = chance maior, ponderada pela confiança |
| Lados (esquerda/direita) não confirmados | lados no mínimo 50% |
| Objeto estável na região | 60% + até 35% pelo tamanho na imagem (objeto grande = perto), até 97%; "equipamento" × 0,9; vários do mesmo tipo somam |
| Detecção ainda não confirmada | +40% (do que falta) |
| Possível objeto de baixa confiança | +30% (do que falta) |

As evidências se combinam assim: chance = 1 − (1 − base) × (1 − objeto₁) × (1 − objeto₂)…

**Níveis:** baixa (< 30%), média (30–60%), alta (60–90%), muito alta (> 90%).

## Escolha da direção

1. A região com a menor chance. Em empate, fica a frente.
2. **Estabilidade:** se a direção anterior estiver a menos de 10 pontos da melhor, ela é mantida (não fica alternando).
3. **Setas da parede continuam valendo:** se uma seta foi vista nos últimos 5 s e o lado dela não é mais de 20 pontos pior que o melhor
   (nem passa de 90%), o app guia para o lado da seta.
4. Se **todas** as regiões passam de 90%: "Todas as direções parecem bloqueadas. Pare e peça ajuda." (fala urgente, interrompe a anterior).
5. Sem dados válidos da câmera (falha, quadro velho): continua "Não foi possível avaliar a passagem adequadamente". O app não inventa direção sem imagem.

## Fala

- Primeiro os objetos, depois a direção, o nível e a porcentagem. Nunca diz "livre" nem "seguro":
  - "Caixa à frente. Vá pela esquerda com cuidado, chance de bloqueio média, 30%."
  - "Nenhum obstáculo reconhecido. Siga em frente, chance de bloqueio baixa, 20%."
  - "Caixa à frente, caixa à esquerda e caixa à direita. Vá pela esquerda devagar, com muito cuidado, chance de bloqueio alta, 78%."
- Baixa: só a direção. Média: "com cuidado". Alta: "devagar, com muito cuidado".
- A fala muda quando muda a direção, o nível ou os objetos. Repetições por tempo usam a forma curta, sem a porcentagem.
- Pessoa à frente continua urgente, e a seta continua com a fala própria ("Seta: vire à esquerda.").

## Na tela

- **Barras na base da imagem**: cor pela chance (verde até 30%, amarelo até 60%, laranja até 90%, vermelho acima), a porcentagem e
  **➜** na direção indicada, com contorno branco.
- Painel **Orientação → Chance de bloqueio**: "E 30% · F 96% · D 30% → esquerda (chance média)". Os motivos mostram o que pesou em cada região.

## Verificação

- `npm test`: 186 passaram, 1 pulado, 0 falhas. Novos em `testes/guia-probabilidade.test.js` (7 testes: frente sem objeto, desvio, tamanho do
  objeto, pedir ajuda acima de 90%, estabilidade, seta, lados não confirmados, piso por cor, detecção inválida, app inteiro com o painel).
- Chromium real (câmera falsa): manequim à frente → "Manequim à frente. Vá pela esquerda com cuidado, chance de bloqueio média, 30%.";
  foto da sala → "Caixa à direita. Siga em frente com cuidado, chance de bloqueio média, 43%." e "Seta: vire à esquerda.".
- **Não testado**: celular real, sala real. Os números (20%, 30%, 60% + tamanho...) são pontos de partida, não medidas.
