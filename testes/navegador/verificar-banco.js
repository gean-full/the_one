'use strict';
/*
 * Verificação OPCIONAL num Chromium real (Playwright), fora do `npm test`: banco de fotos + detecção ao vivo juntos.
 * Câmera FALSA do Chromium alimentada por um vídeo .y4m feito de uma foto; modelo REAL da fábrica (com as saídas p4/p5) e banco REAL
 * (modelos/fabrica/banco_referencia.json). Não precisa de internet nem do TensorFlow.js.
 * Valida: banco carregado para a versão do modelo, caixas comparadas com as fotos do banco (texto + miniatura), falas com o nome final,
 * "ensinar pela câmera" (referência nova guardada no IndexedDB e somada ao banco), exportação do .zip, recarga da página mantendo o que
 * foi ensinado, "Só mostrar" e "Desligado", tempo da comparação. Tira capturas de tela.
 *
 *   ffmpeg -loop 1 -i foto.jpg -vf "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2" -t 2 -r 15 -pix_fmt yuv420p camera.y4m
 *   CAMERA=camera.y4m SAIDA=pasta node testes/navegador/verificar-banco.js [classe esperada]
 */
const {chromium} = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const RAIZ = path.join(__dirname, '..', '..'), CAM = process.env.CAMERA, ESPERADA = process.argv[2] || '';
if (!CAM) { console.error('Defina CAMERA (vídeo .y4m, ver o comentário no topo).'); process.exit(2); }
const SAIDA = process.env.SAIDA || path.dirname(CAM);
fs.mkdirSync(SAIDA, {recursive: true});
const TIPOS = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream'};
const servir = () => new Promise(ok => {
  const srv = http.createServer((req, res) => {
    const f = path.join(RAIZ, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache'}); fs.createReadStream(f).pipe(res);
  }).listen(0, '127.0.0.1', () => ok(srv));
});
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FALHA') + ' ' + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const srv = await servir(), base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + CAM]});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, permissions: ['camera'], acceptDownloads: true});
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.abort('internetdisconnected'));     // nada de internet: tudo do modelo Fábrica é local
  await ctx.addInitScript(() => {
    window.__falas = []; window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    if (window.speechSynthesis){ const orig = speechSynthesis.speak.bind(speechSynthesis); speechSynthesis.speak = u => { window.__falas.push(u.text); try { orig(u); } catch (e) {} }; }
  });
  const page = await ctx.newPage(), erros = [];
  page.on('pageerror', e => erros.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  const txt = id => page.textContent('#' + id);
  await page.goto(base + 'visioindustria.html');
  await page.click('#btnIniciar');
  await page.waitForFunction(() => /objetos de referência/.test(document.getElementById('bResumo').textContent), null, {timeout: 60000});
  ok(true, 'banco carregado: ' + await txt('bResumo'));
  await page.waitForFunction(() => /Parece com/.test(document.getElementById('bUltimo').textContent), null, {timeout: 30000});
  await page.waitForTimeout(4000);
  const ult = await txt('bUltimo'), mini = await page.$eval('#bMini', i => ({hidden: i.hidden, w: i.naturalWidth}));
  ok(true, 'comparação ao vivo: ' + ult);
  ok(!mini.hidden && mini.w > 0, 'miniatura da foto do banco exibida (' + mini.w + ' px)');
  ok(/ms por quadro/.test(await txt('bTempo')), 'tempo da comparação: ' + await txt('bTempo') + ' · inferência ' + await txt('mInf'));
  ok(true, 'contagem: ' + await txt('bCont'));
  const falas = await page.evaluate(() => window.__falas.slice());
  ok(falas.length > 1, 'falas: ' + falas.join(' | '));
  if (ESPERADA) ok(falas.some(f => f.toLowerCase().includes(ESPERADA)), 'fala com o objeto esperado (' + ESPERADA + ')');
  await page.screenshot({path: path.join(SAIDA, 'banco-ao-vivo.png'), fullPage: true});
  await page.locator('#painelBanco').screenshot({path: path.join(SAIDA, 'painel-banco.png')});
  await page.locator('#stage').screenshot({path: path.join(SAIDA, 'camera-com-banco.png')});

  // Ensinar pela câmera: guarda o objeto com a classe escolhida (a primeira da lista que não é a detectada, para provar que a escolha vale).
  const antes = await txt('bResumo');
  const classes = await page.$$eval('#bClasse option', os => os.map(o => o.value));
  const alvo = classes.find(c => !ult.includes(c)) || classes[0];
  await page.selectOption('#bClasse', alvo);
  await page.click('#btnEnsinar');
  await page.waitForFunction(() => /ensinados pela câmera/.test(document.getElementById('bResumo').textContent), null, {timeout: 10000});
  ok(true, 'ensinado como "' + alvo + '": ' + await txt('bResumo') + ' (antes: ' + antes + ')');
  await page.waitForTimeout(2500);
  ok(true, 'depois de ensinar: ' + await txt('bUltimo'));
  const [down] = await Promise.all([page.waitForEvent('download', {timeout: 10000}), page.click('#btnExportarBanco')]);
  const zipP = path.join(SAIDA, 'banco_camera.zip'); await down.saveAs(zipP);
  const z = fs.readFileSync(zipP);
  ok(z.readUInt32LE(0) === 0x04034b50 && z.length > 1000, 'zip exportado (' + z.length + ' bytes): ' + (z.toString('latin1').match(/(images|labels)\/[^\s\x00-\x1f]+?\.(jpg|txt)/g) || []).slice(0, 2).join(', '));

  // "Só mostrar" e "Desligado"
  for (const uso of ['so_mostrar', 'desligado']){
    await page.selectOption('#bancoUso', uso); const c0 = await txt('bCont'); await page.waitForTimeout(2000);
    ok(true, 'uso "' + uso + '": contagem ' + c0 + ' → ' + await txt('bCont'));
  }
  await page.selectOption('#bancoUso', 'ligado');
  await page.click('#btnEncerrar');

  // Recarrega: o que foi ensinado continua neste aparelho (IndexedDB)
  await page.reload(); await page.click('#btnIniciar');
  await page.waitForFunction(() => /objetos de referência/.test(document.getElementById('bResumo').textContent), null, {timeout: 60000});
  ok(/ensinados pela câmera/.test(await txt('bResumo')), 'depois de recarregar a página: ' + await txt('bResumo'));
  await page.click('#btnLimparBanco'); await page.waitForTimeout(300);
  ok(!/ensinados pela câmera/.test(await txt('bResumo')), 'apagar o que foi ensinado: ' + await txt('bResumo'));
  await page.click('#btnEncerrar');
  const csp = await page.evaluate(() => window.__csp);
  ok(!csp.length, 'sem violação de CSP ' + csp.join(', '));
  ok(!erros.filter(e => !/jsdelivr|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)).length, 'sem erros na página ' + erros.join(' | '));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
