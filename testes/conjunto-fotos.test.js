'use strict';
// Integridade do conjunto de fotos marcadas (treino/conjuntos/fotos_v2) e da rastreabilidade do modelo publicado. Lê só os JSON versionados.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const RAIZ = path.join(__dirname, '..'), C = path.join(RAIZ, 'treino', 'conjuntos', 'fotos_v2');
const ler = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const conj = ler(path.join(C, 'conjunto.json')), man = ler(path.join(C, 'marcacoes.json')), rev = ler(path.join(C, 'revisao_manual.json'));

test('fotos_v2: só fica "pronta" a foto com classe da lista, marcação válida e nenhuma pendência', () => {
  assert.match(man.regra, /DENTRO da marcação vermelha/);
  assert.deepEqual(man.classes, conj.classes);
  for (const f of man.fotos){
    if (f.situacao !== 'pronta'){ assert.ok(f.pendencias.length, f.arquivo + ' pendente sem motivo'); continue; }
    assert.deepEqual(f.pendencias, [], f.arquivo);
    assert.ok(conj.classes.includes(f.classe), f.arquivo + ': classe ' + f.classe);
    assert.ok(f.marcacoes.length >= 1, f.arquivo + ' sem marcação');
    const [W, H] = f.qualidade.recorte_px;
    for (const m of f.marcacoes){ const [x1, y1, x2, y2] = m.caixa_px; assert.ok(x1 >= 0 && y1 >= 0 && x2 <= W && y2 <= H && x2 > x1 && y2 > y1, f.arquivo + ' caixa fora do recorte'); }
  }
});

test('fotos_v2: ambiguidades registradas ficam fora da exportação (vários objetos numa marcação, objeto não identificado, alvo fora da marcação)', () => {
  const por = Object.fromEntries(man.fotos.map(f => [f.arquivo, f]));
  assert.equal(por['objeto_estranho.png'].classe, null); assert.equal(por['objeto_estranho.png'].situacao, 'pendente');
  for (const a of ['pilha_de_caixas.png', 'multiplos_manequins.png', 'cadeiras_enfileiradas.png', 'branco.png', 'banco_lado.png'])
    assert.equal(por[a].situacao, 'pendente', a);
  // Toda pendência manual aparece no manifesto gerado (o manifesto não está velho em relação à revisão).
  for (const [arq, r] of Object.entries(rev)) if (arq[0] !== '_') for (const p of r.pendencias || []) assert.ok(por[arq].pendencias.includes(p), arq + ': manifesto desatualizado; rode marcacoes.py preparar');
  // Nenhuma classe foi criada a partir do cenário: só classes do nome do arquivo (tabela) ou da revisão manual.
  const permitidas = new Set([...Object.values(conj.classe_por_nome), ...Object.values(rev).map(r => r && r.classe).filter(Boolean)]);
  for (const c of conj.classes) assert.ok(permitidas.has(c), 'classe sem origem nas marcações: ' + c);
});

test('modelo publicado declara de qual conjunto de fotos veio (comparação antes/depois); a avaliação do modelo atual nas fotos novas está registrada', () => {
  const rot = ler(path.join(RAIZ, 'modelos', 'fabrica', 'rotulos.json'));
  assert.equal(typeof rot.conjunto, 'string'); assert.ok(rot.conjunto.length);
  const av = ler(path.join(C, 'avaliacoes', rot.versao + '.json'));
  assert.equal(av.modelo.versao, rot.versao); assert.equal(av.conjunto_avaliado.versao, man.versao);
  assert.ok(av.resumo.medidas >= 1 && av.resumo.acertos <= av.resumo.medidas);
});
