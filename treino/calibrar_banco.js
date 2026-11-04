'use strict';
/*
 * Calibra os limiares do banco de referência (js/banco.js) com a validação cruzada por objeto (treino/exportar_banco.py consultas).
 * Usa o MESMO código do app (criarBanco/reconciliar) e o limiar por classe do núcleo (conf + off da fala).
 *
 *   node treino/calibrar_banco.js consultas-a.json consultas-b.json [--conf 0.6] [--saida treino/conjuntos/banco_unificado/calibracao.json]
 *
 * Para cada combinação de limiares, conta nas fotos de validação (objetos que o modelo da dobra nunca viu):
 *   certos  = objeto da foto contado como detecção com o nome certo
 *   errados = contado com o nome errado (o aviso falado diria outro objeto)
 *   falsos  = detecção contada sem objeto anotado ali (alarme falso)
 *   perdidos = objeto anotado sem nenhuma detecção contada
 * Escolhe a combinação com mais certos e menos errados SEM aumentar os alarmes falsos em relação ao modelo sozinho.
 */
const fs = require('fs');
const path = require('path');
const B = require('../js/banco.js');

const args = process.argv.slice(2);
const opc = (n, pad) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : pad; };
const CONF = +opc('--conf', '0.6');
const SAIDA = opc('--saida', path.join(__dirname, 'conjuntos', 'banco_unificado', 'calibracao.json'));
const OFF = {carteira: -0.15, mesa: -0.15, banco: -0.1, cadeira: -0.15};      // mesmos "off" de treino/classes.py
const limiarClasse = c => Math.min(.95, Math.max(.3, CONF + (OFF[c] || 0)));
const dobras = args.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));

function avaliar(lim, usarBanco){
  const t = {certos:0, errados:0, falsos:0, perdidos:0, objetos:0, confirmados:0, corrigidos:0, recuperados:0, corrigidos_certo:0, recuperados_certo:0};
  for (const d of dobras){
    const banco = B.criarBanco({dim: d.dim, limiares: lim});
    for (const r of d.referencias) banco.adicionar({classe: r.classe, foto: r.foto, origem: 'banco', v: B.decodificarVetor(r.v, d.dim)});
    let porFoto = new Map();
    for (const q of d.consultas){
      if (q.objetos){ const f = porFoto.get(q.foto) || []; t.objetos += q.objetos.length;
        // perdido = classe anotada sem detecção contada com essa classe verdadeira
        const cont = {}; for (const o of q.objetos) cont[o] = (cont[o] || 0) + 1;
        for (const [c, n] of Object.entries(cont)){ const det = f.filter(x => x.contada && x.verdadeira === c).length; t.perdidos += Math.max(0, n - det); }
        porFoto.delete(q.foto); continue; }
      const p = {class: q.classe_detector, score: q.nota, emb: B.decodificarVetor(q.v, d.dim)};
      const r = usarBanco ? banco.reconciliar(p, limiarClasse) : Object.assign({}, p, {banco: {situacao: 'desligado'}});
      const contada = r.score >= limiarClasse(r.class);
      const s = r.banco.situacao;
      if (contada && s === 'confirmado') t.confirmados++;
      if (contada && s === 'nome_corrigido'){ t.corrigidos++; if (r.class === q.classe_verdadeira) t.corrigidos_certo++; }
      if (contada && s === 'recuperado'){ t.recuperados++; if (r.class === q.classe_verdadeira) t.recuperados_certo++; }
      if (contada){ if (!q.classe_verdadeira) t.falsos++; else if (r.class === q.classe_verdadeira) t.certos++; else t.errados++; }
      const f = porFoto.get(q.foto) || []; f.push({contada: contada && r.class === q.classe_verdadeira, verdadeira: q.classe_verdadeira}); porFoto.set(q.foto, f);
    }
  }
  return t;
}

const base = avaliar(B.PADRAO, false);
const grade = [];
for (const simMin of [.4, .5, .6]) for (const simTroca of [.6, .7, .8, .9]) for (const apoioTroca of [.5, .6, .8]) for (const notaMaxTroca of [.5, .7, .9, 1.01])
  for (const simRecupera of [.7, .8, .9, 1.01]) for (const apoioRecupera of [.6, .8, 1])
    grade.push(Object.assign({}, B.PADRAO, {simMin, simTroca, apoioTroca, notaMaxTroca, simRecupera, apoioRecupera}));
let melhor = null;
for (const lim of grade){
  const r = avaliar(lim, true);
  if (r.falsos > base.falsos) continue;                      // o banco não pode criar alarme falso
  const nota = r.certos - 2*r.errados;                        // nome errado custa mais que objeto não nomeado
  if (!melhor || nota > melhor.nota || (nota === melhor.nota && r.errados < melhor.r.errados)) melhor = {nota, lim, r};
}
const padrao = avaliar(B.PADRAO, true);
const saida = {gerado_em: new Date().toISOString(), conf_geral: CONF, dobras: args.map(a => path.basename(a)),
  so_modelo: base, banco_limiares_padrao: padrao, banco_calibrado: melhor.r,
  limiares: melhor.lim,
  leia: 'Contagens nas fotos de validação (objetos nunca vistos pelo modelo da dobra). Amostra pequena: a calibração é indicativa, não estatística.'};
fs.mkdirSync(path.dirname(SAIDA), {recursive: true});
fs.writeFileSync(SAIDA, JSON.stringify(saida, null, 1) + '\n');
console.log(JSON.stringify({so_modelo: base, banco_padrao: padrao, banco_calibrado: melhor.r, limiares: saida.limiares}, null, 1));
