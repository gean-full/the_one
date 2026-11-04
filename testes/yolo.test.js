'use strict';
// Decodificação da saída do YOLO (modelo próprio da fábrica): letterbox desfeito, limiar e NMS por classe.
const test = require('node:test'), assert = require('node:assert/strict');
const {decodificar, iou} = require('../js/yolo.js');

// Monta a saída [4 + nc, N] (transposta, como o Ultralytics exporta) a partir de uma lista de caixas.
function saida(nc, caixas){
  const n = caixas.length, d = new Float32Array((4+nc)*n);
  caixas.forEach((k, j) => { d[j] = k.cx; d[n+j] = k.cy; d[2*n+j] = k.w; d[3*n+j] = k.h; d[(4+k.c)*n+j] = k.s; });
  return {d, n};
}
const op = o => Object.assign({scoreMin:.3, maxDet:20, padX:0, padY:0, escala:1, W:416, H:416, classes:['caixa', 'mesa']}, o);

test('yolo: converte cx,cy,w,h em [x,y,w,h] e descarta abaixo do limiar', () => {
  const {d, n} = saida(2, [{cx:100, cy:100, w:40, h:20, c:1, s:.9}, {cx:300, cy:300, w:10, h:10, c:0, s:.2}]);
  const r = decodificar(d, 2, n, op());
  assert.equal(r.length, 1); assert.equal(r[0].class, 'mesa'); assert.deepEqual(r[0].bbox, [80, 90, 40, 20]);
});

test('yolo: desfaz o letterbox para pixels do vídeo e recorta na borda', () => {
  // vídeo 832x416 → escala .5, faixa cinza de 104 px em cima e embaixo
  const {d, n} = saida(1, [{cx:208, cy:208, w:100, h:100, c:0, s:.8}, {cx:410, cy:120, w:20, h:20, c:0, s:.7}]);
  const r = decodificar(d, 1, n, op({padY:104, escala:.5, W:832, H:416, classes:['caixa']}));
  assert.deepEqual(r[0].bbox, [316, 108, 200, 200]);
  assert.equal(r[1].bbox[0] + r[1].bbox[2], 832);
});

test('yolo: NMS remove duplicatas da mesma classe e mantém classes diferentes sobrepostas', () => {
  const {d, n} = saida(2, [{cx:100, cy:100, w:50, h:50, c:0, s:.9}, {cx:102, cy:101, w:50, h:50, c:0, s:.8}, {cx:100, cy:100, w:50, h:50, c:1, s:.6}]);
  const r = decodificar(d, 2, n, op());
  assert.deepEqual(r.map(p => p.class), ['caixa', 'mesa']); assert.equal(r[0].score.toFixed(1), '0.9');
  assert.equal(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0);
});

test('yolo: respeita maxDet', () => {
  const {d, n} = saida(1, Array.from({length:30}, (_, i) => ({cx:10 + i*13, cy:50, w:8, h:8, c:0, s:.5 + i/100})));
  assert.equal(decodificar(d, 1, n, op({classes:['caixa'], maxDet:20})).length, 20);
});

test('yolo: toda classe do modelo da fábrica tem nome falado em CLASSES (núcleo)', () => {
  const rot = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'modelos', 'fabrica', 'rotulos.json'), 'utf8'));
  const {CLASSES} = require('../js/nucleo.js').criarNucleoVisio();
  for (const c of rot.classes) assert.ok(CLASSES[c], 'classe sem fala: ' + c);
  assert.equal(rot.tamanho, 416);
});

test('yolo: rotulos.json inválido é recusado antes de carregar o modelo', () => {
  const {validarRotulos} = require('../js/yolo.js');
  assert.throws(() => validarRotulos({tamanho: 415, classes: ['a']}), /tamanho/);
  assert.throws(() => validarRotulos({tamanho: 416, classes: []}), /classes/);
  assert.throws(() => validarRotulos({tamanho: 416, classes: ['a', '']}), /classes/);
  assert.equal(validarRotulos({tamanho: 320, classes: ['a']}).tamanho, 320);
});

test('yolo: classe nova vinda do rotulos.json ("falas") passa a ser falada sem editar o código; definição malformada é recusada', () => {
  const N = require('../js/nucleo.js').criarNucleoVisio();
  const r = N.registrarClasses({palete: {s: 'palete', p: 'paletes', g: 'm', prio: 2, off: 0}, ruim: {s: 'x', p: 'xs', g: 'n', prio: 2}, pior: null});
  assert.deepEqual(r, {aceitas: ['palete'], recusadas: ['ruim', 'pior']});
  assert.equal(N.CLASSES.palete.p, 'paletes'); assert.equal(N.CLASSES.ruim, undefined);
  assert.match(N.planejar([{info: N.CLASSES.palete, cls: 'palete', z: 'frente', n: 2, area: .2}]).texto, /Dois paletes à frente/);
  // As falas do modelo publicado batem com as de treino/classes.py (fonte da verdade do treino).
  const rot = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'modelos', 'fabrica', 'rotulos.json'), 'utf8'));
  const py = require('fs').readFileSync(require('path').join(__dirname, '..', 'treino', 'classes.py'), 'utf8');
  const ordem = JSON.parse(py.match(/^CLASSES = (\[[^\]]+\])/m)[1].replace(/'/g, '"'));
  assert.deepEqual(rot.classes, ordem, 'ordem das classes do modelo diferente de treino/classes.py');
});
