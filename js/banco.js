'use strict';
/*
 * Banco de referência: liga as FOTOS do banco da fábrica à detecção ao vivo da câmera.
 *
 * Cada objeto anotado nas fotos do banco (fotos_v1 + fotos_v2) virou uma "assinatura" (vetor de características do próprio YOLO da fábrica,
 * camadas P4 e P5 do pescoço da rede, média dentro da caixa do objeto), gerada por treino/exportar_banco.py e publicada em
 * modelos/fabrica/banco_referencia.json junto com uma miniatura da foto. Ao vivo, cada caixa detectada recebe a mesma assinatura
 * (js/yolo.js) e é comparada com as do banco:
 *   - CONFIRMA: o objeto mais parecido do banco é da mesma classe → o painel mostra a foto do banco que bateu.
 *   - CORRIGE O NOME: o banco discorda com folga (vários vizinhos da outra classe, semelhança alta) e o detector estava em dúvida →
 *     o objeto é falado com o nome do banco. O obstáculo NUNCA some por causa do banco: só o nome muda.
 *   - RECUPERA: caixa com nota abaixo do limiar da classe, mas muito parecida com um objeto do banco da mesma classe → conta como detecção.
 *   - ENSINAR PELA CÂMERA: o usuário guarda a caixa atual (com a classe certa) como referência nova, só neste aparelho (IndexedDB);
 *     ela passa a valer no quadro seguinte, sem retreinar. A foto e o rótulo YOLO também ficam guardados para exportar e retreinar.
 * As assinaturas dependem dos pesos do modelo: um banco gerado com outra versão do modelo é recusado (comparar seria sem sentido).
 * Funções puras testáveis no Node; nada sai do aparelho.
 */
(function(g){
  // Limiares calibrados em treino/conjuntos/banco_unificado/calibracao.json (validação cruzada por objeto nas fotos novas).
  // Podem ser sobrescritos pelo campo "limiares" do banco_referencia.json gerado junto com o modelo.
  const PADRAO = {k:5, simCamera:.9, simMin:.55, simTroca:.75, apoioTroca:.6, notaMaxTroca:.6, simRecupera:.8, apoioRecupera:.8, notaMinRecupera:.15};

  // Média de um mapa de características [C, Hf, Wf] (NCHW sem o lote) dentro da caixa [x1,y1,x2,y2] dada no espaço da ENTRADA do modelo.
  // Toda caixa cobre pelo menos uma célula. Resultado normalizado (norma 1).
  function mediaNaCaixa(dados, C, Hf, Wf, caixa, tamanho){
    const ex = Wf / tamanho, ey = Hf / tamanho;
    let x0 = Math.floor(caixa[0]*ex), y0 = Math.floor(caixa[1]*ey), x1 = Math.ceil(caixa[2]*ex), y1 = Math.ceil(caixa[3]*ey);
    x0 = Math.min(Wf - 1, Math.max(0, x0)); y0 = Math.min(Hf - 1, Math.max(0, y0));
    x1 = Math.min(Wf, Math.max(x0 + 1, x1)); y1 = Math.min(Hf, Math.max(y0 + 1, y1));
    const v = new Float32Array(C), plano = Hf*Wf, n = (x1 - x0)*(y1 - y0);
    for (let c = 0; c < C; c++){
      let s = 0; const base = c*plano;
      for (let y = y0; y < y1; y++){ const lin = base + y*Wf; for (let x = x0; x < x1; x++) s += dados[lin + x]; }
      v[c] = s / n;
    }
    return normalizar(v);
  }
  function normalizar(v){
    let n = 0; for (let i = 0; i < v.length; i++) n += v[i]*v[i];
    n = Math.sqrt(n); if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }
  // Assinatura de uma caixa: P4 e P5 normalizados em separado (pesos iguais) e concatenados. mapas = [{dados, C, H, W}, ...]
  function assinatura(mapas, caixa, tamanho){
    const partes = mapas.map(m => mediaNaCaixa(m.dados, m.C, m.H, m.W, caixa, tamanho));
    const total = partes.reduce((s, p) => s + p.length, 0), v = new Float32Array(total);
    let o = 0; for (const p of partes){ v.set(p, o); o += p.length; }
    return normalizar(v);
  }
  const produto = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]*b[i]; return s; };

  // Vetores do banco vêm quantizados em int8 (valor × 127) e codificados em base64, para o arquivo ficar pequeno.
  function decodificarVetor(b64, dim){
    const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    if (bin.length !== dim) throw new Error('vetor com tamanho ' + bin.length + ', esperado ' + dim);
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++){ const b = bin.charCodeAt(i); v[i] = (b > 127 ? b - 256 : b) / 127; }
    return normalizar(v);
  }
  function codificarVetor(v){
    let s = ''; for (let i = 0; i < v.length; i++){ const q = Math.max(-127, Math.min(127, Math.round(v[i]*127))); s += String.fromCharCode(q < 0 ? q + 256 : q); }
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
  }

  // Confere o arquivo do banco: versão do modelo igual à do rotulos.json, dimensão e classes coerentes.
  function validarBanco(meta, modelo){
    if (!meta || !Array.isArray(meta.referencias) || !Number.isInteger(meta.dim) || meta.dim <= 0) throw new Error('banco de referência inválido');
    if (modelo && meta.versao_modelo !== modelo.versao)
      throw Object.assign(new Error('banco de referência é de outro modelo (' + meta.versao_modelo + ' ≠ ' + modelo.versao + ')'), {codigo:'banco_outro_modelo'});
    const classes = new Set(modelo ? modelo.classes : []);
    return meta.referencias.filter(r => r && typeof r.classe === 'string' && typeof r.v === 'string' && (!modelo || classes.has(r.classe)));
  }

  // Banco em memória. refs: [{classe, foto, v:Float32Array, mini?, origem:'banco'|'camera', id?}]
  function criarBanco(opcoes = {}){
    const lim = Object.assign({}, PADRAO, opcoes.limiares || {});
    let refs = [], dim = opcoes.dim || 0;
    function adicionar(r){
      if (!r || !(r.v instanceof Float32Array) || !r.classe) throw new Error('referência inválida');
      if (dim && r.v.length !== dim) throw new Error('referência com dimensão ' + r.v.length + ', esperado ' + dim);
      dim = r.v.length; refs.push(r); return r;
    }
    function remover(pred){ const n = refs.length; refs = refs.filter(r => !pred(r)); return n - refs.length; }
    // Os k vizinhos mais parecidos, do mais ao menos parecido.
    function vizinhos(v, k = lim.k){
      const melhores = [];
      for (const r of refs){
        const sim = produto(v, r.v);
        if (melhores.length < k || sim > melhores[melhores.length - 1].sim){
          melhores.push({ref:r, sim}); melhores.sort((a, b) => b.sim - a.sim); if (melhores.length > k) melhores.pop();
        }
      }
      return melhores;
    }
    // Voto ponderado pela semelhança entre os vizinhos acima de simMin. apoio = fração do peso que ficou com a classe vencedora.
    function votar(v){
      const viz = vizinhos(v).filter(x => x.sim >= lim.simMin);
      if (!viz.length) return {classe:null, sim:0, apoio:0, ref:null, n:0};
      const peso = new Map(); let total = 0;
      for (const x of viz){ peso.set(x.ref.classe, (peso.get(x.ref.classe) || 0) + x.sim); total += x.sim; }
      let classe = null, maior = -1; for (const [c, p] of peso) if (p > maior){ maior = p; classe = c; }
      const ref = viz.find(x => x.ref.classe === classe);
      return {classe, sim:ref.sim, apoio: maior / total, ref:ref.ref, n:viz.length};
    }
    // Junta a decisão do detector com a do banco para UMA caixa. Nunca remove o objeto.
    //   pred = {class, score, bbox, emb}; limiarDe(classe) = nota mínima que o app exige da classe (número = mesmo limiar para todas).
    function reconciliar(pred, limiarDe){
      const lim_ = typeof limiarDe === 'function' ? limiarDe : () => (Number.isFinite(limiarDe) ? limiarDe : 1);
      const limiarClasse = lim_(pred.class);
      if (!pred.emb || !refs.length) return Object.assign({}, pred, {banco:{situacao:'sem_assinatura'}});
      const voto = votar(pred.emb), b = {situacao:'sem_referencia_parecida', classe:voto.classe, sim:voto.sim, apoio:voto.apoio,
        foto: voto.ref ? voto.ref.foto : '', origemRef: voto.ref ? voto.ref.origem : '', mini: voto.ref ? voto.ref.mini : '', classeDetector: pred.class};
      const saida = Object.assign({}, pred, {banco:b});
      if (!voto.classe) return saida;
      // Referência ensinada pela câmera quase idêntica (o mesmo objeto, visto agora): o nome que o usuário escolheu vale.
      const v1 = vizinhos(pred.emb, 1)[0], ensinado = v1 && v1.ref.origem === 'camera' && v1.sim >= lim.simCamera;
      if (ensinado && v1.ref.classe !== pred.class){
        Object.assign(b, {classe: v1.ref.classe, sim: v1.sim, foto: v1.ref.foto, origemRef: 'camera', mini: v1.ref.mini || '', situacao: 'nome_corrigido'});
        saida.class = v1.ref.classe; const novo = lim_(v1.ref.classe); if (saida.score < novo && pred.score >= limiarClasse) saida.score = novo;
        return saida;
      }
      if (voto.classe === pred.class){
        b.situacao = 'confirmado';
        if (pred.score < limiarClasse && voto.sim >= lim.simRecupera && voto.apoio >= lim.apoioRecupera && pred.score >= lim.notaMinRecupera){
          b.situacao = 'recuperado'; saida.score = Math.max(pred.score, limiarClasse);   // conta como detecção: o banco reconheceu o objeto
        }
        return saida;
      }
      if (voto.sim >= lim.simTroca && voto.apoio >= lim.apoioTroca && pred.score < lim.notaMaxTroca){
        b.situacao = 'nome_corrigido'; saida.class = voto.classe;
        // A caixa que já contava como obstáculo continua contando com o nome novo (o limiar da outra classe pode ser maior).
        const novo = lim_(voto.classe), forte = voto.sim >= lim.simRecupera && voto.apoio >= lim.apoioRecupera;
        if (saida.score < novo && (pred.score >= limiarClasse || forte)) saida.score = novo;
        return saida;
      }
      b.situacao = 'divergente'; return saida;
    }
    return {adicionar, remover, vizinhos, votar, reconciliar, limiares: lim, tamanho: () => refs.length, dim: () => dim,
      resumo(){ const c = {}; for (const r of refs) c[r.classe] = (c[r.classe] || 0) + 1; return {total: refs.length, porClasse: c, daCamera: refs.filter(r => r.origem === 'camera').length}; }};
  }

  // Carrega o banco publicado (fetch) para o modelo já carregado.
  async function carregar(url, modelo){
    const r = await fetch(url + (modelo && modelo.versao ? '?v=' + encodeURIComponent(modelo.versao) : ''), {cache:'no-cache'});
    if (!r.ok) throw Object.assign(new Error('banco de referência ' + r.status), {codigo:'banco_indisponivel'});
    const meta = await r.json();
    const lista = validarBanco(meta, modelo), banco = criarBanco({dim: meta.dim, limiares: meta.limiares});
    for (const x of lista) banco.adicionar({classe:x.classe, foto:x.foto || '', mini:x.mini || '', origem:'banco', v:decodificarVetor(x.v, meta.dim)});
    banco.meta = {versao: meta.versao_banco || '', fotos: meta.fotos || 0, conjunto: meta.conjunto || ''};
    return banco;
  }

  // ---------- Exportação do que foi capturado pela câmera (zip sem compressão, formato YOLO) ----------
  const TAB_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8){ let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = TAB_CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  // arquivos: [{nome, dados: Uint8Array}] → Uint8Array do .zip (método "store", válido para qualquer descompactador).
  function zip(arquivos){
    const enc = new TextEncoder(), partes = [], central = []; let off = 0;
    for (const a of arquivos){
      const nome = enc.encode(a.nome), d = a.dados, crc = crc32(d);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, nome.length, true);
      partes.push(new Uint8Array(h.buffer), nome, d);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, nome.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), nome);
      off += 30 + nome.length + d.length;
    }
    const tamCentral = central.reduce((s, p) => s + p.length, 0), fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arquivos.length, true); fim.setUint16(10, arquivos.length, true);
    fim.setUint32(12, tamCentral, true); fim.setUint32(16, off, true);
    const tudo = [...partes, ...central, new Uint8Array(fim.buffer)], saida = new Uint8Array(tudo.reduce((s, p) => s + p.length, 0));
    let o = 0; for (const p of tudo){ saida.set(p, o); o += p.length; }
    return saida;
  }
  // Linha YOLO (classe cx cy w h normalizados) de uma caixa em pixels do quadro.
  function linhaYolo(indice, bbox, W, H){
    const f = v => Math.min(1, Math.max(0, v)).toFixed(6);
    return indice + ' ' + f((bbox[0] + bbox[2]/2)/W) + ' ' + f((bbox[1] + bbox[3]/2)/H) + ' ' + f(bbox[2]/W) + ' ' + f(bbox[3]/H);
  }

  // ---------- Referências ensinadas pela câmera (IndexedDB, só neste aparelho) ----------
  // Tudo em try/catch: sem IndexedDB (aba anônima, armazenamento bloqueado) o app funciona, só não lembra o que foi ensinado.
  function abrirLocal(nome = 'visioindustria-banco'){
    return new Promise((ok, falha) => {
      try{
        const req = g.indexedDB.open(nome, 1);
        req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('amostras')) db.createObjectStore('amostras', {keyPath:'id', autoIncrement:true}); };
        req.onsuccess = () => ok(req.result); req.onerror = () => falha(req.error);
      }catch(e){ falha(e); }
    });
  }
  function operacao(db, modo, f){
    return new Promise((ok, falha) => {
      const tx = db.transaction('amostras', modo), req = f(tx.objectStore('amostras'));
      tx.oncomplete = () => ok(req.result); tx.onerror = () => falha(tx.error); tx.onabort = () => falha(tx.error);
    });
  }
  const local = {
    abrir: abrirLocal,
    guardar: (db, amostra) => operacao(db, 'readwrite', st => st.add(amostra)),
    listar: db => operacao(db, 'readonly', st => st.getAll()),
    limpar: db => operacao(db, 'readwrite', st => st.clear())
  };

  const api = {PADRAO, mediaNaCaixa, assinatura, normalizar, produto, decodificarVetor, codificarVetor, validarBanco, criarBanco, carregar, crc32, zip, linhaYolo, local};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.VisioBanco = api;
})(typeof window !== 'undefined' ? window : globalThis);
