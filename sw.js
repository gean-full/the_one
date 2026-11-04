'use strict';
/*
 * Service worker do VisioIndústria.
 * - CASCA (HTML, CSS, JS do app, manifesto, ícones): rede primeiro, com versão. Com internet, sempre a versão publicada mais nova;
 *   o cache só responde quando a rede falha. Ao publicar uma versão nova, troque VERSAO: a ativação apaga as cascas antigas.
 * - MODELO DA FÁBRICA (modelos/fabrica/ e a biblioteca local vendor/onnxruntime-web-<versão>/): guardado no PRIMEIRO uso, para o modelo funcionar
 *   sem internet depois disso (ensaio da apresentação com rede, apresentação sem). O .onnx é pedido com ?v=<versão do treino>: a cópia
 *   guardada é usada direto e, quando um treino novo é publicado, a versão muda, a nova é baixada e a antiga é apagada.
 *   A biblioteca tem a versão no nome da pasta e também é usada direto do cache. rotulos.json vai pela rede primeiro (ele diz qual versão do modelo pedir).
 * - Bibliotecas do CDN e pesos do COCO-SSD NÃO passam por aqui (outra origem): esses modelos exigem internet e isso não é escondido.
 * - Nenhuma imagem da câmera passa por fetch.
 */
const VERSAO = 'visioindustria-casca-v6';
const MODELO = 'visioindustria-modelo';   // não depende de VERSAO: trocar a casca não obriga a baixar de novo 20 MB
const CASCA = ['index.html', 'visioindustria.html', 'css/visioindustria.css', 'js/nucleo.js', 'js/yolo.js', 'js/banco.js', 'js/setas.js', 'js/app.js', 'js/pwa.js',
  'manifest.webmanifest', 'icones/icone.svg', 'icones/icone-192.png', 'icones/icone-512.png'];
const PASTAS_MODELO = ['modelos/fabrica/', 'modelos/generico/', 'vendor/'];
const escopo = () => self.registration ? self.registration.scope : self.location.href;
const caminhosCasca = () => new Set(CASCA.map(c => new URL(c, escopo()).pathname));
const ehModelo = p => PASTAS_MODELO.some(d => p.startsWith(new URL(d, escopo()).pathname));

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSAO).then(c => c.addAll(CASCA)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('visioindustria-') && k !== VERSAO && k !== MODELO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
function redePrimeiro(ev, nome){
  const req = ev.request;
  return fetch(req).then(r => {
    if (r && r.ok){ const copia = r.clone(); ev.waitUntil(caches.open(nome).then(c => c.put(req, copia))); }
    return r;
  }).catch(() => caches.open(nome).then(c => c.match(req, {ignoreSearch:true})).then(r => r || Response.error()));
}
// Arquivo versionado (?v= ou pasta com versão): a cópia guardada vale; sem cópia, baixa, guarda e apaga as versões antigas do mesmo arquivo.
function guardadoPrimeiro(ev, url){
  const req = ev.request;
  return caches.open(MODELO).then(c => c.match(req).then(achou => achou || fetch(req).then(r => {
    if (r && r.ok){
      const copia = r.clone();
      ev.waitUntil(c.keys().then(ks => Promise.all(ks.filter(k => new URL(k.url).pathname === url.pathname && k.url !== req.url).map(k => c.delete(k))))
        .then(() => c.put(req, copia)));
    }
    return r;
  })));
}
self.addEventListener('fetch', ev => {
  const req = ev.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // o navegador trata normalmente
  if (caminhosCasca().has(url.pathname)) return ev.respondWith(redePrimeiro(ev, VERSAO));
  if (!ehModelo(url.pathname)) return;
  const versionado = url.searchParams.has('v') || url.pathname.startsWith(new URL('vendor/', escopo()).pathname);
  ev.respondWith(versionado ? guardadoPrimeiro(ev, url) : redePrimeiro(ev, MODELO));
});
