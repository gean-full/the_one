'use strict';
/*
 * Setas de direção na parede (seta amarela com contorno preto, ver docs/SETAS_E_EQUIPAMENTO.md). Detecção por cor e forma, sem treino:
 *   1. máscara de amarelo saturado (matiz 38°–72°) numa cópia pequena do quadro (lado maior 320 px no app, 1–3 ms);
 *   2. manchas conectadas; cada uma precisa ter tamanho, proporção e preenchimento de seta (descarta placas, caixas e fitas);
 *   3. a DIREÇÃO vem da forma: a ponta da seta é a metade mais alta da mancha (a cabeça triangular), a outra metade é a haste, mais baixa,
 *      e a extremidade da ponta é estreita (o bico). Uma imagem espelhada inverte a resposta, por construção.
 * Por que sem treino: com 13 fotos de UMA seta, um YOLO decoraria as fotos; e espelhar as fotos no treino (padrão do YOLO) ensinaria
 * "esquerda" e "direita" como a mesma coisa. Aqui a regra é simétrica e foi conferida nas 13 fotos e nas 13 espelhadas.
 * Puro: recebe pixels RGBA e devolve [{direcao:'esquerda'|'direita', bbox:[x,y,w,h] nos pixels da imagem recebida, conf, razao, bico}].
 * A direção é a DA IMAGEM; quem chama aplica a inversão de lados (câmera frontal/espelhada) com ladoUsuario.
 */
(function(g){
  const P = {hMin:38, hMax:72, sMin:.42, vMin:.32, areaMin:30, areaMaxRel:.35, larguraMin:8, alturaMin:4, propMin:.55, propMax:5,
    preenchMin:.38, preenchMax:.82, razaoMin:1.45, bicoMax:.6, satMedMin:.7, contornoMin:.4, escuroMax:100, confMin:.5};

  function mascaraAmarela(px, W, H, p = P){
    const m = new Uint8Array(W*H);
    for (let i = 0, j = 0; i < W*H; i++, j += 4){
      const r = px[j], gg = px[j+1], b = px[j+2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), d = mx - mn;
      if (mx < p.vMin*255 || d < p.sMin*mx || b === mx) continue;                       // escuro, pouco saturado ou azul/roxo
      // matiz em graus com R ou G no máximo (amarelo fica entre os dois)
      const h = mx === r ? 60*((gg - b)/d) : 60*(2 + (b - r)/d);
      if (h >= p.hMin && h <= p.hMax) m[i] = 1;
    }
    return m;
  }

  // Manchas 4-conectadas: {area, x0, y0, x1, y1, px:[índices]}
  function manchas(m, W, H, areaMin){
    const rot = new Int32Array(W*H), pilha = new Int32Array(W*H), saida = [];
    let n = 0;
    for (let s = 0; s < W*H; s++){
      if (!m[s] || rot[s]) continue;
      n++; let topo = 0, area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1; const px = [];
      pilha[topo++] = s; rot[s] = n;
      while (topo){
        const k = pilha[--topo], x = k % W, y = (k - x)/W; area++; px.push(k);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && m[k-1] && !rot[k-1]){ rot[k-1] = n; pilha[topo++] = k-1; }
        if (x < W-1 && m[k+1] && !rot[k+1]){ rot[k+1] = n; pilha[topo++] = k+1; }
        if (y > 0 && m[k-W] && !rot[k-W]){ rot[k-W] = n; pilha[topo++] = k-W; }
        if (y < H-1 && m[k+W] && !rot[k+W]){ rot[k+W] = n; pilha[topo++] = k+W; }
      }
      if (area >= areaMin) saida.push({area, x0, y0, x1, y1, px});
    }
    return saida;
  }

  // Forma de seta horizontal? Altura de cada coluna da mancha: a metade com a coluna mais alta é a cabeça. Devolve null se não parece seta.
  // Amarelo de impressão (saturação média alta) e contorno escuro em volta: o que separa a seta de folhas, fitas e luz amarelada.
  function corEContorno(mc, px, W, H, p){
    let sat = 0;
    for (const k of mc.px){ const j = 4*k, mx = Math.max(px[j], px[j+1], px[j+2]), mn = Math.min(px[j], px[j+1], px[j+2]); sat += (mx - mn)/mx; }
    // contorno: o primeiro pixel fora da mancha (até 3 px) em cada direção a partir da borda; conta quantos são escuros
    const dentro = new Set(mc.px), visto = new Set(); let escuro = 0, total = 0;
    for (const k of mc.px){
      const x = k % W, y = (k - x)/W;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy*W + xx; if (dentro.has(q) || visto.has(q)) continue;
        visto.add(q); total++;
        let achou = false;
        for (let t = 1; t <= 3 && !achou; t++){
          const x2 = x + dx*t, y2 = y + dy*t; if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) break;
          const j = 4*(y2*W + x2); if (Math.max(px[j], px[j+1], px[j+2]) < p.escuroMax) achou = true;
        }
        if (achou) escuro++;
      }
    }
    return {satMed: sat/mc.area, contorno: total ? escuro/total : 0};
  }

  function avaliarMancha(mc, W, H, p = P, px = null){
    const w = mc.x1 - mc.x0 + 1, h = mc.y1 - mc.y0 + 1, prop = w/h, preench = mc.area/(w*h);
    if (w < p.larguraMin || h < p.alturaMin || prop < p.propMin || prop > p.propMax) return null;
    if (preench < p.preenchMin || preench > p.preenchMax || mc.area > p.areaMaxRel*W*H) return null;
    const alt = new Float32Array(w);
    for (const k of mc.px) alt[(k % W) - mc.x0]++;
    // suaviza 3 colunas (bordas serrilhadas e o contorno preto não viram "pico")
    const a = alt.map((v, i) => (alt[Math.max(0, i-1)] + v + alt[Math.min(w-1, i+1)])/3);
    const meio = Math.floor(w/2);
    let maxE = 0, maxD = 0;
    for (let i = 0; i < w; i++){ if (i < meio) maxE = Math.max(maxE, a[i]); else maxD = Math.max(maxD, a[i]); }
    const esquerda = maxE >= maxD, razao = esquerda ? maxE/Math.max(maxD, .5) : maxD/Math.max(maxE, .5);
    if (razao < p.razaoMin) return null;
    // bico: a coluna da ponta (10% da largura) é estreita perto da cabeça; a da haste é larga como a haste.
    const n = Math.max(1, Math.round(w*.1)), ponta = esquerda ? a.slice(0, n) : a.slice(w-n), cabeca = Math.max(maxE, maxD);
    const bico = ponta.reduce((s, v) => s + v, 0)/n/cabeca;
    if (bico > p.bicoMax) return null;
    let cor = null;
    if (px){ cor = corEContorno(mc, px, W, H, p); if (cor.satMed < p.satMedMin || cor.contorno < p.contornoMin) return null; }
    // confiança simples: quanto mais clara a diferença cabeça/haste e mais fino o bico, maior
    const conf = Math.min(1, .45 + .25*Math.min(1, (razao - p.razaoMin)/1) + .3*Math.min(1, (p.bicoMax - bico)/p.bicoMax));
    return {direcao: esquerda ? 'esquerda' : 'direita', bbox:[mc.x0, mc.y0, w, h], conf, razao, bico, area: mc.area, contorno: cor && cor.contorno};
  }

  function detectar(px, W, H, p = P){
    const m = mascaraAmarela(px, W, H, p);
    const r = [];
    for (const mc of manchas(m, W, H, p.areaMin)){ const s = avaliarMancha(mc, W, H, p, px); if (s && s.conf >= p.confMin) r.push(s); }
    return r.sort((a, b) => b.area - a.area);
  }

  // Estabilização e fala: a seta só é anunciada depois de `persist` quadros seguidos com a MESMA direção, uma vez por aparição.
  // Volta a ser anunciada se sumir por `esquecerMs` ou se a direção mudar (seta nova). Não é obstáculo: não ocupa zona nem bloqueia passagem.
  function criarSeguidorSetas(o = {}){
    const persist = o.persist || 2, esquecerMs = o.esquecerMs || 6000;
    let cand = null, n = 0, anunciada = null, vistaEm = -Infinity;
    return {
      atualizar(seta, agora){                                // seta = a maior do quadro (direção já no referencial do usuário) ou null
        if (!seta){ n = 0; cand = null; if (anunciada && agora - vistaEm > esquecerMs) anunciada = null; return null; }
        vistaEm = agora;
        if (seta.direcao === cand) n++; else { cand = seta.direcao; n = 1; }
        if (n >= persist && anunciada !== cand){ anunciada = cand; return {direcao: cand, texto: 'Seta: vire ' + (cand === 'esquerda' ? 'à esquerda' : 'à direita') + '.'}; }
        return null;
      },
      reset(){ cand = null; n = 0; anunciada = null; vistaEm = -Infinity; },
      estado: () => ({cand, n, anunciada})
    };
  }

  const api = {P, detectar, mascaraAmarela, manchas, avaliarMancha, criarSeguidorSetas};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.VisioSetas = api;
})(typeof window !== 'undefined' ? window : globalThis);
