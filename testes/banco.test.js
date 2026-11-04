'use strict';
// Banco de fotos na câmera (js/banco.js): assinatura das caixas, comparação com as fotos do banco e junção com a detecção ao vivo.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const B = require('../js/banco.js');
const {montar, d, sleep} = require('./apoio.js');

// Vetor unitário "na direção" i (com um pouco de ruído determinístico), dimensão n.
const dir = (i, n = 8, ruido = 0) => { const v = new Float32Array(n); v[i] = 1; for (let k = 0; k < n; k++) v[k] += ruido*Math.sin(k*7 + i); return B.normalizar(v); };

test('banco: mediaNaCaixa faz a média só das células sob a caixa e sempre cobre ao menos uma célula', () => {
  // mapa 1 canal 4×4, valor = índice da célula; entrada 416 → célula de 104 px
  const dados = Float32Array.from({length: 16}, (_, i) => i + 1);
  const m = (caixa) => { const C = 2, dd = new Float32Array(32); dd.set(dados, 0); dd.fill(1, 16); const v = B.mediaNaCaixa(dd, C, 4, 4, caixa, 416); return v[0] / v[1]; };
  const perto = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, a + ' ≠ ' + b);
  perto(m([0, 0, 104, 104]), 1);                    // só a célula (0,0)
  perto(m([104, 104, 312, 312]), (6 + 7 + 10 + 11)/4); // bloco central 2×2
  perto(m([200, 200, 201, 201]), 6);                 // caixa minúscula: uma célula
  perto(m([-50, -50, 2000, 2000]), 8.5);           // fora do quadro: recortada ao mapa inteiro
});

test('banco: assinatura junta P4 e P5 com o mesmo peso e tem norma 1; int8 em base64 ida e volta', () => {
  const p4 = {dados: new Float32Array(2*2*2).fill(3), C: 2, H: 2, W: 2}, p5 = {dados: new Float32Array(3).fill(-1), C: 3, H: 1, W: 1};
  const v = B.assinatura([p4, p5], [0, 0, 416, 416], 416);
  assert.equal(v.length, 5); assert.ok(Math.abs(B.produto(v, v) - 1) < 1e-6);
  assert.ok(Math.abs(v[0] - Math.SQRT1_2/Math.SQRT2) < 1e-6);   // metade da energia em cada parte
  const w = B.decodificarVetor(B.codificarVetor(v), 5);
  assert.ok(B.produto(v, w) > .999);
  assert.throws(() => B.decodificarVetor(B.codificarVetor(v), 6), /tamanho/);
});

test('banco: vizinhos e voto ponderado; abaixo de simMin não há referência parecida', () => {
  const b = B.criarBanco({dim: 8});
  for (let i = 0; i < 3; i++) b.adicionar({classe: 'lixeira', foto: 'lixeira_' + i, origem: 'banco', v: dir(0, 8, .05*i)});
  b.adicionar({classe: 'banco', foto: 'banco_lado', origem: 'banco', v: dir(1)});
  const voto = b.votar(dir(0, 8, .02));
  assert.equal(voto.classe, 'lixeira'); assert.ok(voto.apoio > .99); assert.match(voto.ref.foto, /^lixeira_/);
  assert.equal(b.votar(dir(5)).classe, null);
  assert.throws(() => b.adicionar({classe: 'x', v: new Float32Array(3)}), /dimensão/);
  assert.deepEqual(b.resumo().porClasse, {lixeira: 3, banco: 1});
});

test('banco: reconciliar confirma, corrige o NOME só com folga, recupera objeto do banco e nunca remove a caixa', () => {
  const b = B.criarBanco({dim: 8});
  for (let i = 0; i < 4; i++) b.adicionar({classe: 'lixeira', foto: 'lixeira_' + i, origem: 'banco', v: dir(0, 8, .03*i)});
  const p = (c, s, v) => ({class: c, score: s, bbox: [0, 0, 10, 10], emb: v});
  let r = b.reconciliar(p('lixeira', .9, dir(0)), .6);
  assert.equal(r.banco.situacao, 'confirmado'); assert.equal(r.class, 'lixeira'); assert.equal(r.score, .9);
  r = b.reconciliar(p('banco', .45, dir(0)), .5);           // detector em dúvida, banco certo: troca o nome
  assert.equal(r.banco.situacao, 'nome_corrigido'); assert.equal(r.class, 'lixeira'); assert.equal(r.banco.classeDetector, 'banco');
  r = b.reconciliar(p('banco', .95, dir(0)), .5);           // detector confiante: vale o detector
  assert.equal(r.banco.situacao, 'divergente'); assert.equal(r.class, 'banco');
  r = b.reconciliar(p('lixeira', .4, dir(0)), .6);          // abaixo do limiar, mas é o objeto do banco: conta como detecção
  assert.equal(r.banco.situacao, 'recuperado'); assert.equal(r.score, .6);
  r = b.reconciliar(p('lixeira', .4, dir(3)), .6);          // nada parecido: segue o modelo
  assert.equal(r.banco.situacao, 'sem_referencia_parecida'); assert.equal(r.score, .4);
  r = b.reconciliar({class: 'caixa', score: .8, bbox: [0, 0, 1, 1]}, .6);
  assert.equal(r.banco.situacao, 'sem_assinatura'); assert.equal(r.class, 'caixa');
});

test('banco: arquivo de outro modelo é recusado; classes fora do modelo são ignoradas', () => {
  const v = B.codificarVetor(dir(0));
  const meta = {dim: 8, versao_modelo: 'm1', referencias: [{classe: 'caixa', v}, {classe: 'nave', v}]};
  assert.throws(() => B.validarBanco(meta, {versao: 'm2', classes: ['caixa']}), e => e.codigo === 'banco_outro_modelo');
  assert.equal(B.validarBanco(meta, {versao: 'm1', classes: ['caixa']}).length, 1);
});

test('banco: zip "store" válido (assinaturas, CRC32 conhecido) e linha YOLO normalizada', () => {
  assert.equal(B.crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
  const z = B.zip([{nome: 'labels/a.txt', dados: new TextEncoder().encode('0 0.5 0.5 1 1\n')}]);
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50); assert.equal(dv.getUint32(z.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(z.length - 12, true), 1);
  assert.equal(B.linhaYolo(3, [160, 120, 320, 240], 640, 480), '3 0.500000 0.500000 0.500000 0.500000');
});

test('banco publicado: bate com o modelo publicado (versão, dimensão, classes) e tem miniatura para as fotos (menos pessoas)', () => {
  const raiz = path.join(__dirname, '..', 'modelos', 'fabrica');
  const rot = JSON.parse(fs.readFileSync(path.join(raiz, 'rotulos.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(raiz, 'banco_referencia.json'), 'utf8'));
  assert.deepEqual(rot.caracteristicas, ['p4', 'p5']);
  const refs = B.validarBanco(meta, rot);
  assert.equal(refs.length, meta.referencias.length, 'referência de classe que o modelo não tem');
  for (const r of refs){ assert.equal(B.decodificarVetor(r.v, meta.dim).length, meta.dim); assert.equal(!!r.mini, r.classe !== 'pessoa', r.foto); }
  assert.ok(new Set(refs.map(r => r.classe)).size >= rot.classes.length - 0, 'toda classe do modelo tem referência no banco');
});

// ---- App inteiro com o modelo Fábrica SIMULADO e o banco REAL (js/banco.js): o banco muda o nome falado, recupera e respeita "Só mostrar". ----
const ate = async (cond, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(2); assert.ok(cond(), 'condição não atingida a tempo'); };
const FALAS = {lixeira: {s: 'lixeira', p: 'lixeiras', g: 'f', prio: 2, off: 0}, banco: {s: 'banco', p: 'bancos', g: 'm', prio: 2, off: -0.1}};
function cenario(pred){
  const yolo = {carregar: async () => ({classes: ['lixeira', 'banco'], versao: 'v-banco', conjunto: 'teste', assinaturas: true, provedor: 'mock', falas: FALAS, dispose(){},
    detect: async () => { const p = [Object.assign(d(pred.c, [260, 150, 120, 200], pred.s), {emb: dir(0)})]; p.mapas = [{dados: new Float32Array(8), C: 8, H: 1, W: 1}]; p.geom = {escala: .65, padX: 0, padY: 52, T: 416}; return p; }})};
  const banco = Object.assign({}, B, {carregar: async () => { const b = B.criarBanco({dim: 8}); for (let i = 0; i < 4; i++) b.adicionar({classe: 'lixeira', foto: 'lixeira_frente', mini: 'data:image/jpeg;base64,AA==', origem: 'banco', v: dir(0, 8, .03*i)}); b.meta = {fotos: 4}; return b; },
    local: {abrir: async () => { throw new Error('sem IndexedDB'); }}});
  return {yolo, banco};
}
async function rodar(pred, uso){
  const {yolo, banco} = cenario(pred); globalThis.VisioYolo = yolo;
  try {
    const a = await montar({vals: {modelo: 'fabrica', bancoUso: uso}, visioBanco: banco});
    await a.iniciar(); await ate(() => a.els.bResumo.textContent.startsWith('4 objetos')); await sleep(250);
    a.encerrar(); return a;
  } finally { delete globalThis.VisioYolo; }
}

test('app + banco: detector diz "banco" em dúvida, o banco reconhece a lixeira → fala "Lixeira", painel mostra a foto do banco', async () => {
  const a = await rodar({c: 'banco', s: .55}, 'ligado');
  assert.ok(a.falas.some(t => /Lixeira à frente/.test(t)), a.falas.join(' | '));
  assert.ok(!a.falas.some(t => /Banco à frente/.test(t)));
  assert.match(a.els.bUltimo.textContent, /Parece com lixeira — lixeira_frente .*nome corrigido pelo banco \(modelo: banco\)/);
  assert.equal(a.els.bMini.hidden, false);
});

test('app + banco "Só mostrar": compara e mostra, mas a fala segue o modelo', async () => {
  const a = await rodar({c: 'banco', s: .55}, 'so_mostrar');
  assert.ok(a.falas.some(t => /Banco à frente/.test(t)), a.falas.join(' | '));
  assert.match(a.els.bUltimo.textContent, /Parece com lixeira/);
});

test('app + banco: lixeira com nota abaixo do limiar só é anunciada quando o banco a reconhece', async () => {
  const ligado = await rodar({c: 'lixeira', s: .42}, 'ligado');
  assert.ok(ligado.falas.some(t => /Lixeira à frente/.test(t)), ligado.falas.join(' | '));
  const desligado = await rodar({c: 'lixeira', s: .42}, 'desligado');
  assert.ok(!desligado.falas.some(t => /Lixeira à frente/.test(t)));
});

test('banco: objeto ensinado pela câmera (quase idêntico) impõe o nome escolhido, mesmo com o detector confiante', () => {
  const b = B.criarBanco({dim: 8});
  for (let i = 0; i < 4; i++) b.adicionar({classe: 'banco', foto: 'banco_' + i, origem: 'banco', v: dir(0, 8, .2 + .02*i)});
  b.adicionar({classe: 'lixeira', foto: 'camera', origem: 'camera', v: dir(0)});
  const r = b.reconciliar({class: 'banco', score: .95, bbox: [0, 0, 1, 1], emb: dir(0)}, () => .6);
  assert.equal(r.banco.situacao, 'nome_corrigido'); assert.equal(r.class, 'lixeira'); assert.equal(r.banco.origemRef, 'camera');
});
