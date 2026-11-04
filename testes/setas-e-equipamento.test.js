'use strict';
// Setas da parede (js/setas.js) e objetos desconhecidos pelo detector genérico (fundirGenericos em js/nucleo.js), sozinhos e no app inteiro.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const S = require('../js/setas.js');
const {montar, d, sleep, criarNucleoVisio} = require('./apoio.js');

// ---- imagens ----
const DADOS = path.join(__dirname, 'dados', 'setas');
function rgba(rgb, w, h){ const px = new Uint8ClampedArray(w*h*4); for (let i = 0; i < w*h; i++){ px[4*i] = rgb[3*i]; px[4*i+1] = rgb[3*i+1]; px[4*i+2] = rgb[3*i+2]; px[4*i+3] = 255; } return px; }
function espelhar(px, w, h){ const o = new Uint8ClampedArray(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) o[4*(y*w + x) + c] = px[4*(y*w + (w-1-x)) + c]; return o; }
// Desenho sintético: fundo cinza claro, polígono preto (contorno) e o mesmo polígono amarelo encolhido por dentro.
function dentro(x, y, pol){ let ok = false; for (let i = 0, j = pol.length - 1; i < pol.length; j = i++){ const [xi, yi] = pol[i], [xj, yj] = pol[j]; if ((yi > y) !== (yj > y) && x < (xj - xi)*(y - yi)/(yj - yi) + xi) ok = !ok; } return ok; }
function imagem(w, h, formas){
  const px = new Uint8ClampedArray(w*h*4);
  for (let i = 0; i < w*h; i++){ px[4*i] = 205; px[4*i+1] = 208; px[4*i+2] = 210; px[4*i+3] = 255; }
  for (const {pol, cor, contorno = 2} of formas){
    const cx = pol.reduce((s, p) => s + p[0], 0)/pol.length, cy = pol.reduce((s, p) => s + p[1], 0)/pol.length;
    const enc = pol.map(([x, y]) => { const dx = x - cx, dy = y - cy, n = Math.hypot(dx, dy) || 1; return [x - dx/n*contorno, y - dy/n*contorno]; });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
      const j = 4*(y*w + x);
      if (contorno && dentro(x + .5, y + .5, pol)){ px[j] = 25; px[j+1] = 25; px[j+2] = 25; }
      if (dentro(x + .5, y + .5, contorno ? enc : pol)){ px[j] = cor[0]; px[j+1] = cor[1]; px[j+2] = cor[2]; }
    }
  }
  return px;
}
const AMARELO = [235, 205, 20];
// seta horizontal apontando para a esquerda, ponta em (x, y), comprimento L
const setaEsq = (x, y, L) => [[x, y], [x + L*.38, y - L*.3], [x + L*.38, y - L*.13], [x + L, y - L*.13], [x + L, y + L*.13], [x + L*.38, y + L*.13], [x + L*.38, y + L*.3]];
const setaDir = (x, y, L) => setaEsq(0, 0, L).map(([a, b]) => [x - a, y + b]);

test('setas: as 13 fotos do Ryan dão "esquerda" e as mesmas fotos espelhadas dão "direita"', () => {
  const ind = JSON.parse(fs.readFileSync(path.join(DADOS, 'indice.json'), 'utf8'));
  assert.equal(ind.fotos.length, 13);
  for (const f of ind.fotos){
    const px = rgba(zlib.gunzipSync(fs.readFileSync(path.join(DADOS, f.arq))), f.w, f.h);
    const r = S.detectar(px, f.w, f.h);
    assert.equal(r.length, 1, f.foto + ': ' + JSON.stringify(r));
    assert.equal(r[0].direcao, 'esquerda', f.foto);
    const e = S.detectar(espelhar(px, f.w, f.h), f.w, f.h);
    assert.equal(e.length, 1, f.foto + ' espelhada'); assert.equal(e[0].direcao, 'direita', f.foto + ' espelhada');
    // espelhar inverte a caixa também: a seta espelhada ocupa o lugar simétrico
    assert.ok(Math.abs((e[0].bbox[0] + e[0].bbox[2]) - (f.w - r[0].bbox[0])) <= 2, f.foto);
  }
});

test('setas: desenho sintético nas duas direções e em vários tamanhos; formas parecidas NÃO viram seta', () => {
  for (const L of [24, 40, 80, 140]){
    assert.deepEqual(S.detectar(imagem(256, 192, [{pol: setaEsq(60, 90, L), cor: AMARELO}]), 256, 192).map(s => s.direcao), ['esquerda'], 'L=' + L);
    assert.deepEqual(S.detectar(imagem(256, 192, [{pol: setaDir(200, 90, L), cor: AMARELO}]), 256, 192).map(s => s.direcao), ['direita'], 'L=' + L);
  }
  const negativos = {
    'retângulo amarelo (placa, fita)': [[60, 60], [180, 60], [180, 120], [60, 120]],
    'triângulo de alerta (ponta para cima)': [[128, 40], [180, 140], [76, 140]],
    'triângulo apontando para a esquerda (sem haste)': [[60, 96], [160, 46], [160, 146]],
    'seta para cima': setaEsq(0, 0, 100).map(([a, b]) => [128 + b, 40 + a]),
    'losango': [[128, 40], [190, 96], [128, 152], [66, 96]]
  };
  for (const [nome, pol] of Object.entries(negativos)) assert.deepEqual(S.detectar(imagem(256, 192, [{pol, cor: AMARELO}]), 256, 192), [], nome);
  // seta com a forma certa, mas sem o contorno preto, ou num amarelo desbotado (folha, papelão): não é a seta da sala
  assert.deepEqual(S.detectar(imagem(256, 192, [{pol: setaEsq(60, 90, 100), cor: AMARELO, contorno: 0}]), 256, 192), [], 'sem contorno');
  assert.deepEqual(S.detectar(imagem(256, 192, [{pol: setaEsq(60, 90, 100), cor: [200, 190, 120]}]), 256, 192), [], 'amarelo desbotado');
  // duas setas: as duas são achadas, a maior primeiro
  const duas = S.detectar(imagem(256, 192, [{pol: setaEsq(20, 60, 60), cor: AMARELO}, {pol: setaDir(240, 140, 110), cor: AMARELO}]), 256, 192);
  assert.deepEqual(duas.map(s => s.direcao), ['direita', 'esquerda']);
});

test('setas: o seguidor anuncia uma vez por aparição, depois de 2 quadros iguais, e de novo se a direção mudar ou a seta sumir', () => {
  const s = S.criarSeguidorSetas({persist: 2, esquecerMs: 1000});
  assert.equal(s.atualizar({direcao: 'esquerda'}, 0), null);
  assert.equal(s.atualizar({direcao: 'esquerda'}, 100).texto, 'Seta: vire à esquerda.');
  assert.equal(s.atualizar({direcao: 'esquerda'}, 200), null);                // mesma seta: silêncio
  assert.equal(s.atualizar(null, 300), null);
  assert.equal(s.atualizar({direcao: 'esquerda'}, 400), null);                // piscou: ainda é a mesma
  assert.equal(s.atualizar({direcao: 'esquerda'}, 500), null);
  assert.equal(s.atualizar({direcao: 'direita'}, 600), null);
  assert.equal(s.atualizar({direcao: 'direita'}, 700).texto, 'Seta: vire à direita.');
  s.atualizar(null, 800); s.atualizar(null, 2000);                            // sumiu por mais de 1 s
  s.atualizar({direcao: 'direita'}, 2100);
  assert.equal(s.atualizar({direcao: 'direita'}, 2200).texto, 'Seta: vire à direita.');
  // um quadro com a direção trocada (erro isolado) não fala nada
  const t = S.criarSeguidorSetas({persist: 2});
  t.atualizar({direcao: 'esquerda'}, 0); assert.equal(t.atualizar({direcao: 'direita'}, 100), null);
});

// ---- objetos desconhecidos ----
test('genérico: objeto que a fábrica não conhece vira "equipamento"; sobre objeto conhecido ele é descartado; o conhecido nunca muda', () => {
  const N = criarNucleoVisio(), W = 640, H = 480;
  const conhecidas = [d('caixa', [100, 200, 120, 120], .8), d('lixeira', [500, 200, 80, 120], .4)];
  const copia = JSON.stringify(conhecidas);
  const anunciavel = p => p.score >= .6;
  const gen = [
    d('refrigerator', [300, 100, 120, 300], .7),      // novo: equipamento
    d('suitcase', [105, 205, 110, 110], .9),          // em cima da caixa conhecida: descartado
    d('tv', [490, 190, 100, 140], .8),                // em cima da lixeira, mas a lixeira está abaixo do limiar: fica (genérico não apaga, a fábrica também não falaria)
    d('person', [0, 50, 90, 400], .8),                // nome conhecido
    d('bottle', [250, 250, 20, 40], .9),              // pequeno demais
    d('oven', [300, 300, 200, 150], .4),              // nota baixa
    d('microwave', [310, 110, 110, 280], .6)          // mesma máquina que a "geladeira": NMS sem classe
  ];
  const r = N.fundirGenericos(conhecidas, gen, W, H, {anunciavel});
  assert.deepEqual(r.map(p => p.class + ':' + p.generico.classe), ['equipamento:tv', 'pessoa:person', 'equipamento:refrigerator']);
  assert.equal(JSON.stringify(conhecidas), copia, 'as caixas da fábrica não podem ser alteradas');
  // seta na parede não é obstáculo: caixa genérica sobre a seta some
  assert.equal(N.fundirGenericos([], [d('kite', [300, 100, 100, 60], .8)], W, H, {setas: [[305, 105, 90, 50]]}).length, 0);
  // entrada ruim não derruba nada
  assert.deepEqual(N.fundirGenericos(null, [{class: 'x', score: NaN, bbox: [0, 0, 1, 1]}, null], W, H), []);
  assert.equal(N.CLASSES.equipamento.s, 'equipamento'); assert.equal(N.CLASSES.equipamento.prio, 1);
});

test('genérico no planejador: "Equipamento à frente"; equipamento nunca tira uma classe conhecida da fala', () => {
  const N = criarNucleoVisio(), I = N.CLASSES;
  const p = N.planejar([{cls: 'equipamento', info: I.equipamento, z: 'frente', n: 1, area: .3}, {cls: 'caixa', info: I.caixa, z: 'esquerda', n: 1, area: .05}]);
  assert.match(p.texto, /^Equipamento à frente e caixa à esquerda\./);           // o que está à frente vem primeiro
  // 4 grupos conhecidos + 2 equipamentos à frente: os 4 conhecidos são falados, os equipamentos viram "e mais 2 objetos"
  const g = (cls, z, area = .05) => ({cls, info: I[cls], z, n: 1, area});
  const q = N.planejar([g('equipamento', 'esquerda', .4), g('caixa', 'esquerda'), g('mesa', 'direita'), g('banco', 'esquerda'), g('lixeira', 'direita'), {cls: 'equipamento', info: I.equipamento, z: 'esquerda', n: 1, area: .4}]);
  for (const nome of ['caixa', 'mesa', 'banco', 'lixeira']) assert.match(q.texto, new RegExp(nome, 'i'), q.texto);
  assert.doesNotMatch(q.texto, /equipamento/); assert.match(q.texto, /e mais 2 objetos/);
  assert.match(N.planejar([{cls: 'equipamento', info: I.equipamento, z: 'frente', n: 2, area: .2}]).texto, /^Dois equipamentos à frente/);
});

// ---- app inteiro (modelo da fábrica e genérico SIMULADOS) ----
const ate = async (cond, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(2); assert.ok(cond(), 'condição não atingida a tempo'); };
const FALAS = {caixa: {s: 'caixa', p: 'caixas', g: 'f', prio: 2, off: 0}};
function yoloSimulado({fab, gen, genFalha = false}){
  const cont = {gen: 0, fab: 0};
  return {cont, carregar: async op => {
    if (/generico/.test(op.modelo)){
      if (genFalha) throw new Error('sem o arquivo');
      return {classes: ['person', 'refrigerator'], versao: 'coco', provedor: 'mock', dispose(){}, detect: async () => { cont.gen++; return gen.map(p => Object.assign({}, p)); }};
    }
    return {classes: ['caixa'], versao: 'v-fab', conjunto: 't', assinaturas: false, provedor: 'mock', falas: FALAS, dispose(){}, detect: async () => (cont.fab++, fab).map(p => Object.assign({}, p))};
  }};
}
async function rodarApp(op, vals = {}, extra = {}){
  const y = yoloSimulado(op); globalThis.VisioYolo = y;
  try {
    const a = await montar(Object.assign({vals: Object.assign({modelo: 'fabrica', generico: 'ligado'}, vals)}, extra));
    await a.iniciar(); await sleep(400); a.encerrar(); a.genChamadas = y.cont.gen; a.fabChamadas = y.cont.fab; return a;
  } finally { delete globalThis.VisioYolo; }
}

test('app: caixa conhecida à esquerda e máquina desconhecida à frente → fala os dois; com o genérico desligado, só a caixa', async () => {
  const fab = [d('caixa', [20, 200, 150, 150], .85)], gen = [d('refrigerator', [250, 80, 140, 380], .75), d('suitcase', [25, 205, 140, 140], .9)];
  const a = await rodarApp({fab, gen});
  assert.ok(a.falas.some(t => /Equipamento à frente e caixa à esquerda/.test(t)), a.falas.join(' | '));
  assert.ok(!a.falas.some(t => /Duas caixas|dois equipamentos/i.test(t)), 'a mala genérica sobre a caixa não pode contar de novo');
  assert.ok(a.genChamadas > 2);
  const b = await rodarApp({fab, gen}, {generico: 'desligado'});
  assert.ok(b.falas.some(t => /^Caixa à esquerda/.test(t)) && !b.falas.some(t => /quipamento/.test(t)), b.falas.join(' | '));
  assert.equal(b.genChamadas, 0);
});

test('app: genérico econômico roda em metade dos quadros; genérico que não carrega deixa a fábrica funcionando', async () => {
  const fab = [d('caixa', [20, 200, 150, 150], .85)], gen = [d('refrigerator', [250, 80, 140, 380], .75)];
  const e = await rodarApp({fab, gen}, {generico: 'economico'});
  assert.ok(e.falas.some(t => /quipamento à frente/.test(t)), e.falas.join(' | '));
  assert.ok(e.fabChamadas > 4 && e.genChamadas <= Math.ceil(e.fabChamadas/2) + 1, e.genChamadas + ' de ' + e.fabChamadas);
  const f = await rodarApp({fab, gen, genFalha: true});
  assert.ok(f.falas.some(t => /^Caixa à esquerda/.test(t)), f.falas.join(' | '));
  assert.match(f.els.gEstado.textContent, /indisponível/);
});

test('app: seta amarela na imagem → "Seta: vire à esquerda." uma vez; com a imagem espelhada (lados invertidos) → à direita', async () => {
  const quadro = () => ({data: imagem(320, 240, [{pol: setaEsq(40, 120, 150), cor: AMARELO}]), width: 320, height: 240});
  const a = await rodarApp({fab: [], gen: []}, {setas: 'ligado'}, {quadro});
  assert.equal(a.falas.filter(t => t === 'Seta: vire à esquerda.').length, 1, a.falas.join(' | '));
  const b = await rodarApp({fab: [], gen: []}, {setas: 'ligado', lados: 'invertido'}, {quadro});
  assert.equal(b.falas.filter(t => t === 'Seta: vire à direita.').length, 1, b.falas.join(' | '));
  const c = await rodarApp({fab: [], gen: []}, {setas: 'desligado'}, {quadro});
  assert.ok(!c.falas.some(t => /Seta/.test(t)));
});
