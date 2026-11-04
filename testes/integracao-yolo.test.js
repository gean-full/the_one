'use strict';
/*
 * Integração do YOLO (js/yolo.js → carregar/detect) com o ONNX Runtime SIMULADO (mock), sem navegador:
 * carga dos rótulos pela rede (erros HTTP e conteúdo inválido), pré-processamento (letterbox 416, RGB/255, NCHW), conversão das caixas
 * para pixels do vídeo, uma inferência por vez, saída incompatível e modelo liberado.
 * O mock devolve tensores montados pelo teste: ISTO NÃO VALIDA O MODELO REAL nem a precisão. O modelo real é exercitado no Chromium
 * por testes/navegador/verificar.js e pelo teste "modelo real" abaixo (onnxruntime-node, se instalado).
 */
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('path'), fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function adiada(){ let resolve, reject; const promessa = new Promise((a, b) => { resolve = a; reject = b; }); return {promessa, resolve, reject}; }

const T = 416;
// Ambiente mínimo do navegador para js/yolo.js: document (canvas 2D), fetch e o ONNX Runtime falso em globalThis.ort.
function ambiente({rotulos = {tamanho: T, classes: ['caixa', 'mesa'], versao: 'v-teste', conjunto: 'fotos_teste'}, status = 200, corpo = null, run = null, dims = null} = {}){
  const reg = {desenhos: [], entradas: [], criadas: [], fetches: [], liberada: 0};
  const ctx = {fillStyle: '', fillRect(){}, drawImage(fonte, x, y, w, h){ reg.desenhos.push([x, y, w, h]); },
    getImageData: (x, y, w, h) => ({data: new Uint8ClampedArray(w*h*4).fill(255)})};
  globalThis.document = {baseURI: 'http://localhost/', head: {appendChild(){}}, createElement: () => ({width: 0, height: 0, getContext: () => ctx})};
  globalThis.fetch = async (url, op) => { reg.fetches.push([url, op]);
    return {ok: status >= 200 && status < 300, status, json: async () => { if (corpo !== null) return JSON.parse(corpo); return rotulos; }}; };
  const nc = rotulos && Array.isArray(rotulos.classes) ? rotulos.classes.length : 0;
  const sessao = {inputNames: ['images'], outputNames: ['output0'], release(){ reg.liberada++; },
    run: async feeds => { const t = feeds.images; reg.entradas.push(t); if (run) return run(t, reg.entradas.length);
      return {output0: {dims: dims || [1, 4 + nc, 1], data: new Float32Array((4 + nc) * 1)}}; }};
  globalThis.ort = {env: {wasm: {}}, Tensor: class { constructor(tipo, data, dims){ Object.assign(this, {tipo, data, dims}); } },
    InferenceSession: {create: async (url, op) => { reg.criadas.push([url, op]); return sessao; }}};
  delete require.cache[require.resolve('../js/yolo.js')];
  return {Y: require('../js/yolo.js'), reg};
}
const MOD = {modelo: 'modelos/fabrica/yolo-fabrica.onnx', rotulos: 'modelos/fabrica/rotulos.json'};
// Saída [1, 4+nc, N] com uma caixa (cx, cy, w, h no espaço 416 da entrada) da classe c com nota s.
const umaCaixa = (nc, cx, cy, w, h, c, s) => { const d = new Float32Array(4 + nc); d.set([cx, cy, w, h]); d[4 + c] = s; return {output0: {dims: [1, 4 + nc, 1], data: d}}; };

test('YOLO: carrega rótulos e modelo, aquece uma vez e informa versão, conjunto de fotos e provedor', async () => {
  const {Y, reg} = ambiente();
  const m = await Y.carregar(MOD);
  assert.deepEqual(m.classes, ['caixa', 'mesa']); assert.equal(m.versao, 'v-teste'); assert.equal(m.conjunto, 'fotos_teste');
  assert.equal(reg.criadas.length, 1); assert.equal(reg.criadas[0][0], 'modelos/fabrica/yolo-fabrica.onnx?v=v-teste', 'o ?v= separa modelos de treinos diferentes no cache');
  assert.deepEqual(reg.criadas[0][1].executionProviders, ['wasm']);
  assert.equal(reg.entradas.length, 1, 'aquecimento: uma inferência na carga'); assert.deepEqual(reg.entradas[0].dims, [1, 3, T, T]);
  assert.equal(reg.fetches[0][1].cache, 'no-cache', 'rótulos sempre conferidos na rede (dizem qual versão do modelo pedir)');
  assert.match(m.provedor, /ONNX Runtime 1\.20\.1 wasm/); assert.ok(Number.isFinite(m.aquecimentoMs));
});

test('YOLO: erro HTTP, JSON inválido e rótulos malformados recusam a carga com mensagem clara (nenhuma sessão criada)', async () => {
  for (const [op, re] of [[{status: 404}, /rótulos 404/], [{status: 503}, /rótulos 503/], [{corpo: '{nao é json'}, /JSON|Unexpected|Expected/],
      [{rotulos: {tamanho: 416, classes: ['caixa', 'caixa']}}, /classe repetida/], [{rotulos: {tamanho: 400, classes: ['a']}}, /tamanho/], [{rotulos: null}, /tamanho/]]){
    const {Y, reg} = ambiente(op);
    await assert.rejects(Y.carregar(MOD), re); assert.equal(reg.criadas.length, 0);
  }
});

test('YOLO: quadro 640×480 → letterbox 416 (faixas cinzas em cima e embaixo), RGB/255 em NCHW, caixa devolvida em pixels do vídeo', async () => {
  // Caixa no centro da entrada, 208×104 px no espaço 416 → no vídeo (escala 0,65): 320×160 centrada em (320, 240).
  const {Y, reg} = ambiente({run: (t, k) => k === 1 ? umaCaixa(2, 0, 0, 0, 0, 0, 0) : umaCaixa(2, 208, 208, 208, 104, 1, .9)});
  const m = await Y.carregar(MOD);
  const r = await m.detect({videoWidth: 640, videoHeight: 480}, 20, .3);
  const [x, y, w, h] = reg.desenhos.at(-1);
  assert.deepEqual([x, y, w, h], [0, 52, 416, 312], 'letterbox: 640×480 → 416×312 com 52 px de faixa');
  const e = reg.entradas.at(-1); assert.deepEqual(e.dims, [1, 3, T, T]); assert.equal(e.data[0], 1, 'pixel branco (255) vira 1,0');
  assert.equal(r.length, 1); assert.equal(r[0].class, 'mesa'); assert.ok(Math.abs(r[0].score - .9) < 1e-6);
  r[0].bbox.forEach((v, i) => assert.ok(Math.abs(v - [160, 160, 320, 160][i]) < 1e-6, 'bbox ' + r[0].bbox));
  // Fonte sem dimensões (vídeo ainda sem quadro): nada é inferido.
  const antes = reg.entradas.length; assert.deepEqual(await m.detect({videoWidth: 0, videoHeight: 0}), []); assert.equal(reg.entradas.length, antes);
});

test('YOLO: uma inferência por vez; a segunda chamada concorrente é recusada com código modelo_ocupado e a seguinte funciona', async () => {
  const pend = adiada(); let chamadas = 0;
  const {Y} = ambiente({run: () => (++chamadas === 2 ? pend.promessa : Promise.resolve(umaCaixa(2, 10, 10, 4, 4, 0, .1)))});
  const m = await Y.carregar(MOD);
  const primeira = m.detect({videoWidth: 416, videoHeight: 416});
  await sleep(5);
  await assert.rejects(m.detect({videoWidth: 416, videoHeight: 416}), e => e.codigo === 'modelo_ocupado');
  pend.resolve(umaCaixa(2, 100, 100, 20, 20, 0, .8));
  assert.equal((await primeira).length, 1);
  assert.deepEqual(await m.detect({videoWidth: 416, videoHeight: 416}), [], 'livre de novo depois que a anterior terminou');
});

test('YOLO: falha da inferência libera o modelo para o próximo quadro; saída com nº de classes diferente dos rótulos é erro codificado', async () => {
  let k = 0;
  const {Y} = ambiente({run: () => { k++; if (k === 2) return Promise.reject(new Error('wasm abortou')); if (k === 3) return {output0: {dims: [1, 4 + 5, 1], data: new Float32Array(9)}}; return umaCaixa(2, 0, 0, 0, 0, 0, 0); }});
  const m = await Y.carregar(MOD);
  await assert.rejects(m.detect({videoWidth: 416, videoHeight: 416}), /wasm abortou/);
  await assert.rejects(m.detect({videoWidth: 416, videoHeight: 416}), e => e.codigo === 'saida_incompativel' && /incompatível/.test(e.message));
  assert.deepEqual(await m.detect({videoWidth: 416, videoHeight: 416}), []);
});

test('YOLO: modelo incompatível já na carga (aquecimento) é recusado; dispose libera a sessão e detect posterior falha com código', async () => {
  const {Y} = ambiente({dims: [1, 4 + 3, 1]});
  await assert.rejects(Y.carregar(MOD), /incompatível/);
  const b = ambiente(); const m = await b.Y.carregar(MOD);
  m.dispose(); assert.equal(b.reg.liberada, 1);
  await assert.rejects(m.detect({videoWidth: 416, videoHeight: 416}), e => e.codigo === 'modelo_liberado');
});

test('YOLO: o agendador preserva o código da falha (modelo_ocupado) e o app trata como inferência expirada', () => {
  const {criarNucleoVisio} = require('../js/nucleo.js');
  const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  assert.match(app, /modelo_ocupado:'inferencia_expirada'/);
  const N = criarNucleoVisio(); let erro = null; const timers = [];
  const ag = N.criarAgendador({now: () => 0, setTimer: (f, ms) => { timers.push(f); return timers.length; }, clearTimer(){}, intervalo: () => 100, aoErro: e => { erro = e; }});
  ag.registrar({nome: 'deteccao', executar: async () => { throw Object.assign(new Error('ocupado'), {codigo: 'modelo_ocupado'}); }});
  ag.iniciar();
  return sleep(5).then(() => { assert.equal(erro.codigo, 'modelo_ocupado'); assert.equal(ag.snapshot(0).errosPorCodigo.modelo_ocupado, 1); ag.parar(); });
});

test('modelo real: yolo-fabrica.onnx + rotulos.json publicados batem (entrada 416, saída 4 + nº de classes) e rodam (onnxruntime-node, se instalado)', async t => {
  const raiz = path.join(__dirname, '..', 'modelos', 'fabrica');
  const rot = JSON.parse(fs.readFileSync(path.join(raiz, 'rotulos.json'), 'utf8'));
  let ortNode; try { ortNode = require('onnxruntime-node'); } catch (e) { t.skip('onnxruntime-node não instalado (npm i --no-save onnxruntime-node para rodar)'); return; }
  const s = await ortNode.InferenceSession.create(path.join(raiz, 'yolo-fabrica.onnx'));
  const ent = new ortNode.Tensor('float32', new Float32Array(3*rot.tamanho*rot.tamanho).fill(114/255), [1, 3, rot.tamanho, rot.tamanho]);
  const out = (await s.run({[s.inputNames[0]]: ent}))[s.outputNames[0]];
  assert.equal(out.dims[1], 4 + rot.classes.length, 'saída do modelo incompatível com rotulos.json');
});

// ---- App inteiro (js/app.js) com o modelo Fábrica SIMULADO (VisioYolo falso): caminho de dados até a decisão e a fala. ----
const {montar, d} = require('./apoio.js');
const ate = async (cond, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(2); assert.ok(cond(), 'condição não atingida a tempo'); };
function yoloFalso(detect){
  return {carregar: async () => ({classes: ['caixa'], versao: 'v-teste', conjunto: 'fotos_teste', provedor: 'ONNX Runtime (mock)', falas: {caixa: {s: 'caixa', p: 'caixas', g: 'f', prio: 2, off: 0}},
    detect, dispose(){}})};
}

test('app + Fábrica (mock): detecção vira decisão com a ORIGEM e a versão do modelo e é falada; painel mostra o conjunto de fotos', async () => {
  globalThis.VisioYolo = yoloFalso(async () => [d('caixa', [260, 150, 120, 200], .9)]);
  try {
    const a = await montar({vals: {modelo: 'fabrica'}});
    await a.iniciar(); await ate(() => a.falas.some(t => /Caixa à frente/.test(t)));
    const dec = a.win.VisioIndustria.decisaoAtual();
    assert.equal(dec.fontes.deteccao.origem, 'yolo-fabrica@v-teste / fotos_teste');
    assert.match(a.els.mBackend.textContent, /fotos fotos_teste/);
    a.encerrar();
  } finally { delete globalThis.VisioYolo; }
});

test('app + Fábrica (mock): modelo ocupado/travado repetidamente → falha visível, aviso falado e decisão "inferência expirada" (nunca caminho livre)', async () => {
  globalThis.VisioYolo = yoloFalso(async () => { throw Object.assign(new Error('O modelo ainda processa o quadro anterior.'), {codigo: 'modelo_ocupado'}); });
  try {
    const a = await montar({vals: {modelo: 'fabrica'}});
    await a.iniciar(); await ate(() => a.falas.some(t => /não foi possível avaliar a passagem/.test(t)));
    assert.match(a.els.status.textContent, /^Falha: O modelo ainda processa/);
    assert.equal(a.win.VisioIndustria.decisaoAtual().fontes.deteccao.estado, 'inferencia_expirada');
    assert.ok(!a.falas.some(t => /livre/.test(t) && !/não garantem caminho livre/.test(t)));
    a.encerrar();
  } finally { delete globalThis.VisioYolo; }
});

test('app + COCO-SSD: a origem da decisão identifica o modelo COCO usado', async () => {
  const a = await montar({script: [[d('person', [260, 100, 120, 300], .9)]]});
  await a.iniciar(); await ate(() => a.win.VisioIndustria.decisaoAtual());
  assert.equal(a.win.VisioIndustria.decisaoAtual().fontes.deteccao.origem, 'coco-ssd/lite_mobilenet_v2');
  a.encerrar();
});
