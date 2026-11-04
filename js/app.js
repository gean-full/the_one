'use strict';
/*
 * VisioIndústria: camada de aplicação. Liga a interface, a câmera, o modelo (próprio da fábrica ou COCO-SSD), a voz e o ciclo de vida.
 * Toda a lógica de decisão é PURA e fica em js/nucleo.js (window.VisioNucleo); aqui ficam só os efeitos colaterais.
 * Nada é gravado nem enviado: os quadros ficam na memória do navegador durante a análise.
 */
(() => {
  const $ = id => document.getElementById(id);
  const N = window.VisioNucleo;
  if (!N){ const s = $('status'); if (s) s.textContent = 'Erro: arquivos do aplicativo incompletos (js/nucleo.js não carregou). Recarregue a página.'; return; }
  const {CLASSES, criarAgendador, ladosConfirmados, estadoAnalise, regioesDeMascara, validarFonteExterna, ZTXT, ZONAS, LIM, configurarLimites,
    resolverLados, ladoUsuario, rotulosLados, zonaDe, limiar, avaliarPassagemPorCor, criarEstabilizadorAlt, decidirOrientacao, planejar, planejarSemObjetos,
    atualizarTracks, validarPredicoes, criarCicloDeVida, mensagemErroInicio, registrarClasses, fundirGenericos} = N;
  const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
  // Os arquivos do app carregaram: some o aviso estático de "arquivos ausentes" (ele existe para publicações sem as pastas js/ e css/).
  { const a = $('avisoArquivos'); if (a) a.hidden = true; }
  // Backend do TensorFlow.js ('webgl', 'cpu'…), ou null se a biblioteca não carregou. Lido de window para não depender de variável global solta.
  const backendTf = () => { const t = window.tf; try { return (t && typeof t.getBackend === 'function' && t.getBackend()) || null; } catch (e) { return null; } };

  let modeloAtual = '', modeloEstado = 'nao_carregado', modeloCargaMs = 0, model = null, carga = null, stream = null, provedor = '';
  // Identificação do modelo em uso nos registros exportados: permite comparar resultados de treinos (e conjuntos de fotos) diferentes.
  let versaoModelo = '';
  const origemDeteccao = () => modeloAtual === MODELO_FABRICA.base ? 'yolo-fabrica' + (versaoModelo ? '@' + versaoModelo : '') : 'coco-ssd/' + modeloAtual;
  let voice = null, falhasVoz = 0, audioCtx = null;
  const tracks = new Map();      // chave "nome falado|zona" → estado de estabilização (ver atualizarTracks)
  const metrics = {frames:0, alertas:0, supr:0, falhas:0, rows:[]};
  let falhasSeguidas = 0, avisouFalha = false, ultimoOkEm = 0;
  // Banco de fotos na câmera (ver "Banco de fotos na câmera" abaixo). Declarado aqui: o ciclo de vida já consulta estes valores.
  let bancoRef = null, bancoEstado = 'nao_carregado', bancoMs = null, ultimoQuadro = null, resumoBancoCiclo = '', dbLocal = null;
  // Detector genérico (objetos desconhecidos → "equipamento") e setas da parede (js/setas.js). Ver "Objetos desconhecidos e setas" abaixo.
  let genModel = null, genEstado = 'nao_carregado', genCarga = null, genMs = null, genUltimo = null, genCiclo = 0, setasMs = null, setaPendente = null, extrasProntos = false, ultimaSeta = null;

  const status = t => { $('status').textContent = t; };
  const bind = (id, out, fmt = v => v) => { const e = $(id); const u = () => $(out).textContent = fmt(e.value); e.addEventListener('input', u); u(); };
  bind('conf','confV',v=>v+'%'); bind('persist','persistV'); bind('intervalo','intervaloV'); bind('cool','coolV');
  const cfg = () => ({conf:+$('conf').value/100, persist:+$('persist').value, intervalo:+$('intervalo').value, cool:+$('cool').value*1000});

  // ---------- Ciclo de vida ----------
  // Fonte única da verdade sobre a sessão: os botões, o texto de estado e o agendador derivam daqui.
  const ROTULO_VIDA = {ocioso:'Pronta para iniciar', solicitando_camera:'Aguardando a câmera', carregando_modelo:'Carregando o modelo', ativo:'Assistência ativa',
    pausado:'Assistência pausada', camera_indisponivel:'Câmera indisponível', modelo_indisponivel:'Modelo indisponível'};
  const vida = criarCicloDeVida(() => { atualizarControles(); atualizarEstado(); });
  const emSessao = () => vida.emSessao(), ativo = () => vida.estado() === 'ativo';
  function atualizarControles(){
    const e = vida.estado(), sessao = vida.emSessao(), iniciando = vida.iniciando();
    $('btnIniciar').disabled = sessao || iniciando; $('btnIniciar').textContent = iniciando ? 'Iniciando…' : 'Iniciar assistência';
    $('btnPausar').disabled = !sessao; $('btnPausar').textContent = e === 'pausado' ? 'Retomar' : 'Pausar';
    $('btnEncerrar').disabled = !(sessao || iniciando); $('btnEncerrar').textContent = iniciando ? 'Cancelar' : 'Encerrar';
    // Modelo e câmera só valem no início de uma sessão: bloqueá-los evita a impressão de que a troca teve efeito imediato.
    $('modelo').disabled = sessao || iniciando; $('camSel').disabled = sessao || iniciando;
    mostrarBanco();
  }
  // Selo de estado: texto sempre presente (a cor só reforça). "Inconclusiva" vem da última decisão: dados ausentes, inválidos ou velhos.
  function atualizarEstado(){
    const e = vida.estado(), inconclusiva = e === 'ativo' && ultimaDecisao && ultimaDecisao.decisao === 'analise_insuficiente';
    const el = $('estado'); el.textContent = ROTULO_VIDA[e] + (inconclusiva ? ' · análise inconclusiva' : '');
    if (el.dataset) el.dataset.estado = inconclusiva ? 'inconclusiva' : e;
  }

  // ---------- Áudio ----------
  const temVoz = () => 'speechSynthesis' in window && !!window.speechSynthesis;
  function pickVoice(){
    const vs = speechSynthesis.getVoices();
    voice = vs.find(v => /pt-BR/i.test(v.lang)) || vs.find(v => /^pt/i.test(v.lang)) || null;
    mostrarVoz();
  }
  function mostrarVoz(){
    $('mVoz').textContent = !temVoz() ? 'indisponível neste navegador: os avisos não são falados'
      : (voice ? 'voz ' + voice.lang + (voice.name ? ' (' + voice.name + ')' : '') : 'sem voz em português instalada: usa a voz padrão do sistema')
        + (falhasVoz ? ' · ' + falhasVoz + ' falha(s) de fala' : '');
  }
  if (temVoz()){ pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; } else mostrarVoz();
  // Urgente interrompe o que está sendo falado; o resto nunca forma fila (evita falar direção velha depois que a cena mudou).
  function falar(texto, urgente = false){
    if (!temVoz()) return false;
    if (urgente) speechSynthesis.cancel();
    else if (speechSynthesis.speaking || speechSynthesis.pending) return false;
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = 'pt-BR'; if (voice) u.voice = voice; u.rate = 1.1;
    u.onerror = ev => { if (ev && (ev.error === 'interrupted' || ev.error === 'canceled')) return; falhasVoz++; mostrarVoz(); };
    speechSynthesis.speak(u);
    return true;
  }
  const calarFala = () => { if (temVoz()) speechSynthesis.cancel(); };
  // O AudioContext só pode tocar depois de um gesto do usuário: é criado (ou retomado) nos cliques de Iniciar e Testar áudio, e reaproveitado.
  function prepararAudio(){
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try{ if (!audioCtx) audioCtx = new AC(); if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); }
    catch(e){ audioCtx = null; }
  }
  function bipe(freq = 880, ms = 120){
    if (!audioCtx || audioCtx.state === 'closed') return false;
    try{
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; g.gain.value = .15; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + ms/1000);
      return true;
    }catch(e){ return false; }     // bipe é só reforço da fala: sua falha não pode afetar a análise
  }

  // ---------- Câmera ----------
  async function listarCameras(){
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try{
      const sel = $('camSel'), atual = sel.value;
      const ds = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      sel.innerHTML = '<option value="">Padrão (traseira)</option>';
      ds.forEach((d,i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || ('Câmera ' + (i+1)); sel.appendChild(o); });
      if (atual && ds.some(d => d.deviceId === atual)) sel.value = atual;     // a lista é refeita após a permissão: mantém a câmera escolhida
    }catch(e){ log('Não foi possível listar as câmeras: ' + (e && e.message)); }
  }
  async function abrirCamera(s){
    const id = $('camSel').value;
    const c = {audio:false, video: id ? {deviceId:{exact:id}, width:{ideal:640}, height:{ideal:480}}
                                      : {facingMode:{ideal:'environment'}, width:{ideal:640}, height:{ideal:480}}};
    const st = await navigator.mediaDevices.getUserMedia(c);
    // Encerrado enquanto o navegador pedia permissão: esta câmera não pertence a nenhuma sessão e é liberada na hora.
    if (!vida.vale(s)){ st.getTracks().forEach(t => t.stop()); return; }
    stream = st; video.srcObject = st;
    status('Iniciando a câmera…');
    await video.play();
    if (!vida.vale(s)) return;                       // encerrar() já liberou a câmera
    const trk = st.getVideoTracks()[0];
    trk.addEventListener('ended', () => perderCamera(s, 'A câmera foi desconectada ou bloqueada pelo sistema.'));
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    facing = (trk.getSettings && trk.getSettings().facingMode) || '';
    atualizarLados(); if (ladosAtual().motivo === 'câmera frontal detectada') log('Câmera frontal: lados invertidos automaticamente. Confira no seletor "Lados".');
    listarCameras();
  }
  function fecharCamera(){ camParar(); if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; } video.srcObject = null; }

  // ---------- Modelo ----------
  // TensorFlow.js + COCO-SSD (cerca de 1,5 MB de script) só são baixados quando um modelo COCO-SSD é escolhido: com o modelo da fábrica
  // a página abre mais rápido e funciona sem internet. Versões fixadas e verificadas por SRI, como antes.
  const LIBS_COCO = [
    ['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js', 'sha384-vE8hbVJ4lezako5rlvE7bY0BVzWlFhZncPlckrqNwcUQpVtgbENTgZ8TBbnPjZre'],
    ['https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js', 'sha384-7qLdgfEQyO9ZQi9ArRHigK+IBto4XPk468jAqc+fnsXaZIcMAhQeLwzggRK7aESl']];
  const libCoco = () => typeof cocoSsd !== 'undefined' && cocoSsd ? cocoSsd : window.cocoSsd;
  let libsPromessa = null;
  function carregarLibsCoco(){
    if (libCoco() && typeof libCoco().load === 'function') return Promise.resolve(libCoco());
    const semLib = () => { const r = $('avisoRede'); if (r) r.hidden = false;
      return Object.assign(new Error('cocoSsd ausente'), {mensagemUsuario:'A biblioteca de detecção não foi carregada (sem internet ou bloqueada pela rede). Recarregue a página com internet, ou use o modelo Fábrica, que funciona sem internet.'}); };
    if (!document.head || typeof document.createElement !== 'function') return Promise.reject(semLib());
    if (libsPromessa) return libsPromessa;
    libsPromessa = LIBS_COCO.reduce((ant, [src, sri]) => ant.then(() => new Promise((ok, falha) => {
      const el = document.createElement('script'); el.src = src; el.integrity = sri; el.crossOrigin = 'anonymous';
      el.onload = ok; el.onerror = () => { el.remove(); falha(semLib()); }; document.head.appendChild(el);
    })), Promise.resolve()).then(() => { const c = libCoco(); if (!c || typeof c.load !== 'function') throw semLib(); return c; })
      .catch(e => { libsPromessa = null; throw e; });
    return libsPromessa;
  }
  // Modelo próprio (YOLO nano treinado com as fotos do ambiente; ver treino/README.md). Arquivos na mesma origem, fora da casca do service worker.
  const MODELO_FABRICA = {base:'fabrica', modelo:'modelos/fabrica/yolo-fabrica.onnx', rotulos:'modelos/fabrica/rotulos.json', banco:'modelos/fabrica/banco_referencia.json',
    assinatura: window.VisioBanco ? window.VisioBanco.assinatura : undefined};
  // Detector genérico: YOLO11n do COCO (80 tipos), exportado com treino/exportar_generico.py. Mesmo ONNX Runtime, sem assinaturas.
  const MODELO_GENERICO = {modelo:'modelos/generico/yolo-generico.onnx', rotulos:'modelos/generico/rotulos.json'};
  // Uma carga por modelo-base: pedidos repetidos reaproveitam a mesma promessa. Se a sessão que pediu a carga for encerrada, a carga termina
  // e o modelo fica guardado para a próxima sessão, mas não reativa nada (quem decide é o ciclo de vida). Trocar de base libera o modelo antigo.
  function garantirModelo(base){
    if (model && modeloAtual === base) return Promise.resolve(model);
    if (carga && carga.base === base) return carga.promessa;
    const fabrica = base === MODELO_FABRICA.base;
    if (fabrica && (typeof VisioYolo === 'undefined' || !VisioYolo || typeof VisioYolo.carregar !== 'function'))
      return Promise.reject(Object.assign(new Error('VisioYolo ausente'), {mensagemUsuario:'O módulo do modelo da fábrica não foi carregado. Recarregue a página.'}));
    if (model && typeof model.dispose === 'function'){ try { model.dispose(); } catch (e) { log('Aviso: falha ao liberar o modelo anterior.'); } }
    model = null; modeloAtual = ''; modeloEstado = 'carregando'; atualizarPainel();
    const tc = performance.now();
    const promessa = Promise.resolve().then(() => fabrica ? VisioYolo.carregar(MODELO_FABRICA) : carregarLibsCoco().then(c => c.load({base}))).then(m => {
      if (!carga || carga.promessa !== promessa){ if (m && typeof m.dispose === 'function') m.dispose(); throw new Error('carga substituída'); }
      carga = null; model = m; modeloAtual = base; modeloCargaMs = performance.now() - tc; modeloEstado = 'pronto';
      provedor = fabrica ? (m.provedor || 'ONNX Runtime') + (m.versao ? ' · modelo ' + m.versao : '') + (m.conjunto ? ' · fotos ' + m.conjunto : '') : '';
      versaoModelo = fabrica ? [m.versao, m.conjunto].filter(Boolean).join(' / ') : '';
      if (fabrica && m.falas){ const r = registrarClasses(m.falas); if (r.recusadas.length) log('Aviso: rótulos sem fala válida no modelo: ' + r.recusadas.join(', ') + '.'); }
      if (fabrica && Array.isArray(m.classes)){ const sem = m.classes.filter(c => !CLASSES[c]); if (sem.length) log('Aviso: o modelo tem objetos sem nome falado (ignorados): ' + sem.join(', ') + '.'); }
      atualizarPainel();
      if (fabrica) carregarBanco(m);       // o banco de fotos não bloqueia a assistência: sem ele, só o modelo decide
      if (fabrica) garantirGenerico();     // idem para o detector genérico: sem ele, só as classes da fábrica são avisadas
      return m;
    }, e => {
      if (carga && carga.promessa === promessa){ carga = null; modeloEstado = 'erro'; atualizarPainel(); }
      throw e;
    });
    carga = {base, promessa};
    return promessa;
  }

  // ---------- Fluxo ----------
  async function iniciar(){
    if (ativo()) return pausar();
    if (vida.estado() === 'pausado') return retomar();
    if (vida.iniciando()) return;                     // clique ou tecla repetida durante o início: não abre uma segunda câmera
    prepararAudio();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      return falhaInicio(window.isSecureContext === false ? mensagemErroInicio(null, 'camera', {contextoSeguro:false}) : 'Este navegador não permite acesso à câmera. Abra a página por https ou em localhost.');
    if (!temVoz()) return falhaInicio('Este navegador não tem síntese de voz: os avisos não poderiam ser falados.');
    const s = vida.abrir(); if (!s) return;
    try{
      status('Aguardando permissão da câmera…');
      await abrirCamera(s);
      if (!vida.transitar('carregando_modelo', s)) return;
      status('Carregando o modelo de detecção (na primeira vez é baixado pela internet)…');
      await garantirModelo($('modelo').value);
      if (!vida.transitar('ativo', s)) return;        // encerrado durante a carga: o modelo fica pronto, a sessão não volta
      perfRows.length = 0; limparEvidencias();
      // Sem WebGL o TensorFlow.js cai para a CPU: funciona, mas cada análise demora muito mais. O usuário precisa saber.
      const semAceleracao = modeloAtual !== MODELO_FABRICA.base && backendTf() === 'cpu';
      status('Assistência ativa.' + (semAceleracao ? ' Atenção: sem aceleração gráfica (WebGL) neste aparelho; a análise fica lenta e os avisos chegam atrasados.' : ''));
      if (semAceleracao) log('Aviso: TensorFlow.js rodando na CPU (sem WebGL).');
      falar('Assistência ativada. Os avisos não garantem caminho livre.', true);
      camIniciar(); agendador.iniciar(); iniciarPainel();
    }catch(e){
      if (!vida.vale(s)) return;                      // a sessão já foi encerrada: nada a relatar
      const etapa = vida.estado() === 'carregando_modelo' ? 'modelo' : 'camera';
      vida.transitar(etapa === 'modelo' ? 'modelo_indisponivel' : 'camera_indisponivel', s);
      fecharCamera();
      falhaInicio(mensagemErroInicio(e, etapa, {contextoSeguro: window.isSecureContext}));
    }
  }
  function falhaInicio(msg){
    metrics.falhas++; $('mFa').textContent = metrics.falhas; atualizarPainel();
    status('Erro: ' + msg); log('FALHA ao iniciar — ' + msg);
    falar('Atenção: não foi possível iniciar a análise do ambiente.', true);
  }
  function pausar(motivo){
    if (!vida.transitar('pausado')) return;
    agendador.pausar(); ctx.clearRect(0,0,canvas.width,canvas.height);
    status('Assistência pausada' + (motivo ? ' (' + motivo + ')' : '') + '. Toque em Retomar para continuar.'); falar('Assistência pausada.', true);
  }
  // Ao retomar, a cena pode ser outra: estabilização, alternativas e avisos de ANTES da pausa são evidência velha e não podem orientar nada.
  function limparEvidencias(){ tracks.clear(); estabAlt.reset(); aquecimento = 0; ultimaEscolha = null; ultimaAss = ''; ultimaUrg = ''; vazio = 0; avisouNenhum = false; candCiclos = 0; falhasSeguidas = 0; avisouFalha = false; ultimoErroCodigo = ''; ultimoOkEm = 0; ultimoQuadro = null; genUltimo = null; genCiclo = 0; setaPendente = null; ultimaSeta = null; seguidorSetas.reset(); }
  function retomar(){
    if (!stream || !stream.active) return perderCamera(vida.sessao(), 'A câmera não está mais disponível.');
    if (!vida.transitar('ativo')) return;
    limparEvidencias(); status('Assistência ativa.'); falar('Assistência retomada.', true); agendador.retomar();
  }
  function encerrar(){
    const e = vida.estado(); if (!vida.emSessao() && !vida.iniciando()) return;
    const cancelouInicio = vida.iniciando();
    vida.encerrar(); agendador.parar(); pararPainel(); fecharCamera(); ctx.clearRect(0,0,canvas.width,canvas.height); limparEvidencias();
    calarFala();
    status(cancelouInicio ? 'Início cancelado. Assistência encerrada.' : 'Assistência encerrada.'); falar('Assistência encerrada.', true);
    if (e === 'carregando_modelo') atualizarPainel();
  }
  // Câmera perdida no meio da sessão: para tudo, libera o que restou e avisa uma vez. Nada do que foi visto antes continua valendo.
  function perderCamera(s, msg){
    if (!vida.vale(s) || !vida.emSessao()) return;
    agendador.parar(); pararPainel(); fecharCamera(); ctx.clearRect(0,0,canvas.width,canvas.height); limparEvidencias();
    ultimoErroCodigo = 'camera_indisponivel'; vida.transitar('camera_indisponivel', s);
    metrics.falhas++; $('mFa').textContent = metrics.falhas;
    mostrarOrientacao(decidirOrientacao({modo: modoAtual(), agora: performance.now(), deteccao:{estado:'camera_indisponivel', motivo: msg}}));
    status('Falha: ' + msg + ' Toque em "Iniciar assistência" para tentar de novo.');
    falar('Atenção: a análise da câmera foi interrompida. Pare e aguarde.', true); bipe(300, 400); log('FALHA — ' + msg);
    atualizarPainel();
  }
  function falha(msg, cod){
    metrics.falhas++; $('mFa').textContent = metrics.falhas;
    status('Falha: ' + msg);
    const camera = cod === 'camera_indisponivel' || cod === 'sem_quadros_novos';
    if (!avisouFalha){ avisouFalha = true; falar(camera ? 'Atenção: a análise da câmera foi interrompida. Pare e aguarde.' : 'Atenção: não foi possível avaliar a passagem. Pare e aguarde.', true); bipe(300, 400); log('FALHA — ' + msg); }
  }

  // ---------- Detecção ----------
  // FPS da câmera = quadros novos entregues ao elemento <video> (requestVideoFrameCallback), diferente do FPS efetivo da análise.
  const cam = {frames:0, stamps:[], ultimoAnalisado:0, ativo:false, rvfc:false};
  function camTick(){ if (!cam.ativo) return; cam.frames++; cam.stamps.push(performance.now()); if (cam.stamps.length > 200) cam.stamps.shift(); video.requestVideoFrameCallback(camTick); }
  function camIniciar(){ cam.rvfc = typeof video.requestVideoFrameCallback === 'function'; cam.frames = 0; cam.stamps = []; cam.ultimoAnalisado = 0; cam.ativo = cam.rvfc; if (cam.rvfc) video.requestVideoFrameCallback(camTick); }
  function camParar(){ cam.ativo = false; }
  function camFps(){ if (!cam.rvfc || !cam.ativo) return null; const t = performance.now(); return cam.stamps.filter(x => x > t - 2000).length / 2; }
  // Sem imagem = erro. Sem quadro novo (onde o navegador informa isso) = ciclo ignorado, e erro se durar demais.
  function verificarCamera(){
    if (video.readyState < 2 || !stream || !stream.active) return {erro:'Sem imagem da câmera.'};
    if (cam.rvfc && cam.frames === cam.ultimoAnalisado) return {ignorar:'sem_quadro_novo'};
    return {};
  }

  const perfRows = [];
  const ESTADO_POR_CODIGO = {inferencia_expirada:'inferencia_expirada', modelo_ocupado:'inferencia_expirada', camera_indisponivel:'camera_indisponivel', sem_quadros_novos:'camera_indisponivel'};
  function registrarCiclo(r){
    perfRows.push([new Date().toISOString(), r.ciclo, r.resultado, r.erro || '', r.tempos.deteccao ?? '', r.totalMs, modeloAtual, camFps() ?? '', r.codigo || '', versaoModelo, bancoMs ?? '', genMs ?? '', setasMs ?? '']);
    if (perfRows.length > 3000) perfRows.shift();
  }
  const agendador = criarAgendador({
    now: () => performance.now(), setTimer: (f, ms) => setTimeout(f, ms), clearTimer: t => clearTimeout(t),
    intervalo: () => cfg().intervalo, verificar: verificarCamera, folgaMin: 30, folgaIgnorado: 20, stallMs: 2500, watchdogMs: 15000,
    aoErro: e => {
      const cod = (e && e.codigo) || 'falha_inferencia'; ultimoErroCodigo = cod; estabAlt.reset(); aquecimento = 0; ultimaAss = '';
      mostrarOrientacao(decidirOrientacao({modo: modoAtual(), agora: performance.now(), deteccao:{estado: ESTADO_POR_CODIGO[cod] || 'falha', motivo: e && e.message}}));
      falhasSeguidas++; if (falhasSeguidas >= 3) falha((e && e.message) || 'Erro de processamento.', cod);
    },
    aoCiclo: registrarCiclo
  });
  // Modelo de detecção. Um segmentador entra com agendador.registrar (ver registrarSegmentador) e roda no mesmo ciclo, sem concorrência.
  // O resultado carrega o instante e o identificador do quadro, as dimensões DAQUELE quadro e (se a avaliação de piso estiver ligada) os pixels do MESMO
  // instante, capturados antes de a inferência começar. Assim caixas e pixels descrevem a mesma cena.
  let seqQuadro = 0, ultimoErroCodigo = '';
  agendador.registrar({
    nome:'deteccao', prio:10, pronto: () => model !== null && modeloEstado === 'pronto',
    executar: async () => {
      cam.ultimoAnalisado = cam.frames;
      const tCap = performance.now(), W = video.videoWidth, H = video.videoHeight, quadroId = cam.rvfc ? cam.frames : ++seqQuadro;
      const img = (usaPiso() && !segAtual) ? capturarQuadro() : undefined;
      const setasImg = usoSetas() ? capturarSetas() : undefined;     // mesmo instante das caixas
      const preds = await model.detect(video, 20, 0.3);
      const gen = await detectarGenerico(tCap);
      return {preds, gen, tCap, tConclusao: performance.now(), W, H, quadroId, img, setasImg};
    },
    aoConcluir: r => {
      falhasSeguidas = 0; avisouFalha = false; ultimoErroCodigo = ''; ultimoOkEm = performance.now();
      ultimoQuadro = {preds: r.preds, W: r.W, H: r.H, tCap: r.tCap};
      const conhecidas = aplicarBanco(r.preds);
      const setas = lerSetas(r.setasImg, r.W, r.H);
      if (setas.length) ultimaSeta = {direcao: setas[0].direcaoUsuario, t: performance.now()};
      r.preds = juntarGenericos(conhecidas, r.gen, r.W, r.H, setas);
      desenhar(analisar(r), setas);
      anunciarSeta(setas, r.tCap);
    }
  });

  // ---------- Painel de desempenho ----------
  const ROTULO_ESTADO = {parado:'parado', pronto:'pronto', aguardando_camera:'aguardando a câmera', carregando_modelo:'carregando o modelo…', falha_carregamento:'falha ao carregar o modelo', analisando:'analisando', pausado:'pausado', camera_indisponivel:'câmera indisponível', inferencia_expirada:'inferência expirada', falha_na_analise:'falha na análise'};
  const fms = v => v == null ? '–' : v.toFixed(v < 10 ? 1 : 0) + ' ms';
  const fres = r => r ? fms(r.ultimo) + ' · méd ' + fms(r.media) + ' · p95 ' + fms(r.p95) : '–';
  function atualizarPainel(){
    const s = agendador.snapshot(performance.now()), c = s.tarefas.deteccao || {n:0}, sessao = emSessao();
    $('mModelo').textContent = {nao_carregado:'não carregado', carregando:'carregando…', pronto:'pronto (' + modeloAtual + ')', erro:'erro ao carregar'}[modeloEstado];
    const est = estadoAnalise({modeloEstado, running: sessao, paused: vida.estado() === 'pausado', emCurso:s.emCurso, ultimoErro:ultimoErroCodigo, vida: vida.estado()});
    // Com a sessão ativa, "pronto" significa só "entre duas análises": mostrar "pronto" daria a impressão de que nada está rodando.
    $('mEst').textContent = sessao && est === 'pronto' ? 'em execução (entre análises)' : ROTULO_ESTADO[est];
    $('mExp').textContent = s.expirados;
    const sgm = s.tarefas['segmentacao']; $('mSeg').textContent = sgm && sgm.n ? fres(sgm) + (sgm.adiadas ? ' · adiada ' + sgm.adiadas + '×' : '') : (segReg ? 'registrado, sem medições' : 'nenhum segmentador registrado');
    const be = modeloAtual === MODELO_FABRICA.base ? null : backendTf();
    $('mBackend').textContent = modeloAtual === MODELO_FABRICA.base ? provedor : be ? be + (be === 'cpu' ? ' (sem aceleração gráfica: lento)' : '') + ' (TensorFlow.js)' : '–';
    $('mCarga').textContent = modeloCargaMs ? (modeloCargaMs/1000).toFixed(1) + ' s' : '–';
    $('mInf').textContent = c.n ? fres(c) : '–';
    $('mCic').textContent = fres(s.ciclo);
    $('mFps').textContent = s.fpsEfetivo == null ? '–' : s.fpsEfetivo.toFixed(1) + ' /s';
    const cf = camFps(); $('mCam').textContent = !cam.rvfc && !cam.ativo ? (sessao ? 'indisponível neste navegador' : '–') : (cf == null ? '–' : cf.toFixed(0) + ' /s');
    $('mUlt').textContent = !sessao ? '–' : ultimoOkEm ? ((performance.now() - ultimoOkEm)/1000).toFixed(1) + ' s atrás' : 'nenhum ainda';
    $('mFr').textContent = s.concluidos; $('mIgn').textContent = s.ignorados; $('mIgn').title = JSON.stringify(s.motivos);
    if (extrasProntos) mostrarExtras();
    $('mErr').textContent = s.erros; $('mAtr').textContent = s.acimaIntervalo; $('mDesc').textContent = s.descartados;
  }
  let uiTimer = null;
  function iniciarPainel(){ if (!uiTimer) uiTimer = setInterval(atualizarPainel, 500); atualizarPainel(); }
  function pararPainel(){ clearInterval(uiTimer); uiTimer = null; atualizarPainel(); }
  // Revogar o endereço no mesmo instante do clique cancela o download em alguns navegadores: libera um pouco depois.
  function baixar(nome, csv){
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = nome; a.click(); const h = a.href; setTimeout(() => URL.revokeObjectURL(h), 10000);
  }
  $('btnPerf').onclick = () => {
    const f = v => typeof v === 'number' ? v.toFixed(1).replace('.', ',') : '"' + String(v).replace(/"/g, '""') + '"';
    baixar('visioindustria_desempenho.csv', '﻿hora;ciclo;resultado;erro;inferencia_modelo_ms;ciclo_total_ms;modelo_base;fps_camera;codigo_erro;versao_modelo;banco_ms;generico_ms;setas_ms\n' + perfRows.map(r => r.map(f).join(';')).join('\n'));
  };

  // ---------- Orientação: estado, lados e avaliação de passagem ----------
  let ultimaEscolha = null, aquecimento = 0, facing = '', segAtual = null, segReg = null, profAtual = null, avisouNenhum = false, candCiclos = 0, ultimaDecisao = null, ultimaPassagem = null;
  const estabAlt = criarEstabilizadorAlt();
  const ladosAtual = () => resolverLados($('lados').value || 'auto', facing);
  const modoAtual = () => ({pista:'pista', probabilidade:'probabilidade'})[$('modo').value] || 'padrao';
  const usaPiso = () => modoAtual() !== 'pista' && $('passagem').value === 'ligada';   // heurística de piso: modo padrão e guia por probabilidade
  function atualizarModo(){ $('avisoPista').hidden = modoAtual() !== 'pista'; ultimaEscolha = null; tracks.clear(); estabAlt.reset(); aquecimento = 0; }
  function atualizarLados(){
    const l = ladosAtual(), r = rotulosLados(l.invertido);
    $('rotE').textContent = r[0]; $('rotD').textContent = r[1];
    $('oLados').textContent = (l.invertido ? 'invertidos' : 'normais') + ' (' + l.motivo + ')' + (ladosConfirmados($('lados').value || 'auto', facing) ? '' : ' — NÃO confirmados: escolha "Normal" ou "Invertido" para liberar alternativas laterais');
    tracks.clear(); estabAlt.reset(); aquecimento = 0; ultimaEscolha = null;
  }
  // Entrada para modelos externos (segmentação semântica e profundidade ainda NÃO implementadas). Se um deles fornecer dados, tem precedência
  // sobre a heurística de cor do piso.
  // Entrada validada (validarFonteExterna): exige estado 'ok', origem, tCaptura (mesmo relógio, performance.now()) e resultado completo. O que faltar vira
  // 'incompleto' e a fonte NÃO é combinada com a detecção. A idade conta a partir da CAPTURA, não do recebimento. null remove a fonte.
  function receberSegmentacao(d){ segAtual = d ? Object.assign({}, validarFonteExterna(d), {recebidoEm: performance.now()}) : null; }
  function receberProfundidade(d){ profAtual = d ? Object.assign({}, validarFonteExterna(d), {recebidoEm: performance.now()}) : null; }
  // Estado de cada fonte, sem fingir o que não existe: não há modelo de segmentação semântica nem de profundidade integrado.
  function estadoFontes(){
    const fx = (x, vazio) => x ? {estado:x.estado, origem:x.origem, motivo:x.motivo, tCaptura:x.tCaptura} : {estado:'indisponivel', motivo:vazio};
    return {deteccao:{estado:modeloEstado, modelo:modeloAtual || null},
      segmentacao: Object.assign(fx(segAtual, segReg ? 'segmentador registrado, ainda sem resultado' : 'nenhum modelo de segmentação semântica integrado'), {registrado: !!segReg}), profundidade: fx(profAtual, 'nenhum modelo de profundidade integrado'),
      pisoPorCor:{estado: usaPiso() ? 'heuristica_experimental_ligada' : 'desligada_ou_nao_usada', metodo:'heuristica_cor_piso'}};
  }
  // Captura local de um quadro reduzido (64×48) só na memória, para a heurística de piso. Nada é salvo nem enviado.
  const capC = document.createElement('canvas'); capC.width = 64; capC.height = 48;
  const capX = capC.getContext ? capC.getContext('2d', {willReadFrequently:true}) : null;
  // Nunca lança: uma falha de captura não pode derrubar a inferência do ciclo; vira {erro} e a passagem fica 'falha' (indeterminada).
  function capturarQuadro(){ try{ capX.drawImage(video, 0, 0, 64, 48); const id = capX.getImageData(0, 0, 64, 48); return {data:id.data, w:64, h:48}; }catch(err){ return {erro: err.message || 'falha na captura'}; } }
  // Os pixels (img) são do MESMO instante tCap das caixas (ver tarefa 'deteccao'); W e H são as dimensões desse quadro.
  function medirPassagem(preds, W, H, inv, img, tCap, quadroId){
    const meta = {origem:'heuristica_cor_piso', tCaptura:tCap, quadroId};
    if (!img || img.erro) return Object.assign({estado:'falha', motivo: (img && img.erro) || 'quadro não capturado'}, meta);
    try{
      const caixas = preds.filter(p => p.score >= .3).map(p => ({x:p.bbox[0]/W, y:p.bbox[1]/H, w:p.bbox[2]/W, h:p.bbox[3]/H}));   // qualquer objeto detectado invalida o piso sob ele
      return Object.assign(avaliarPassagemPorCor(img, caixas, inv), meta);
    }catch(err){ return Object.assign({estado:'falha', motivo:err.message}, meta); }
  }
  // Ponto de integração de um segmentador (NENHUM é incluído nesta versão).
  //   c = {origem, executar(video) → {mascara, w, h}, rotulos:{piso:[ids], ignorado?}, confianca, nome?, pronto?(), cadaN?, prio?, timeoutMs?}
  // - Roda como tarefa OPCIONAL do agendador, por padrão ANTES do COCO-SSD no mesmo ciclo, para o instante de captura ficar próximo ao da detecção.
  //   Com cadaN > 1 o resultado é reaproveitado nos ciclos seguintes e a verificação de compatibilidade o rejeita quando passa de LIM.compatMaxMs.
  // - `confianca` é obrigatória: calibração de campo (ver regioesDeMascara). Sem validação em campo, use 0: a segmentação nunca autoriza alternativa.
  // - Qualquer falha ou demora do segmentador vira resultado 'falha'/'inferencia_expirada' DELE; não derruba os alertas de obstáculo. Não há "fallback"
  //   silencioso para a heurística de cor. timeoutMs (padrão 2000, PROVISÓRIO) não cancela a inferência: só deixa de esperá-la.
  function registrarSegmentador(c){
    if (segReg) throw new Error('já existe um segmentador registrado');
    if (!c || typeof c.executar !== 'function' || !c.origem || !c.rotulos || !Array.isArray(c.rotulos.piso) || !c.rotulos.piso.length || !Number.isFinite(c.confianca))
      throw new Error('segmentador inválido: exige executar, origem, rotulos.piso (ids) e confianca (calibração de campo; use 0 se não houver)');
    segReg = {origem: c.origem, nome: c.nome || c.origem};
    const tmo = c.timeoutMs > 0 ? c.timeoutMs : 2000;
    agendador.registrar({nome:'segmentacao', prio: Number.isFinite(c.prio) ? c.prio : 5, cadaN: c.cadaN > 1 ? c.cadaN : 1, opcional:true, pronto: () => !c.pronto || !!c.pronto(),
      executar: async () => {
        const tCaptura = performance.now(), inv = ladosAtual().invertido; let tid;
        try{
          const m = await Promise.race([Promise.resolve(c.executar(video)), new Promise((_, rej) => { tid = setTimeout(() => rej(Object.assign(new Error('segmentação excedeu ' + tmo + ' ms'), {expirado:true})), tmo); })]);
          return Object.assign(regioesDeMascara(m, {piso:c.rotulos.piso, ignorado:c.rotulos.ignorado, invertido:inv, confianca:c.confianca}), {origem:c.origem, tCaptura, tConclusao:performance.now()});
        }catch(err){ return {estado: err && err.expirado ? 'inferencia_expirada' : 'falha', motivo: (err && err.message) || 'falha na segmentação', origem:c.origem, tCaptura}; }
        finally{ clearTimeout(tid); }
      },
      aoConcluir: r => { segAtual = Object.assign(validarFonteExterna(r), {recebidoEm: performance.now()}); }
    });
  }
  const pct = v => v == null ? '–' : Math.round(v*100) + '%';
  function resumoPassagem(sg){
    if (!sg) return 'desligada';
    if (sg.estado !== 'ok') return sg.estado + (sg.motivo ? ' (' + sg.motivo + ')' : '');
    return ['esquerda','frente','direita'].map(z => z[0].toUpperCase() + ' ' + pct(sg.regioes[z].livre) + '/' + pct(sg.regioes[z].continuidade) + '/' + pct(sg.regioes[z].larguraRel)).join(' · ') + ' (livre/contín./largura)';
  }
  function mostrarOrientacao(dec){
    ultimaDecisao = dec;
    $('oDec').textContent = dec.decisao + (dec.evidencias.modo === 'pista_controlada' ? ' [pista experimental]' : '');
    const pb = dec.probabilidades;
    $('oProb').textContent = pb ? ZONAS.map(z => z[0].toUpperCase() + ' ' + Math.round(pb[z]*100) + '%').join(' · ') + (dec.escolha ? ' → ' + dec.escolha + ' (chance ' + dec.nivel + ')' : ' → pedir ajuda')
      : (dec.evidencias.modo === 'probabilidade' ? 'sem dados válidos da detecção' : 'só no modo "Guia por probabilidade"');
    $('oMot').textContent = dec.motivos.join('; ') || '–'; $('oLim').textContent = dec.limitacoes.join('; ') || '–';
    $('oFontes').textContent = 'detecção ' + dec.fontes.deteccao.estado + ' · passagem ' + dec.fontes.segmentacao.estado + ' · profundidade ' + dec.fontes.profundidade.estado;
    $('oReg').textContent = ZONAS.map(z => z[0].toUpperCase() + ': ' + dec.regioes[z].replace(/_/g, ' ')).join(' · ');
    $('oSeg').textContent = dec.evidencias.modo === 'pista_controlada' ? 'não usada no modo pista' : (segAtual || profAtual ? 'dados externos recebidos' : resumoPassagem(ultimaPassagem));
    atualizarEstado();
  }
  window.VisioIndustria = {receberSegmentacao, receberProfundidade, registrarSegmentador, regioesDeMascara, estadoFontes, configurarLimites, decisaoAtual: () => ultimaDecisao, estadoSessao: () => vida.estado()};

  let ultimaAss = '', ultimaUrg = '', ultimoFalado = -Infinity, vazio = 0;   // -Infinity: nada foi falado ainda (independe da origem do relógio)
  function falarOrientacao(plano, texto, urgente, agora, tCap, nomes, decisao){
    if (!falar(texto, urgente)) return false;
    ultimaAss = plano.ass; ultimaUrg = plano.urg; ultimoFalado = agora;
    const lat = performance.now() - tCap;
    metrics.alertas++; $('mAl').textContent = metrics.alertas; $('mLat').textContent = lat.toFixed(0) + ' ms';
    metrics.rows.push([new Date().toISOString(), nomes, lat.toFixed(0), texto, decisao, origemDeteccao(), resumoBancoCiclo]);
    if (metrics.rows.length > 5000) metrics.rows.shift();
    log(texto);
    if (urgente) bipe(660, 100);
    return true;
  }
  // Devolve as predições VÁLIDAS do ciclo (para desenhar) ou null quando o resultado não pode ser usado.
  function analisar(r){
    if (!ativo()) return null;                                       // defesa em profundidade: o agendador já descarta gerações antigas
    const {tCap, W, H, quadroId, img} = r;                           // W/H são do quadro analisado, não do vídeo no momento do alerta
    const c = cfg(), agora = performance.now(), inv = ladosAtual().invertido, modo = modoAtual();
    const lados = {confirmado: ladosConfirmados($('lados').value || 'auto', facing)};
    const meta = {origem:origemDeteccao(), quadroId, tCaptura:tCap, tConclusao:r.tConclusao};
    const v = validarPredicoes(r.preds, W, H);
    // Resultado inválido do modelo, vídeo sem dimensões ou predição malformada: o resultado inteiro é suspeito e não orienta nada.
    if (!Array.isArray(r.preds) || !(W > 0) || !(H > 0) || v.descartadas){
      estabAlt.reset(); ultimaPassagem = null; const dec = decidirOrientacao({modo, agora, lados, deteccao:Object.assign({estado:'incompleto', motivo: v.motivo}, meta)});
      mostrarOrientacao(dec); const pl = planejarSemObjetos(dec);
      if (pl.ass !== ultimaAss && agora - ultimoFalado >= 1500) falarOrientacao(pl, pl.texto, false, agora, tCap, 'análise incompleta', dec.decisao);
      return null;
    }
    const preds = v.validas;
    const grupos = new Map(), candidatos = [];
    for (const p of preds){
      const info = CLASSES[p.class]; if (!info) continue;
      const z = zonaDe(p.bbox, W, inv), area = p.bbox[2]*p.bbox[3]/(W*H);
      if (p.score < limiar(info, c.conf)){ if (area >= LIM.candAreaMin) candidatos.push({z, area, nome:info.s}); continue; }
      const k = info.s+'|'+z, g = grupos.get(k) || {cls:p.class, info, z, n:0, area:0};
      g.n++; g.area = Math.max(g.area, area); grupos.set(k, g);     // todas as detecções entram, não só a de maior prioridade
    }
    aquecimento++;
    const estaveis = atualizarTracks(tracks, grupos, c.persist);
    const pendentes = [...grupos.values()].filter(g => !estaveis.some(t => t.info.s === g.info.s && t.z === g.z)).map(g => ({z:g.z, nome:g.info.s}));
    candCiclos = candidatos.length ? candCiclos + 1 : 0;           // baixa confiança só conta se persistir (evita piscar)
    let seg = null;                                                 // modo padrão: modelo externo tem precedência; senão, a heurística de piso. No modo pista, não é usada.
    if (modo !== 'pista'){ seg = segAtual || (img !== undefined ? medirPassagem(preds, W, H, inv, img, tCap, quadroId) : null); }
    ultimaPassagem = seg;
    const seta = ultimaSeta ? {direcao: ultimaSeta.direcao, idadeMs: agora - ultimaSeta.t} : null;   // seta da parede vista há pouco (guia por probabilidade)
    const dec = decidirOrientacao({modo, agora, lados, ultimaEscolha, seta, grupos: estaveis, pendentes, candidatos: candCiclos >= c.persist ? candidatos : [], deteccao:Object.assign({estado:'ok'}, meta), seg, prof: profAtual, estab: estabAlt});
    mostrarOrientacao(dec); if (dec.escolha) ultimaEscolha = dec.escolha;
    if (estaveis.length || dec.decisao === 'analise_insuficiente') { vazio = 0; avisouNenhum = false; }
    else {
      // Sem objeto: silêncio, exceto UM aviso quando os objetos somem. Nunca é "caminho livre", e o texto diz isso.
      if (++vazio > 8){
        if (ultimaAss !== '' && !avisouNenhum){ const pl = planejarSemObjetos(dec); if (falar(pl.texto, false)){ avisouNenhum = true; log(pl.texto); ultimaAss = ''; ultimaUrg = ''; } }
        else { ultimaAss = ''; ultimaUrg = ''; }
      }
      return preds;
    }
    const plano = estaveis.length ? planejar(estaveis, dec) : planejarSemObjetos(dec), mudou = plano.ass !== ultimaAss;
    if (modo === 'padrao' && aquecimento < LIM.kOn && !plano.urgente) return preds;                // o estabilizador de passagens ainda está confirmando: não fala "sem passagem" cedo demais (alerta urgente não espera)
    if (!mudou && agora - ultimoFalado < c.cool*2){ metrics.supr++; $('mSup').textContent = metrics.supr; return preds; }
    const urgente = plano.urgente && plano.urg !== ultimaUrg;                 // só interrompe a fala quando surge um novo item urgente
    if (mudou && !urgente && agora - ultimoFalado < 1500) return preds;       // evita metralhar mensagens; tenta de novo no próximo ciclo
    const nomes = estaveis.length ? estaveis.map(g => g.info.s+' x'+g.n+' '+g.z).join(' + ') : dec.decisao;
    falarOrientacao(plano, mudou ? plano.texto : plano.curto, urgente, agora, tCap, nomes, dec.decisao);   // repetição por tempo: só o obstáculo
    return preds;
  }

  // Barras na base da imagem, nas posições da IMAGEM: vermelho = obstruída, verde = passagem validada, cinza = não confirmada.
  const corChance = p => p < .3 ? '#3ddc84' : p < .6 ? '#ffd24d' : p <= .9 ? '#ff9f43' : '#ff5a5a';
  function barrasRegioes(){
    const d = ultimaDecisao; if (!d || !canvas.width) return;
    const inv = ladosAtual().invertido, bw = canvas.width/3, hh = Math.max(8, canvas.height*.02);
    if (d.probabilidades){                // guia por probabilidade: cor pela chance de bloqueio, porcentagem e a direção escolhida em destaque
      const hb = Math.max(22, canvas.height*.05); ctx.font = '700 16px system-ui';
      ['esquerda','frente','direita'].forEach((raw, b) => {
        const z = ladoUsuario(raw, inv), p = d.probabilidades[z], x = b*bw + 4, y = canvas.height - hb - 2;
        ctx.fillStyle = corChance(p); ctx.fillRect(x, y, bw - 8, hb);
        if (d.escolha === z){ ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.strokeRect(x + 2, y + 2, bw - 12, hb - 4); }
        ctx.fillStyle = '#000'; ctx.fillText((d.escolha === z ? '➜ ' : '') + Math.round(p*100) + '%', x + 8, y + hb/2 + 6);
      });
      return;
    }
    ['esquerda','frente','direita'].forEach((raw, b) => {
      const z = ladoUsuario(raw, inv);
      ctx.fillStyle = d.bloqueadas.includes(z) ? '#ff5a5a' : (d.passagens.includes(z) ? '#3ddc84' : '#8a8f94');
      ctx.fillRect(b*bw + 4, canvas.height - hh - 2, bw - 8, hh);
    });
  }
  // `preds` já validadas e recortadas ao quadro (validarPredicoes). O rótulo é desenhado no canvas, nunca inserido no DOM.
  function desenhar(preds, setas){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!Array.isArray(preds)) return;
    barrasRegioes();
    ctx.lineWidth = 3; ctx.font = '600 16px system-ui'; const c = cfg();
    const caixa = (bbox, cor, rot, tracejada) => {
      const [x,y,w,h] = bbox;
      ctx.strokeStyle = cor; if (ctx.setLineDash) ctx.setLineDash(tracejada ? [8, 5] : []); ctx.strokeRect(x,y,w,h); if (ctx.setLineDash) ctx.setLineDash([]);
      const ty = y >= 22 ? y - 22 : y;   // rótulo dentro do quadro quando a caixa encosta no topo
      ctx.fillStyle = cor; ctx.fillRect(x, ty, ctx.measureText(rot).width + 10, 22);
      ctx.fillStyle = '#000'; ctx.fillText(rot, x+5, ty+17);
    };
    for (const p of preds){
      const info = CLASSES[p.class]; if (!info || p.score < limiar(info, c.conf)) continue;
      // caixa do detector genérico: tracejada e azul (pessoa genérica continua vermelha: é prioridade)
      const cor = info.prio >= 3 ? '#ff5a5a' : (p.generico ? '#4dd0ff' : '#ffc14d');
      caixa(p.bbox, cor, info.s + ' ' + Math.round(p.score*100) + '%' + (p.generico ? ' · genérico' : (SUFIXO_BANCO[p.banco && p.banco.situacao] || '')), !!p.generico);
    }
    for (const s of setas || []) caixa(s.bbox, '#3ddc84', 'seta ' + (s.direcaoUsuario === 'esquerda' ? '← esquerda' : 'direita →'), false);
  }

  // ---------- Banco de fotos na câmera (js/banco.js) ----------
  // O banco é carregado junto com o modelo Fábrica e só vale para ele (as assinaturas vêm das camadas internas desse modelo).
  // Cada caixa detectada é comparada com os objetos das fotos do banco e com o que foi ensinado pela câmera neste aparelho.
  const VB = window.VisioBanco;
  const SUFIXO_BANCO = {confirmado:' · banco ✓', nome_corrigido:' · nome do banco', recuperado:' · achado pelo banco'};
  const contBanco = {confirmado:0, nome_corrigido:0, recuperado:0, divergente:0};
  const usoBanco = () => $('bancoUso').value;
  async function carregarBanco(m){
    bancoRef = null; preencherClassesBanco(m);
    if (!VB || !m.assinaturas){ bancoEstado = m.assinaturas ? 'sem_modulo' : 'modelo_sem_assinaturas'; mostrarBanco(); return; }
    bancoEstado = 'carregando'; mostrarBanco();
    try{
      const b = await VB.carregar(MODELO_FABRICA.banco, m);
      if (model !== m) return;                         // o modelo foi trocado durante a carga
      bancoRef = b; bancoEstado = 'pronto';
      await carregarEnsinados(m);
    }catch(e){
      bancoEstado = 'erro'; log('Aviso: banco de fotos indisponível (' + ((e && e.message) || 'erro') + '). A detecção continua só com o modelo.');
    }
    mostrarBanco();
  }
  function preencherClassesBanco(m){
    const sel = $('bClasse'); sel.innerHTML = '';
    for (const c of (m && m.classes) || []){ const o = document.createElement('option'); o.value = c; o.textContent = (CLASSES[c] && CLASSES[c].s) || c; sel.appendChild(o); }
    sel.disabled = !((m && m.classes) || []).length;
  }
  // Referências ensinadas pela câmera: guardadas no IndexedDB deste aparelho, valem só para a mesma versão do modelo.
  async function carregarEnsinados(m){
    try{
      dbLocal = dbLocal || await VB.local.abrir();
      const lista = await VB.local.listar(dbLocal);
      for (const a of lista) if (a.versaoModelo === m.versao && a.v) bancoRef.adicionar({classe:a.classe, foto:a.foto, mini:a.mini, origem:'camera', v:VB.decodificarVetor(a.v, bancoRef.dim())});
    }catch(e){ dbLocal = null; log('Aviso: este navegador não guarda o que foi ensinado pela câmera (armazenamento local indisponível).'); }
  }
  // Junta o parecer do banco às predições do ciclo. "Só mostrar" guarda o parecer sem mudar classe nem nota.
  function aplicarBanco(preds){
    resumoBancoCiclo = ''; bancoMs = null;
    if (!bancoRef || modeloAtual !== MODELO_FABRICA.base || usoBanco() === 'desligado' || !Array.isArray(preds)) return preds;
    const t0 = performance.now(), c = cfg(), so = usoBanco() === 'so_mostrar', partes = [];
    let melhor = null;
    const saida = preds.map(p => {
      if (!p || !p.emb) return p;
      const r = bancoRef.reconciliar(p, cl => CLASSES[cl] ? limiar(CLASSES[cl], c.conf) : 1), b = r.banco;
      if (contBanco[b.situacao] !== undefined) contBanco[b.situacao]++;
      if (b.classe && (!melhor || p.bbox[2]*p.bbox[3] > melhor.area)) melhor = {area: p.bbox[2]*p.bbox[3], b};
      if (b.situacao !== 'sem_referencia_parecida') partes.push(b.classeDetector + '→' + b.situacao + (b.classe !== b.classeDetector ? ':' + b.classe : '') + ' ' + b.sim.toFixed(2));
      return so ? Object.assign({}, p, {banco: b}) : r;
    });
    bancoMs = (preds.assinaturaMs || 0) + performance.now() - t0;
    resumoBancoCiclo = partes.join(' + ');
    if (melhor) mostrarParecido(melhor.b);
    $('bCont').textContent = contBanco.confirmado + ' · ' + contBanco.nome_corrigido + ' · ' + contBanco.recuperado + ' · ' + contBanco.divergente;
    $('bTempo').textContent = bancoMs.toFixed(1) + ' ms por quadro';
    return saida;
  }
  const TXT_SITUACAO = {confirmado:'confirmado', nome_corrigido:'nome corrigido pelo banco', recuperado:'reconhecido pelo banco (o modelo estava em dúvida)', divergente:'banco discorda, vale o modelo', sem_referencia_parecida:'nada parecido no banco'};
  function mostrarParecido(b){
    const nome = c => (CLASSES[c] && CLASSES[c].s) || c, img = $('bMini');
    $('bUltimo').textContent = 'Parece com ' + nome(b.classe) + ' — ' + (b.foto || 'foto do banco') + (b.origemRef === 'camera' ? ' (ensinado pela câmera)' : '') +
      ' · semelhança ' + b.sim.toFixed(2).replace('.', ',') + ' · ' + (TXT_SITUACAO[b.situacao] || b.situacao) + (b.classe !== b.classeDetector ? ' (modelo: ' + nome(b.classeDetector) + ')' : '');
    if (b.mini){ if (img.src !== b.mini) img.src = b.mini; img.alt = 'Foto do banco: ' + (b.foto || nome(b.classe)); img.hidden = false; } else img.hidden = true;
  }
  function mostrarBanco(){
    const t = {nao_carregado:'não carregado', carregando:'carregando…', erro:'indisponível (só o modelo decide)', modelo_sem_assinaturas:'este modelo não gera assinaturas (exporte com treino/exportar_banco.py)', sem_modulo:'módulo js/banco.js ausente'}[bancoEstado];
    if (bancoEstado === 'pronto'){
      const r = bancoRef.resumo(), nome = c => (CLASSES[c] && CLASSES[c].p) || c;
      $('bResumo').textContent = r.total + ' objetos de referência' + (bancoRef.meta && bancoRef.meta.fotos ? ' de ' + bancoRef.meta.fotos + ' fotos' : '') + (r.daCamera ? ' (' + r.daCamera + ' ensinados pela câmera)' : '') +
        ' · ' + Object.entries(r.porClasse).map(([c, n]) => nome(c) + ' ' + n).join(', ');
    } else $('bResumo').textContent = t;
    const ok = bancoEstado === 'pronto';
    $('btnEnsinar').disabled = !ok || !ativo(); $('btnExportarBanco').disabled = !ok || !dbLocal; $('btnLimparBanco').disabled = !ok || !dbLocal;
  }
  // Ensinar: a maior caixa do último quadro analisado (até 1 s atrás) ou, sem caixa, o centro da imagem. A classe é a escolhida pelo usuário.
  async function ensinar(){
    if (!bancoRef || !ativo() || !model || !model.assinaturas) return;
    const q = ultimoQuadro, classe = $('bClasse').value;
    if (!q || !Array.isArray(q.preds) || performance.now() - q.tCap > 1000 || !q.preds.mapas || !q.preds.mapas.length)
      return status('Ainda não há um quadro analisado recente. Aponte para o objeto e tente de novo.');
    const W = q.W, H = q.H, g = q.preds.geom;
    const maior = q.preds.filter(p => p.emb).sort((a, b) => b.bbox[2]*b.bbox[3] - a.bbox[2]*a.bbox[3])[0];
    const bbox = maior ? maior.bbox : [W*.25, H*.15, W*.5, H*.7];
    const v = maior ? maior.emb : VB.assinatura(q.preds.mapas, [bbox[0]*g.escala + g.padX, bbox[1]*g.escala + g.padY, (bbox[0]+bbox[2])*g.escala + g.padX, (bbox[1]+bbox[3])*g.escala + g.padY], g.T);
    // Foto do quadro atual (para exportar) e miniatura do objeto (para o painel). Ficam só neste aparelho.
    const tela = document.createElement('canvas'); tela.width = W; tela.height = H; tela.getContext('2d').drawImage(video, 0, 0, W, H);
    const mini = document.createElement('canvas'); mini.width = 96; mini.height = 96;
    mini.getContext('2d').drawImage(tela, bbox[0], bbox[1], bbox[2], bbox[3], 0, 0, 96, 96);
    const miniUrl = mini.toDataURL('image/jpeg', .8), foto = 'camera ' + new Date().toLocaleString('pt-BR');
    bancoRef.adicionar({classe, foto, mini: miniUrl, origem:'camera', v});
    const nome = (CLASSES[classe] && CLASSES[classe].s) || classe;
    log('Banco: ' + nome + ' ensinado pela câmera' + (maior ? '' : ' (nenhuma caixa detectada: usado o centro da imagem)') + (maior && maior.class !== classe ? '; o modelo dizia ' + ((CLASSES[maior.class] && CLASSES[maior.class].s) || maior.class) : '') + '.');
    status('Objeto guardado no banco deste aparelho como ' + nome + '.');
    try{
      dbLocal = dbLocal || await VB.local.abrir();
      const jpg = await new Promise(ok => tela.toBlob(ok, 'image/jpeg', .9));
      await VB.local.guardar(dbLocal, {classe, foto, mini: miniUrl, v: VB.codificarVetor(v), versaoModelo: model.versao, quando: new Date().toISOString(),
        jpg, W, H, linha: VB.linhaYolo(model.classes.indexOf(classe), bbox, W, H), caixaDoModelo: !!maior});
    }catch(e){ log('Aviso: o objeto vale só até fechar a página (armazenamento local indisponível).'); }
    mostrarBanco();
  }
  async function exportarEnsinados(){
    try{
      const lista = await VB.local.listar(dbLocal), enc = new TextEncoder(), arq = [];
      if (!lista.length) return status('Nada foi ensinado pela câmera neste aparelho ainda.');
      const classes = model && model.classes ? model.classes : [];
      for (const a of lista){
        const nome = 'camera_' + String(a.id).padStart(4, '0') + '_' + a.classe;
        if (a.jpg) arq.push({nome: 'images/' + nome + '.jpg', dados: new Uint8Array(await a.jpg.arrayBuffer())});
        arq.push({nome: 'labels/' + nome + '.txt', dados: enc.encode(a.linha + '\n')});
      }
      arq.push({nome: 'classes.txt', dados: enc.encode(classes.join('\n') + '\n')});
      arq.push({nome: 'LEIAME.txt', dados: enc.encode('Fotos ensinadas pela câmera do VisioIndústria (modelo ' + (model ? model.versao : '?') + '). Formato YOLO, mesma ordem de classes de classes.txt.\n' +
        'A caixa é a do modelo (ou o centro da imagem quando nada foi detectado): confira no https://www.makesense.ai antes de treinar.\n' +
        'Para retreinar: python treino/banco_unificado.py ... --camera ESTE_ZIP (ver treino/README.md).\n')});
      const blob = new Blob([VB.zip(arq)], {type:'application/zip'}), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'visioindustria_banco_camera.zip'; a.click(); const h = a.href; setTimeout(() => URL.revokeObjectURL(h), 10000);
      status(lista.length + ' foto(s) exportada(s).');
    }catch(e){ status('Não foi possível exportar: ' + ((e && e.message) || 'erro')); }
  }
  async function limparEnsinados(){
    try{ await VB.local.limpar(dbLocal); }catch(e){}
    if (bancoRef) bancoRef.remover(r => r.origem === 'camera');
    log('Banco: objetos ensinados pela câmera apagados deste aparelho.'); mostrarBanco();
  }
  $('btnEnsinar').onclick = ensinar; $('btnExportarBanco').onclick = exportarEnsinados; $('btnLimparBanco').onclick = limparEnsinados;
  $('bancoUso').addEventListener('change', () => { tracks.clear(); estabAlt.reset(); aquecimento = 0; });

  // ---------- Objetos desconhecidos (detector genérico) e setas da parede ----------
  // Os dois são extras: falha, demora ou ausência deles nunca derruba a detecção da fábrica nem os avisos de obstáculo.
  const usoGenerico = () => { const v = $('generico').value; return v === 'ligado' || v === 'economico' ? v : 'desligado'; };
  const usoSetas = () => $('setas').value === 'ligado' && !!window.VisioSetas;
  const contGen = {novos:0, sobre:0};
  function garantirGenerico(){
    if (genModel || genCarga || usoGenerico() === 'desligado' || modeloAtual !== MODELO_FABRICA.base) return genCarga;
    if (typeof VisioYolo === 'undefined' || !VisioYolo || typeof VisioYolo.carregar !== 'function'){ genEstado = 'erro'; mostrarExtras(); return null; }
    genEstado = 'carregando'; mostrarExtras();
    const t0 = performance.now();
    genCarga = Promise.resolve().then(() => VisioYolo.carregar(MODELO_GENERICO)).then(m => {
      genCarga = null; genModel = m; genEstado = 'pronto';
      log('Detector genérico pronto em ' + ((performance.now() - t0)/1000).toFixed(1) + ' s (' + (m.classes ? m.classes.length : '?') + ' tipos de objeto' + (m.versao ? ', ' + m.versao : '') + ').');
      mostrarExtras(); return m;
    }, e => {
      genCarga = null; genEstado = 'erro'; mostrarExtras();
      log('Aviso: detector genérico indisponível (' + ((e && e.message) || 'erro') + '). Só as classes da fábrica são avisadas.');
      return null;
    });
    return genCarga;
  }
  // Roda dentro da tarefa de detecção, depois do modelo da fábrica (o ONNX Runtime faz uma inferência por vez).
  // Econômico: só nos ciclos pares; nos ímpares reaproveita o resultado anterior, se tiver menos de 800 ms.
  async function detectarGenerico(tCap){
    const uso = usoGenerico();
    if (uso === 'desligado' || !genModel || modeloAtual !== MODELO_FABRICA.base) return null;
    genCiclo++;
    if (uso === 'economico' && genCiclo % 2 === 0 && genUltimo && tCap - genUltimo.tCap < 800) return genUltimo.preds;
    const t0 = performance.now();
    try{
      const p = await genModel.detect(video, 20, N.GEN.notaMin);
      genMs = performance.now() - t0; genUltimo = {preds: p, tCap};
      return p;
    }catch(e){ genMs = null; genUltimo = null; return null; }     // ocupado, liberado ou falhou: este quadro fica só com a fábrica
  }
  function juntarGenericos(conhecidas, gen, W, H, setas){
    if (!Array.isArray(conhecidas) || !Array.isArray(gen) || !gen.length) return conhecidas;
    const c = cfg();
    const fica = fundirGenericos(conhecidas, gen, W, H, {setas: (setas || []).map(s => s.bbox),
      anunciavel: p => !!CLASSES[p.class] && Number.isFinite(p.score) && p.score >= limiar(CLASSES[p.class], c.conf)});
    contGen.novos += fica.length; contGen.sobre += gen.filter(p => p && p.score >= N.GEN.notaMin).length - fica.length;
    return fica.length ? conhecidas.concat(fica) : conhecidas;
  }
  // Setas: cópia pequena do quadro (lado maior 320 px), lida por cor e forma (js/setas.js). Nunca lança.
  const setC = document.createElement('canvas'), setX = setC.getContext ? setC.getContext('2d', {willReadFrequently:true}) : null;
  function capturarSetas(){
    try{
      const W = video.videoWidth, H = video.videoHeight; if (!W || !H || !setX) return undefined;
      const k = 320/Math.max(W, H), w = Math.round(W*k), h = Math.round(H*k);
      if (setC.width !== w || setC.height !== h){ setC.width = w; setC.height = h; }
      setX.drawImage(video, 0, 0, w, h); const id = setX.getImageData(0, 0, w, h);
      return id && id.data ? {data: id.data, w, h} : undefined;
    }catch(e){ return undefined; }
  }
  const seguidorSetas = window.VisioSetas ? window.VisioSetas.criarSeguidorSetas({persist: 2, esquecerMs: 6000}) : {atualizar: () => null, reset(){}};
  function lerSetas(img, W, H){
    setasMs = null;
    if (!img || !usoSetas()) return [];
    const t0 = performance.now();
    try{
      const inv = ladosAtual().invertido, kx = W/img.w, ky = H/img.h;
      const r = window.VisioSetas.detectar(img.data, img.w, img.h).map(s => Object.assign(s, {
        bbox: [s.bbox[0]*kx, s.bbox[1]*ky, s.bbox[2]*kx, s.bbox[3]*ky],
        direcaoUsuario: ladoUsuario(s.direcao, inv)}));        // imagem espelhada (câmera frontal): a seta da imagem aponta para o outro lado
      setasMs = performance.now() - t0;
      return r;
    }catch(e){ return []; }
  }
  // Uma fala por seta. Não interrompe aviso de obstáculo: se a voz está ocupada, tenta de novo nos próximos ciclos (até 3 s).
  function anunciarSeta(setas, tCap){
    if (!ativo()) return;
    const agora = performance.now(), maior = setas && setas[0];
    const a = seguidorSetas.atualizar(maior ? {direcao: maior.direcaoUsuario} : null, agora);
    if (maior) $('sUltima').textContent = 'seta para a ' + maior.direcaoUsuario + ' (forma ' + maior.razao.toFixed(1).replace('.', ',') + '×)';
    if (setasMs != null) $('sTempo').textContent = setasMs.toFixed(1) + ' ms por quadro';
    if (a) setaPendente = {texto: a.texto, direcao: a.direcao, ate: agora + 3000, tCap};
    if (!setaPendente) return;
    if (agora > setaPendente.ate){ log('Seta para a ' + setaPendente.direcao + ' vista, mas a voz estava ocupada.'); setaPendente = null; return; }
    if (falar(setaPendente.texto, false)){
      metrics.alertas++; $('mAl').textContent = metrics.alertas;
      metrics.rows.push([new Date().toISOString(), 'seta ' + setaPendente.direcao, (agora - setaPendente.tCap).toFixed(0), setaPendente.texto, 'seta', origemDeteccao(), '']);
      log(setaPendente.texto); bipe(520, 80); setaPendente = null;
    }
  }
  function mostrarExtras(){
    const t = {nao_carregado:'não carregado', carregando:'carregando…', pronto: genModel ? 'pronto (' + ((genModel.classes || []).length) + ' tipos' + (genModel.versao ? ' · ' + genModel.versao : '') + ')' : 'pronto',
      erro:'indisponível (só as classes da fábrica)'}[genEstado] || genEstado;
    $('gEstado').textContent = usoGenerico() === 'desligado' ? 'desligado' : t;
    $('gTempo').textContent = genMs == null ? '–' : genMs.toFixed(0) + ' ms por inferência' + (usoGenerico() === 'economico' ? ' (a cada 2 quadros)' : '');
    $('gCont').textContent = contGen.novos + ' · ' + contGen.sobre;
    if (!usoSetas()) $('sUltima').textContent = window.VisioSetas ? 'desligado' : 'módulo js/setas.js ausente';
  }
  $('generico').addEventListener('change', () => { tracks.clear(); genUltimo = null; if (usoGenerico() !== 'desligado') garantirGenerico(); mostrarExtras(); });
  $('setas').addEventListener('change', () => { seguidorSetas.reset(); setaPendente = null; mostrarExtras(); });
  extrasProntos = true; mostrarExtras();

  // ---------- Registro / métricas ----------
  function log(t){
    const li = document.createElement('li'); li.textContent = new Date().toLocaleTimeString('pt-BR') + ' — ' + t;
    $('log').prepend(li); while ($('log').children.length > 50) $('log').lastChild.remove();
  }
  $('btnCsv').onclick = () => {
    const cel = v => '"' + String(v).replace(/"/g, '""') + '"';
    baixar('visioindustria_metricas.csv', '﻿hora;objetos_e_zonas;latencia_ms;mensagem;decisao;modelo;banco\n' + metrics.rows.map(r => r.map(cel).join(';')).join('\n'));
  };

  // ---------- Controles ----------
  $('btnIniciar').onclick = iniciar;
  $('btnPausar').onclick = () => vida.estado() === 'pausado' ? retomar() : pausar();
  $('btnEncerrar').onclick = encerrar;
  $('btnTeste').onclick = () => {
    prepararAudio(); const tocou = bipe();
    if (!temVoz()) return status('Síntese de voz indisponível neste navegador: os avisos não podem ser falados.' + (tocou ? ' O bipe funciona.' : ''));
    falar('Teste de áudio. Atenção: possível obstáculo à frente.', true);
  };
  // Atalhos: Espaço inicia, pausa ou retoma; Esc encerra (ou cancela o início). Ignorados enquanto o foco está num controle de formulário,
  // e Espaço também sobre um botão (ali ele já aciona o próprio botão; tratar os dois duplicaria a ação).
  const CAMPOS = new Set(['SELECT', 'INPUT', 'TEXTAREA', 'OPTION']);
  document.addEventListener('keydown', e => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target || {}, tag = t.tagName;
    if (CAMPOS.has(tag) || t.isContentEditable) return;
    if (e.code === 'Space'){ if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A') return; e.preventDefault(); iniciar(); }
    else if (e.code === 'Escape') encerrar();
  });
  // Página em segundo plano (aba trocada, tela bloqueada): o navegador pode congelar a câmera e os timers. Pausa e exige retomada explícita,
  // que descarta as evidências anteriores.
  document.addEventListener('visibilitychange', () => { if (document.hidden && ativo()) pausar('página em segundo plano'); });
  video.addEventListener('resize', () => { if (video.videoWidth > 0 && video.videoHeight > 0){ canvas.width = video.videoWidth; canvas.height = video.videoHeight; } });   // rotação do aparelho
  $('lados').addEventListener('change', atualizarLados); atualizarLados();
  $('modo').addEventListener('change', atualizarModo); atualizarModo();
  atualizarControles(); atualizarEstado(); atualizarPainel();
})();
