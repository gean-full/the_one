'use strict';
/*
 * Detector próprio (YOLO nano treinado com as fotos do ambiente) rodando no navegador com ONNX Runtime Web (WebAssembly).
 * Expõe a MESMA interface do COCO-SSD, para o resto do app não mudar:
 *   VisioYolo.carregar({modelo, rotulos, assinatura?}) → Promise<{detect(fonte, maxDet, scoreMin) → [{class, score, bbox:[x,y,w,h], emb?}], dispose(), falas, provedor}>
 *   assinatura(mapas, caixaNaEntrada, tamanho) → Float32Array: com um modelo que exporta características (rotulos.json "caracteristicas"),
 *   cada caixa recebe emb = assinatura dela, usada pelo banco de referência (js/banco.js).
 * - modelo: URL do .onnx exportado pelo Ultralytics (saída [1, 4 + nClasses, N], caixas em cx,cy,w,h no espaço da entrada);
 * - rotulos: URL do JSON {"tamanho":416, "classes":["caixa", ...], "versao":"...", "conjunto":"...", "falas":{...}} gerado junto com o modelo
 *   (ordem = índice da classe; "conjunto" = conjunto de fotos usado no treino, para comparar resultados antes/depois de uma troca de fotos).
 * Uma inferência por vez: se o agendador abandonou um ciclo travado (watchdog) e a anterior ainda roda no Worker, detect() recusa com
 * codigo 'modelo_ocupado' em vez de empilhar uma segunda execução na mesma sessão.
 * A biblioteca vem da cópia local (vendor/onnxruntime-web-1.20.1/), e do jsDelivr só se a cópia não foi publicada. Os dois têm o mesmo hash SRI.
 * Ela só é baixada quando este modelo é escolhido; nenhuma imagem sai do aparelho.
 */
(function(g){
  const ORT_VERSAO = '1.20.1';
  const ORT_SRI = 'sha384-6hgW9I+eQKl5CrHLstudPd4L3E2eTYHm+qNKvf4pI+RZnfBJILOHAiaalHV+trgG';
  const ORT_ORIGENS = ['vendor/onnxruntime-web-1.20.1/', 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSAO + '/dist/'];
  let ortPromessa = null, ortBase = '';

  function script(src){
    return new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = src; s.integrity = ORT_SRI; s.crossOrigin = 'anonymous';
      s.onload = () => g.ort ? ok(g.ort) : falha(new Error('ort ausente'));
      s.onerror = () => { s.remove(); falha(new Error('ort não carregou: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function carregarOrt(){
    if (g.ort) return Promise.resolve(g.ort);
    if (ortPromessa) return ortPromessa;
    ortPromessa = ORT_ORIGENS.reduce((ant, base) => ant.catch(() => script(base + 'ort.wasm.min.js').then(o => { ortBase = base; return o; })), Promise.reject())
      .catch(() => { ortPromessa = null; throw Object.assign(new Error('ort não carregou'),
        {mensagemUsuario:'A biblioteca do modelo da fábrica não foi carregada (pasta vendor/ ausente na publicação e sem internet). Recarregue a página com internet.'}); });
    return ortPromessa;
  }

  // IoU entre caixas [x1,y1,x2,y2]
  function iou(a, b){
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w <= 0 || h <= 0) return 0;
    const i = w*h; return i / ((a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - i);
  }

  // Decodifica a saída do YOLO (formato [4 + nc, N], transposto) e aplica NMS por classe. Puro: testável no Node.
  function decodificar(dados, nc, n, o){
    const cand = [];
    for (let j = 0; j < n; j++){
      let melhor = -1, sc = o.scoreMin;
      for (let c = 0; c < nc; c++){ const v = dados[(4+c)*n + j]; if (v > sc){ sc = v; melhor = c; } }
      if (melhor < 0) continue;
      const cx = dados[j], cy = dados[n+j], w = dados[2*n+j], h = dados[3*n+j];
      // desfaz o letterbox: espaço da entrada → pixels da fonte
      const x1 = (cx - w/2 - o.padX) / o.escala, y1 = (cy - h/2 - o.padY) / o.escala;
      const x2 = (cx + w/2 - o.padX) / o.escala, y2 = (cy + h/2 - o.padY) / o.escala;
      cand.push({c:melhor, s:sc, b:[Math.max(0, x1), Math.max(0, y1), Math.min(o.W, x2), Math.min(o.H, y2)]});
    }
    cand.sort((a, b) => b.s - a.s);
    const fica = [];
    for (const k of cand){
      if (fica.length >= o.maxDet) break;
      if (!fica.some(f => f.c === k.c && iou(f.b, k.b) > (o.iouMax ?? .45))) fica.push(k);
    }
    return fica.map(k => ({class:o.classes[k.c] ?? ('classe_' + k.c), score:k.s, bbox:[k.b[0], k.b[1], k.b[2]-k.b[0], k.b[3]-k.b[1]]}));
  }

  // Confere o arquivo de rótulos antes de usar o modelo: um rotulos.json de outro treino daria nomes trocados aos objetos.
  function validarRotulos(meta){
    if (!meta || !Number.isInteger(meta.tamanho) || meta.tamanho < 32 || meta.tamanho % 32) throw new Error('rótulos do modelo inválidos: tamanho');
    if (!Array.isArray(meta.classes) || !meta.classes.length || meta.classes.some(c => typeof c !== 'string' || !c)) throw new Error('rótulos do modelo inválidos: classes');
    if (new Set(meta.classes).size !== meta.classes.length) throw new Error('rótulos do modelo inválidos: classe repetida');
    return meta;
  }

  async function carregar(op){
    const [ort, meta] = await Promise.all([carregarOrt(),
      fetch(op.rotulos, {cache:'no-cache'}).then(r => { if (!r.ok) throw new Error('rótulos ' + r.status); return r.json(); }).then(validarRotulos)]);
    const T = meta.tamanho, classes = meta.classes;
    ort.env.wasm.wasmPaths = new URL(ortBase, document.baseURI).href;
    // threads exigem isolamento de origem (o GitHub Pages não tem): sem ele, 1 thread.
    ort.env.wasm.numThreads = g.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    // Inferência num Worker (só com a biblioteca local: o Worker precisa ser da mesma origem). A página, os botões e a voz não travam durante a análise.
    ort.env.wasm.proxy = ortBase === ORT_ORIGENS[0] && typeof Worker !== 'undefined';
    // ?v= muda a cada treino (rotulos.json "versao"): o navegador e o service worker nunca misturam o modelo novo com rótulos velhos.
    const url = op.modelo + (meta.versao ? '?v=' + encodeURIComponent(meta.versao) : '');
    const sessao = await ort.InferenceSession.create(url, {executionProviders:['wasm'], graphOptimizationLevel:'all'});
    const nomeEntrada = sessao.inputNames[0], nomeSaida = sessao.outputNames[0];
    // Saídas extras de características (P4/P5 do pescoço da rede, ver treino/exportar_banco.py): com elas cada caixa ganha uma assinatura
    // (pred.emb) que o banco de referência (js/banco.js) compara com as fotos do banco. Modelo sem essas saídas: só detecção, como antes.
    const nomesCarac = Array.isArray(meta.caracteristicas) ? meta.caracteristicas.filter(n => sessao.outputNames.includes(n)) : [];
    const assinar = typeof op.assinatura === 'function' && nomesCarac.length ? op.assinatura : null;
    const tela = document.createElement('canvas'); tela.width = T; tela.height = T;
    const ctx = tela.getContext('2d', {willReadFrequently:true});
    const plano = T*T;
    let livre = false, rodando = false;
    async function rodar(entrada){
      if (rodando) throw Object.assign(new Error('O modelo ainda processa o quadro anterior.'), {codigo:'modelo_ocupado'});
      rodando = true;
      let saida;
      try { saida = await sessao.run({[nomeEntrada]: new ort.Tensor('float32', entrada, [1, 3, T, T])}); }
      finally { rodando = false; }
      const t = saida[nomeSaida];
      if (!t || t.dims.length !== 3 || t.dims[1] - 4 !== classes.length)
        throw Object.assign(new Error('saída do modelo incompatível com os rótulos (' + (t && t.dims) + ' × ' + classes.length + ' classes)'), {codigo:'saida_incompativel'});
      // Mapas de características [1, C, H, W]; um mapa malformado só desliga a assinatura deste quadro (a detecção continua valendo).
      t.mapas = assinar ? nomesCarac.map(n => saida[n]).filter(m => m && m.dims.length === 4 && m.dims[0] === 1)
        .map(m => ({dados:m.data, C:m.dims[1], H:m.dims[2], W:m.dims[3]})) : [];
      if (t.mapas.length !== nomesCarac.length) t.mapas = [];
      return t;
    }
    // Aquecimento: a 1ª inferência do WebAssembly é bem mais lenta (compilação e alocação). Feita aqui, ela não conta como ciclo lento nem dispara o watchdog.
    const t0 = performance.now(); await rodar(new Float32Array(3*plano)); const aquecimentoMs = performance.now() - t0;
    return {
      classes, tamanho: T, versao: meta.versao || '', assinaturas: !!assinar, conjunto: typeof meta.conjunto === 'string' ? meta.conjunto : '', falas: meta.falas || null, metricas: {mAP50: meta.mAP50, mAP50_95: meta.mAP50_95},
      provedor: 'ONNX Runtime ' + ORT_VERSAO + ' wasm' + (ort.env.wasm.proxy ? ' em worker' : '') + ' · ' + ort.env.wasm.numThreads + ' thread(s)' + (ortBase === ORT_ORIGENS[0] ? ' · local' : ' · CDN'),
      aquecimentoMs,
      async detect(fonte, maxDet = 20, scoreMin = .3){
        if (livre) throw Object.assign(new Error('modelo liberado'), {codigo:'modelo_liberado'});
        const W = fonte.videoWidth || fonte.naturalWidth || fonte.width, H = fonte.videoHeight || fonte.naturalHeight || fonte.height;
        if (!W || !H) return [];
        const escala = Math.min(T/W, T/H), w = Math.round(W*escala), h = Math.round(H*escala), padX = (T-w)/2, padY = (T-h)/2;
        ctx.fillStyle = 'rgb(114,114,114)'; ctx.fillRect(0, 0, T, T);
        ctx.drawImage(fonte, padX, padY, w, h);
        const px = ctx.getImageData(0, 0, T, T).data;
        // Buffer novo a cada quadro: com o Worker, o anterior pode ter sido transferido.
        const entrada = new Float32Array(3*plano), k = 1/255;
        for (let i = 0, j = 0; i < plano; i++, j += 4){ entrada[i] = px[j]*k; entrada[plano+i] = px[j+1]*k; entrada[2*plano+i] = px[j+2]*k; }
        const t = await rodar(entrada);
        if (livre) return [];
        const preds = decodificar(t.data, t.dims[1] - 4, t.dims[2], {scoreMin, maxDet, padX, padY, escala, W, H, classes});
        if (assinar && t.mapas.length){
          const t0 = performance.now();
          for (const p of preds){
            const b = p.bbox, caixa = [b[0]*escala + padX, b[1]*escala + padY, (b[0] + b[2])*escala + padX, (b[1] + b[3])*escala + padY];
            try { p.emb = assinar(t.mapas, caixa, T); } catch (e) { /* sem assinatura: o banco não opina sobre esta caixa */ }
          }
          preds.assinaturaMs = performance.now() - t0;
          preds.mapas = t.mapas; preds.geom = {escala, padX, padY, T};    // para assinar outra região do mesmo quadro (ensinar pela câmera)
        }
        return preds;
      },
      dispose(){ livre = true; try { sessao.release && sessao.release(); } catch (e) {} }
    };
  }

  const api = {carregar, decodificar, iou, validarRotulos, ORT_ORIGENS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.VisioYolo = api;
})(typeof window !== 'undefined' ? window : globalThis);
