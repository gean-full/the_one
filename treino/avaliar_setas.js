'use strict';
// Usado por treino/avaliar_setas.py: lê a pasta de quadros RGB crus + indice.json e aplica js/setas.js (o mesmo código do app).
const fs = require('fs'), path = require('path');
const S = require(path.join(__dirname, '..', 'js', 'setas.js'));
const dir = process.argv[2], idx = JSON.parse(fs.readFileSync(path.join(dir, 'indice.json'), 'utf8'));
const c = {certas: 0, erradas: 0, perdidas: 0, alarmes: 0}; let ms = 0;
for (const it of idx){
  const rgb = fs.readFileSync(path.join(dir, it.arq)), W = it.w, H = it.h, px = new Uint8ClampedArray(W*H*4);
  for (let i = 0; i < W*H; i++){ px[4*i] = rgb[3*i]; px[4*i+1] = rgb[3*i+1]; px[4*i+2] = rgb[3*i+2]; px[4*i+3] = 255; }
  const t0 = performance.now(), r = S.detectar(px, W, H); ms += performance.now() - t0;
  const top = r[0], desc = top ? top.direcao + ' (cabeça/haste ' + top.razao.toFixed(2) + ', bico ' + top.bico.toFixed(2) + ', contorno ' + (top.contorno ?? 0).toFixed(2) + ', ' + top.bbox[2] + '×' + top.bbox[3] + ' px)' : 'nenhuma';
  let res;
  if (it.esperado === 'nenhuma'){ res = r.length ? 'ALARME FALSO' : 'ok'; if (r.length) c.alarmes += r.length; }
  else if (!top){ res = 'PERDIDA'; c.perdidas++; }
  else if (top.direcao !== it.esperado){ res = 'ERRADA'; c.erradas++; }
  else { res = 'ok'; c.certas++; if (r.length > 1){ res += ' (+' + (r.length - 1) + ' extra)'; c.alarmes += r.length - 1; } }
  console.log(res.padEnd(13), it.foto, '→', desc);
}
console.log('\n' + JSON.stringify(c) + ' · ' + (ms/idx.length).toFixed(1) + ' ms por quadro');
process.exitCode = c.erradas || c.alarmes ? 1 : 0;
