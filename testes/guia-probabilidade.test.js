'use strict';
// Guia por probabilidade (pedido do Ryan, 04/11/2026): sempre indica a direção com menor chance de bloqueio; acima de 90% em todas, pede ajuda.
const test = require('node:test'), assert = require('node:assert/strict');
const {montar, d, sleep, criarNucleoVisio} = require('./apoio.js');

const N = criarNucleoVisio(), I = N.CLASSES;
const g = (cls, z, area = .1, n = 1) => ({cls, info: I[cls], z, n, area});
const decidir = (grupos, extra = {}) => N.decidirOrientacao(Object.assign({modo: 'probabilidade', agora: 100, grupos, deteccao: {estado: 'ok', tCaptura: 90}}, extra));
const pc = v => Math.round(v*100);

test('probabilidade: sem objeto indica a frente (menor chance), com a porcentagem e sem dizer "livre"', () => {
  const dec = decidir([]);
  assert.equal(dec.decisao, 'guiar_centro'); assert.equal(dec.escolha, 'frente');
  assert.deepEqual(Object.keys(dec.probabilidades), ['esquerda', 'frente', 'direita']);
  assert.ok(dec.probabilidades.frente < dec.probabilidades.esquerda);
  const p = N.planejarSemObjetos(dec);
  assert.equal(p.texto, 'Nenhum obstáculo reconhecido. Siga em frente, chance de bloqueio baixa, 20%.');
  assert.doesNotMatch(p.texto, /livre|seguro|garant/i);
  assert.ok(dec.limitacoes.includes('chance_de_bloqueio_estimada_por_regras_nao_calibrada'));
});

test('probabilidade: objeto à frente → guia para o lado de menor chance e diz o nível', () => {
  const dec = decidir([g('caixa', 'frente', .2), g('mesa', 'esquerda', .1)]);
  assert.equal(dec.escolha, 'direita');
  assert.ok(dec.probabilidades.frente > .9 && dec.probabilidades.esquerda > .6 && dec.probabilidades.direita < .6, JSON.stringify(dec.probabilidades));
  const p = N.planejar([g('caixa', 'frente', .2), g('mesa', 'esquerda', .1)], dec);
  assert.equal(p.texto, 'Caixa à frente e mesa à esquerda. Vá pela direita com cuidado, chance de bloqueio média, 30%.');
  assert.equal(p.curto, 'Caixa à frente e mesa à esquerda. Vá pela direita com cuidado.');
  assert.equal(p.urgente, false);
});

test('probabilidade: objeto maior (mais perto) dá chance maior; vários do mesmo tipo somam; equipamento pesa um pouco menos', () => {
  const pf = gs => decidir(gs).probabilidades.frente;
  assert.ok(pf([g('caixa', 'frente', .02)]) < pf([g('caixa', 'frente', .2)]));
  assert.ok(pf([g('caixa', 'frente', .02, 3)]) > pf([g('caixa', 'frente', .02, 1)]));
  assert.ok(pf([g('equipamento', 'frente', .1)]) < pf([g('caixa', 'frente', .1)]));
  // possível objeto de baixa confiança e detecção ainda não confirmada também aumentam a chance (sem virar obstáculo)
  const dec = decidir([], {candidatos: [{z: 'esquerda', area: .1}], pendentes: [{z: 'direita'}]});
  assert.ok(dec.probabilidades.esquerda > .3 && dec.probabilidades.direita > .3); assert.equal(dec.escolha, 'frente');
});

test('probabilidade: TODAS acima de 90% → pede ajuda (urgente); 78% ainda guia, com muito cuidado', () => {
  const tudo = [g('caixa', 'frente', .3), g('mesa', 'esquerda', .3), g('banco', 'direita', .3)];
  const dec = decidir(tudo);
  assert.equal(dec.decisao, 'pedir_ajuda'); assert.equal(dec.escolha, null);
  for (const z of N.ZONAS) assert.ok(dec.probabilidades[z] > .9, z);
  const p = N.planejar(tudo, dec);
  assert.match(p.texto, /Todas as direções parecem bloqueadas\. Pare e peça ajuda\.$/); assert.equal(p.urgente, true);
  const pouco = [g('caixa', 'frente', .1), g('caixa', 'esquerda', .05), g('caixa', 'direita', .05)];
  const d2 = decidir(pouco);
  assert.equal(d2.decisao, 'guiar_esquerda'); assert.equal(d2.nivel, 'alta');
  assert.match(N.planejar(pouco, d2).texto, /Vá pela esquerda devagar, com muito cuidado, chance de bloqueio alta, \d\d%\.$/);
  assert.equal(N.PROB.ajuda, .9);
  assert.equal(N.nivelDe(.29), 'baixa'); assert.equal(N.nivelDe(.59), 'média'); assert.equal(N.nivelDe(.9), 'alta'); assert.equal(N.nivelDe(.91), 'muito alta');
});

test('probabilidade: empate mantém a direção anterior; seta da parede é seguida se não for muito pior; pessoa à frente é urgente', () => {
  const fr = [g('caixa', 'frente', .2)];
  assert.equal(decidir(fr).escolha, 'esquerda');                                   // empate entre os lados: ordem fixa
  assert.equal(decidir(fr, {ultimaEscolha: 'direita'}).escolha, 'direita');       // estabilidade: não fica alternando
  assert.equal(decidir(fr, {seta: {direcao: 'direita', idadeMs: 1000}}).escolha, 'direita');
  assert.equal(decidir(fr, {seta: {direcao: 'direita', idadeMs: 9000}}).escolha, 'esquerda');                       // seta velha não vale
  assert.equal(decidir([...fr, g('mesa', 'direita', .2)], {seta: {direcao: 'direita', idadeMs: 1000}}).escolha, 'esquerda');   // seta para lado bloqueado: não
  const pes = [g('pessoa', 'frente', .3)];
  assert.equal(N.planejar(pes, decidir(pes)).urgente, true);
});

test('probabilidade: lados não confirmados pesam nos lados; piso por cor favorável baixa a chance; detecção inválida não inventa direção', () => {
  const nc = decidir([], {lados: {confirmado: false}});
  assert.ok(nc.probabilidades.esquerda >= .5 && nc.probabilidades.direita >= .5);
  const seg = {estado: 'ok', cobertura: 1, tCaptura: 90, origem: 'heuristica_cor_piso', regioes: {
    esquerda: {livre: .95, continuidade: 1, larguraRel: 1, confianca: .9}, frente: {livre: .1, continuidade: 0, larguraRel: 0, confianca: .9}, direita: {livre: .5, continuidade: .5, larguraRel: .5, confianca: .9}}};
  const dp = decidir([], {seg});
  assert.equal(dp.escolha, 'esquerda', JSON.stringify(dp.probabilidades)); assert.ok(dp.probabilidades.esquerda < .15 && dp.probabilidades.frente > .7);
  const inval = N.decidirOrientacao({modo: 'probabilidade', agora: 100, grupos: [], deteccao: {estado: 'falha'}});
  assert.equal(inval.decisao, 'analise_insuficiente'); assert.equal(N.planejarSemObjetos(inval).texto, 'Não foi possível avaliar a passagem adequadamente.');
  // modos antigos não mudam
  assert.equal(N.decidirOrientacao({modo: 'padrao', agora: 100, grupos: [g('caixa', 'frente', .2)], deteccao: {estado: 'ok', tCaptura: 90}}).decisao, 'passagem_nao_confirmada');
});

// ---- app inteiro ----
test('app no guia por probabilidade: caixa à frente → "Vá pela esquerda..." e o painel mostra as porcentagens', async () => {
  const a = await montar({script: [[d('caixa', [240, 150, 160, 250], .9)]], vals: {modo: 'probabilidade', lados: 'normal'}});
  await a.iniciar(); await sleep(400); a.encerrar();
  assert.ok(a.falas.some(t => /^Caixa à frente\. Vá pela (esquerda|direita) com cuidado, chance de bloqueio média, 30%\.$/.test(t)), a.falas.join(' | '));
  assert.match(a.els.oProb.textContent, /^E 30% · F [89]\d% · D 30% → (esquerda|direita) \(chance média\)$/);
});
