# Objetos desconhecidos ("Equipamento") e setas da parede (04/11/2026)

Duas leituras novas rodam junto com o modelo da fábrica (10 classes) e o banco de fotos. Nenhuma das duas muda o que já existia:
as 10 classes, o banco e os avisos de obstáculo continuam como antes.

## 1. Objetos desconhecidos → "Equipamento"

- Um **segundo detector, genérico**, roda no mesmo ONNX Runtime local: YOLO11n pré-treinado no COCO (80 tipos de objeto), entrada 256 px,
  `modelos/generico/` (10 MB, guardado pelo service worker no 1º uso, funciona sem internet depois). Gerado por `treino/exportar_generico.py`.
- O que ele acha passa por `fundirGenericos` (`js/nucleo.js`):
  - se a caixa cai sobre um objeto que a fábrica já anuncia (IoU ≥ 0,3, ou ≥ 60% da caixa genérica dentro dele), ela é **descartada**:
    quem fala é o modelo da fábrica. Assim o manequim não vira "pessoa", a caixa não vira "mala" e nada é contado duas vezes;
  - caixa sobre uma **seta** é descartada (o COCO chama a seta amarela de "pipa": não é obstáculo);
  - pessoa, cadeira, banco, planta e mesa mantêm o nome; veículos também; **todo o resto vira "equipamento"**;
  - caixas pequenas (< 2% da imagem) ou com nota < 0,5 são descartadas; duas caixas genéricas na mesma coisa viram uma só.
- Na fala, "equipamento" tem prioridade 1: ele aparece ("Equipamento à frente", "Dois equipamentos à direita") e bloqueia a região
  como qualquer obstáculo, mas **nunca tira uma classe conhecida da fala** (com 4 grupos conhecidos, os equipamentos viram "e mais N objetos").
- Na imagem: caixa **azul tracejada** com "· genérico" (pessoa genérica continua vermelha).
- Seletor **Objetos desconhecidos**: Ligado econômico (padrão: genérico a cada 2 quadros, o outro reaproveita o resultado anterior se tiver
  menos de 0,8 s) / Ligado em todo quadro / Desligado. Se o arquivo não carregar, o app segue só com a fábrica e diz isso no painel.

**Limite honesto:** o genérico só acha o que se parece com um dos 80 tipos do COCO (pessoa, cadeira, mesa, TV/monitor, notebook, geladeira,
forno, mala, mochila, garrafa, vaso, veículos...). Uma máquina que não lembra nenhum deles pode passar sem aviso. Ele não substitui uma foto
no banco: objeto que vai estar na sala deve continuar entrando no treino.

### Custo e alarme falso (medidos)

| | inferência | ciclo médio |
|---|---|---|
| Só a fábrica (Chromium deste ambiente, 1 thread) | ~230–300 ms | ~230–300 ms |
| + genérico 320 px em todo quadro | +~190 ms | +~65% |
| + genérico 256 px em todo quadro | +~110 ms | +~35% |
| + genérico 256 px econômico (padrão) | +~110 ms a cada 2 | +~15–20% |

Nas 59 fotos do banco (todas as caixas marcadas contam como "conhecido"), o genérico 256 px deixou **3 caixas novas, todas objetos reais**
que não estavam marcados (duas pessoas ao fundo e uma cadeira). Nenhuma alucinação. Com 320 px apareceu também uma garrafa sobre a mesa.
No vídeo de teste com o manequim, as 26 caixas genéricas que o COCO viu sobre ele ("pessoa") foram todas descartadas. Amostra pequena e
de fotos de objetos conhecidos: o alarme falso real só se mede na sala.

## 2. Setas na parede

- `js/setas.js`, **sem treino**: cópia do quadro com lado maior 320 px (1–3 ms), máscara de amarelo saturado, manchas, e regras de forma:
  proporção e preenchimento de seta, cabeça (a metade mais alta) ≥ 1,45× a haste, bico fino na ponta, **contorno preto** em volta e amarelo de
  impressão (saturação média ≥ 0,7). A direção sai da forma: a cabeça aponta para onde virar.
- Por que não YOLO: são 13 fotos de **uma** seta; e o YOLO espelha as fotos no treino por padrão, o que ensinaria "esquerda" e "direita" como
  a mesma coisa. Aqui a regra é simétrica por construção: espelhar a imagem inverte a resposta (conferido nas 13 fotos espelhadas).
- Câmera frontal / imagem espelhada: a direção passa pela mesma inversão de lados do resto do app (seletor "Lados").
- Fala: **"Seta: vire à esquerda."** depois de 2 quadros seguidos com a mesma direção, **uma vez por seta**. Fala de novo se a direção mudar ou
  se a seta sumir por 6 s. Não interrompe aviso de obstáculo: se a voz está ocupada, tenta nos próximos ciclos (até 3 s). Bipe curto grave.
- A seta **não é obstáculo**: não ocupa região nem muda a decisão de passagem.
- Seletor **Setas na parede**: Ligado / Desligado.

### Validação

- 13 fotos do Ryan (todas "esquerda"): 13 certas; as mesmas espelhadas: 13 "direita". Com cada foto reduzida até a seta ter ~18 px de largura
  na cópia de análise, ainda acerta; abaixo de ~16 px ela some (nunca troca a direção).
- 0 seta achada nas 59 fotos do banco nem nas fotos_v2 (com e sem espelho), nem em formas parecidas desenhadas (placa, triângulo de alerta,
  triângulo sem haste, seta para cima, losango, seta sem contorno, amarelo desbotado).
- Distância (estimada, não medida): com ~65° de campo de visão, a seta precisa ocupar ~6% da largura da imagem. **Seta de 30 cm: até ~4 m;
  seta de 40 cm (A3 deitada): até ~5,5 m.**

## 3. A sala (planta provável) e os avisos

Leitura da planta (confirmar): entrada embaixo à esquerda (azul), móveis e objetos em vermelho, uma ilha em "U" no meio, e duas marcas amarelas
no alto (canto esquerdo e lado direito da parede de cima), que entendi como os lugares das setas. O percurso provável é: entrar, subir pelo
corredor da esquerda, virar à direita na parede de cima, seguir até o canto direito e virar à direita de novo, descendo pelo corredor da direita.

- Cada seta deve ficar **na parede de frente para quem chega**, na altura do celular (1,0 a 1,5 m), sem nada na frente. A seta para a direita
  pode ser **a mesma seta girada** (a forma é simétrica em cima/baixo, então girar equivale a espelhar).
- Ao subir o corredor da esquerda, a câmera vê a seta de cima de longe: o app fala "Seta: vire à direita" uma vez, e os avisos de obstáculo
  ("Caixa à esquerda", "Equipamento à frente") continuam normalmente até a curva.
- O corredor da esquerda tem objetos colados na parede e a ilha do outro lado: com a região do meio livre e as laterais ocupadas, a fala
  continua sendo a de sempre ("Obstáculos nas laterais...").

## 4. Fotos que faltam (para validar na sala)

1. **Cada seta no lugar final**, um vídeo curto andando em direção a ela de ~6 m até 1 m, com o celular na altura do peito, com a luz da
   apresentação (projetor ligado e desligado). Um vídeo por seta.
2. **10 fotos da sala sem setas**, de todos os lados (para conferir que nada amarelo vira seta).
3. **Fotos dos objetos da sala que não estão nas 10 classes** (projetor, armário, máquinas...), para ver se o genérico avisa "equipamento".
4. A **medida da seta impressa** (largura em cm).

Conferir as fotos das setas (extrair quadros de um vídeo com `treino/extrair_quadros.py`):

```bash
python treino/avaliar_setas.py fotos_seta_direita.zip --esperado direita
python treino/avaliar_setas.py fotos_sala_sem_seta.zip --esperado nenhuma
```

## 5. Verificação

- `npm test`: 179 passaram, 1 pulado, 0 falhas. Novos em `testes/setas-e-equipamento.test.js` (8 testes, inclusive as 13 fotos e o app inteiro).
- `testes/navegador/verificar-extras.js` (Chromium real, câmera falsa, sem internet): foto da seta → "Seta: vire à esquerda"; foto espelhada →
  "Seta: vire à direita"; foto da sala com caixas → seta + "Caixa à direita" (caixa confirmada pelo banco); manequim → "Manequim à frente"
  sem "pessoa"; foto de rua (bus.jpg do Ultralytics) → ônibus e duas pessoas que a fábrica não viu, marcados como genéricos. Sem erro de CSP.
- **Não testado**: celular real, voz real, sala real.
