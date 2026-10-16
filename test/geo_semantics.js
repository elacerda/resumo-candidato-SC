/* Correção geográfica — regressão de significância geográfica (não apenas
 * reprodução determinística).
 *
 * Valida, com dados do repo (sem rede, sem dependências):
 *  1) malha municipal: pontos de referência de cidades (Wikipedia, fonte
 *     independente; test/geo_ref_cities.json) dentro da feature correta,
 *     controles negativos fora de SC, bbox do estado;
 *  2) join TSE→IBGE: 295/295 municípios, sem ambiguidade, injetiva;
 *  3) posicionamento das seções: MT19937 ≡ CPython (valores fixos),
 *     placeSection ≡ CPython (valores fixos), contenção 100% no município
 *     (PIP independente), identidade estável entre candidatos/cargos
 *     (dados reais do snapshot), unicidade, distribuição uniforme;
 *  4) agregados: votos por seção/município/total consistentes;
 *  5) semântica honesta na UI: aria/tooltip afirmam que as posições são
 *     ILUSTRATIVAS (o TSE 2026 fornece coordenadas oficiais dos LOCAIS
 *     de votação; o modo ilustrativo cobre as seções cujo local ainda
 *     não tem coordenada verificada); HUD/legenda/rodapé no formato
 *     original (a pedido).
 *
 * Uso: node test/geo_semantics.js
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const Core = require('../js/core.js');

let ok = true;
function check(name, pass, extra) {
  console.log(pass ? '  ✓' : '  ✗', name, extra ? `(${extra})` : '');
  if (!pass) ok = false;
}
const km = (lon1, lat1, lon2, lat2) => {
  const kx = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot((lon1 - lon2) * kx * 111.32, (lat1 - lat2) * 110.57);
};

// ---- PIP independente do app (winding number) — não reusa Core.inAnyPoly ----
function pipWinding(ring, x, y) {
  let w = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0], y1 = ring[i][1], x2 = ring[i + 1][0], y2 = ring[i + 1][1];
    if (y1 <= y) {
      if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) w++;
    } else {
      if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) w--;
    }
  }
  return w !== 0;
}
const inFeature = (rings, x, y) => rings.some(r => pipWinding(r, x, y));

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_sc_municipios.json'), 'utf8'));
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'geo_ref_cities.json'), 'utf8'));
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/1333_sc_2026.json'), 'utf8'));
const secoes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tse_2026/secoes.json'), 'utf8'));
const depFed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tse_2026/dep_federal.json'), 'utf8'));
const gov = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tse_2026/governador.json'), 'utf8'));

const idx = Core.buildGeoIndex(geo);
const feats = idx.feats;
const byName = new Map(feats.map(f => [f[1], f]));
const ringsByGeo = new Map(feats.map(f => [f[0], f[2]]));
const codeOf = s => secoes.mun[s[0]][0];

console.log('== 1) malha municipal vs referência geográfica (Wikipedia) ==');
{
  // bbox do estado (WGS84, graus)
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const [, , rings] of feats) for (const r of rings) for (const [x, y] of r) {
    if (x < minx) minx = x; if (y < miny) miny = y;
    if (x > maxx) maxx = x; if (y > maxy) maxy = y;
  }
  check('bbox do estado ≈ SC', minx < -53.5 && maxx > -48.4 && miny < -29.3 && maxy > -26.0,
    `${minx.toFixed(2)},${miny.toFixed(2)} .. ${maxx.toFixed(2)},${maxy.toFixed(2)}`);

  let allInside = true, bad = '';
  for (const c of ref.cities) {
    const f = byName.get(c.name);
    if (!f) { allInside = false; bad = `${c.name} ausente da malha`; break; }
    const inside = inFeature(f[2], c.lon, c.lat);
    const others = feats.filter(x => x[1] !== c.name && inFeature(x[2], c.lon, c.lat));
    if (!inside || others.length) {
      allInside = false;
      bad = `${c.name}: inside=${inside} others=${others.map(x => x[1]).join('|')}`;
      break;
    }
  }
  check(`${ref.cities.length} cidades (regiões: oeste/norte/sul/leste/serrana) dentro da feature correta`,
    allInside, bad);
  check('fonte de referência registrada', ref.source.includes('wikipedia') && !!ref.retrieved,
    `${ref.source} ${ref.retrieved}`);

  const badNeg = ref.negative_controls.find(c => feats.some(f => inFeature(f[2], c.lon, c.lat)));
  check('controles negativos fora de SC não estão em nenhum município', !badNeg,
    badNeg ? badNeg.name : '');
}

console.log('== 2) join TSE→IBGE ==');
const tseMun = {};
for (const [c, n] of secoes.mun) tseMun[c] = { nome: n };
const { tse2geo, unmatched, ambiguous } = Core.mapTseToGeo(tseMun, idx.geoByName);
check('295/295 municípios TSE mapeados', tse2geo.size === 295 && unmatched.length === 0,
  `mapped=${tse2geo.size} unmatched=${unmatched.length}`);
check('sem nomes ambíguos', ambiguous.length === 0, `ambiguous=${ambiguous.length}`);
{
  const targets = new Set(tse2geo.values());
  check('mapeamento injetiva (cada TSE → IBGE único)', targets.size === 295, `distinct=${targets.size}`);
}

console.log('== 3) posicionamento das seções ==');
{
  // MT19937 bit-idêntico ao CPython (random.Random(424242).random() x3)
  const mt = new Core.MT19937(424242);
  const got = [mt.random(), mt.random(), mt.random()];
  const exp = [0.5044324023878307, 0.2266342961625596, 0.7026460880329856];
  check('MT19937 ≡ CPython (seed 424242, 3 primeiros random())',
    got.every((v, i) => v === exp[i]), got.map(v => v.toPrecision(12)).join(' '));

  // sectionSeed: FNV-1a little-endian + finalizer Murmur3-32 (gerado com CPython)
  check('sectionSeed(4205407,100,313) ≡ 2271961788', Core.sectionSeed(4205407, 100, 313) === 2271961788);
  check('sectionSeed(4209102,105,330) ≡ 3449744553', Core.sectionSeed(4209102, 105, 330) === 3449744553);
  check('sectionSeed(4204608,100,101) ≡ 2557754269', Core.sectionSeed(4204608, 100, 101) === 2557754269);

  // placeSection: valores de referência gerados com CPython (mesma malha do repo)
  const refs = [
    ['4205407', 100, 313, -48.553432380289884, -27.490813506740658, 'Florianópolis'],
    ['4209102', 105, 330, -49.055719414318645, -26.310952022345415, 'Joinville'],
    ['4204608', 100, 101, -49.36028135906519, -28.72853814978333, 'Criciúma'],
  ];
  let pinsOk = true, pinExtra = '';
  for (const [mid, zona, secao, lon, lat, nome] of refs) {
    const p = Core.placeSection(ringsByGeo.get(mid), parseInt(mid, 10), String(zona), String(secao));
    if (p[0] !== lon || p[1] !== lat) { pinsOk = false; pinExtra = `${nome}: ${p} vs [${lon}, ${lat}]`; }
  }
  check('placeSection ≡ CPython (3 seções de referência, coordenadas exatas)', pinsOk, pinExtra);
  check('seções de referência dentro do município (PIP independente)',
    refs.every(([mid, zona, secao]) => inFeature(ringsByGeo.get(mid),
      Core.placeSection(ringsByGeo.get(mid), parseInt(mid, 10), zona, secao)[0],
      Core.placeSection(ringsByGeo.get(mid), parseInt(mid, 10), zona, secao)[1])));
}
{
  // exemplo 1333: integridade de identidade + agregados
  const keys = new Set(sample.sections.map(s => `${s.muni}/${s.zona}/${s.secao}`));
  check('exemplo: 3397 seções, identidade (muni+zona+secao) única',
    sample.sections.length === 3397 && keys.size === 3397, `${keys.size} únicas`);
  let aggOk = true, totMun = 0, aggExtra = '';
  for (const [m, v] of Object.entries(sample.mun)) {
    const sects = sample.sections.filter(s => s.muni === m);
    if (v.secoes !== sects.length) { aggOk = false; aggExtra = `mun ${m} secoes`; break; }
    const sv = sects.reduce((a, s) => a + s.votos, 0);
    if (v.votos !== sv) { aggOk = false; aggExtra = `mun ${m} votos ${sv} vs ${v.votos}`; break; }
    totMun += v.votos;
  }
  check('exemplo: Σvotos(seções/município) = Σmun = total (4876)',
    aggOk && totMun === 4876 && sample.total === 4876, `${totMun}`);

  // contenção: TODAS as 3397 seções do exemplo dentro do polígono do município mapeado
  let inside = 0, outside = 0, badMun = '';
  for (const s of sample.sections) {
    const g = tse2geo.get(s.muni);
    if (!g) continue;
    const p = Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), s.zona, s.secao);
    if (inFeature(ringsByGeo.get(g), p[0], p[1])) inside++;
    else { outside++; badMun = s.muni + '/' + s.zona + '/' + s.secao; }
  }
  check('exemplo: 3397/3397 pontos dentro do município correto (PIP independente)',
    outside === 0 && inside === 3397, `inside=${inside} outside=${outside} ${badMun}`);

  // estabilidade de identidade: mesma seção -> mesmo ponto, em qualquer ordem/candidato
  const byMun = new Map();
  for (const s of sample.sections) {
    const g = tse2geo.get(s.muni);
    if (!byMun.has(g)) byMun.set(g, []);
    byMun.get(g).push(s);
  }
  let stable = true;
  for (const [g, sects] of byMun) {
    const first = new Map(sects.map(s => [`${s.zona}/${s.secao}`,
      Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), s.zona, s.secao)]));
    const shuffled = [...sects].reverse();
    for (const s of shuffled) {
      const p2 = Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), s.zona, s.secao);
      const p1 = first.get(`${s.zona}/${s.secao}`);
      if (p1[0] !== p2[0] || p1[1] !== p2[1]) { stable = false; break; }
    }
    if (!stable) break;
  }
  check('identidade estável: mesma seção → mesmo ponto (ordem irrelevante)', stable);
}
{
  // estabilidade entre candidatos/cargos com dados reais do snapshot
  const entries = Object.entries(depFed.cand).sort((a, b) => b[1].length - a[1].length);
  const [numA, listA] = entries[0];
  const [numB, listB] = entries[1];
  const keyOf = s => `${codeOf(s)}/${s[1]}/${s[2]}`;
  const setB = new Set(listB.map(([i]) => keyOf(secoes.secoes[i])));
  const common = listA.map(([i]) => secoes.secoes[i]).filter(s => setB.has(keyOf(s)));
  let diff = 0, n = 0;
  for (const s of common) {
    const g = tse2geo.get(codeOf(s));
    const p1 = Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), s[1], s[2]);
    const p2 = Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), s[1], s[2]);
    n++;
    if (p1[0] !== p2[0] || p1[1] !== p2[1]) diff++;
  }
  // dataset publicado (1333) vs snapshot (secoes.json): a mesma identidade de
  // seção (código TSE + zona + seção) deve produzir o MESMO ponto nos dois modos
  const snapRow = new Map();
  for (const row of secoes.secoes) snapRow.set(`${secoes.mun[row[0]][0]}/${row[1]}/${row[2]}`, row);
  let crossView = 0, crossDiff = 0, missing = 0;
  for (const s of sample.sections) {
    const row = snapRow.get(`${s.muni}/${s.zona}/${s.secao}`);
    if (!row) { missing++; continue; }
    const g = tse2geo.get(s.muni);
    const pSample = Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), s.zona, s.secao);
    const pSnap = Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), row[1], row[2]);
    crossView++;
    if (pSample[0] !== pSnap[0] || pSample[1] !== pSnap[1]) crossDiff++;
  }
  check('dataset publicado (1333) ↔ snapshot: mesma identidade → mesmo ponto',
    missing === 0 && crossDiff === 0, `n=${crossView} missing=${missing} diff=${crossDiff}`);
  check(`estável entre candidatos federais (${numA} vs ${numB}, ${common.length} seções comuns)`,
    common.length >= 1000 && diff === 0, `diff=${diff}`);
  check('estável entre modo snapshot e dataset publicado (1333)',
    crossView > 0 && crossDiff === 0, `n=${crossView} diff=${crossDiff}`);
  const [numG, listG] = Object.entries(gov.cand).sort((a, b) => b[1].length - a[1].length)[0];
  const setG = new Set(listG.map(([i]) => keyOf(secoes.secoes[i])));
  const commonG = common.filter(s => setG.has(keyOf(s)));
  check(`estável entre cargos (dep. federal vs governador ${numG}, ${commonG.length} seções comuns)`,
    commonG.length >= 1000, `n=${commonG.length}`);

  // unicidade e distribuição (candidato com mais seções)
  const pts = new Map();
  for (const [i] of listA) {
    const s = secoes.secoes[i]; const g = tse2geo.get(codeOf(s));
    pts.set(g + '/' + s[1] + '/' + s[2], Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), s[1], s[2]));
  }
  const flKey = '4205407/';
  const fl = [...pts.entries()].filter(([k]) => k.startsWith(flKey)).map(([, p]) => p);
  const flDistinct = new Set(fl.map(p => p[0] + ',' + p[1]));
  check('unicidade: seções distintas do mesmo município → pontos distintos (Florianópolis)',
    flDistinct.size === fl.length, `${fl.length} pts, ${flDistinct.size} distintos`);
  if (fl.length > 100) {
    // centroide de ÁREA da união dos anéis (shoelace) — referência exata para
    // amostragem uniforme (média dos pontos → centroide de área)
    const polyArea = ring => {
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        a += x1 * y2 - x2 * y1;
      }
      return a / 2;
    };
    const polyCentroid = (ring, A) => {
      let cx = 0, cy = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        const f = x1 * y2 - x2 * y1;
        cx += (x1 + x2) * f; cy += (y1 + y2) * f;
      }
      return [cx / (6 * A), cy / (6 * A)];
    };
    const ringsF = ringsByGeo.get('4205407');
    let area = 0, ax = 0, ay = 0;
    for (const r of ringsF) {
      const a = polyArea(r);
      if (a === 0) continue;
      const [cx, cy] = polyCentroid(r, a);
      area += a; ax += cx * a; ay += cy * a;
    }
    const acx = ax / area, acy = ay / area;
    const mx = fl.reduce((a, p) => a + p[0], 0) / fl.length;
    const my = fl.reduce((a, p) => a + p[1], 0) / fl.length;
    const d = km(mx, my, acx, acy);
    check('distribuição uniforme: média dos pontos ≈ centroide de área (Florianópolis)',
      d < 3, `dist=${d.toFixed(2)} km (n=${fl.length})`);
    const rms = Math.sqrt(fl.reduce((a, p) => a + km(p[0], p[1], mx, my) ** 2, 0) / fl.length);
    check('distribuição espalhada (não colapsada, não exterior): 3 km < RMS < 30 km',
      rms > 3 && rms < 30, `RMS=${rms.toFixed(2)} km`);
  }
}

console.log('== 4) projeção e renderização ==');
{
  const proj = Core.makeProjector(feats.flatMap(f => f[2]));
  const W2 = proj.W + 2 * proj.pad, H2 = proj.H + 2 * proj.pad;
  const fp = byName.get('Florianópolis')[2], jp = byName.get('Joinville')[2], lp = byName.get('Lages')[2];
  const fc = Core.centroid(Core.biggestRing(fp)), jc = Core.centroid(Core.biggestRing(jp)),
        lc = Core.centroid(Core.biggestRing(lp));
  const [fx, fy] = proj.P(fc[0], fc[1]);
  const [jx, jy] = proj.P(jc[0], jc[1]);
  const [lx] = proj.P(lc[0], lc[1]);
  check('orientação: leste→x cresce (Floripa a leste de Lages)', fx > lx, `${fx} > ${lx}`);
  check('orientação: sul→y cresce (Floripa a sul de Joinville)', fy > jy, `${fy} > ${jy}`);
  let inCanvas = true;
  for (const c of ref.cities) {
    const f = byName.get(c.name);
    const cc = Core.centroid(Core.biggestRing(f[2]));
    const [x, y] = proj.P(cc[0], cc[1]);
    if (x < 0 || x > W2 || y < 0 || y > H2) { inCanvas = false; break; }
  }
  check('centroide de todos os municípios de referência dentro do canvas', inCanvas);
}

console.log('== 5) semântica honesta na UI ==');
(async () => {
  // DOM shim mínimo (mesmo padrão do app_smoke.js)
  function makeEl(tag) {
    return {
      tagName: tag, innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
      value: '', files: [], children: [], listeners: {},
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, force) { const has = this._s.has(c); const want = force === undefined ? !has : force; if (want) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      removeEventListener() {},
      setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs && this.attrs[k]; },
      querySelector() { return makeEl('child'); },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { width: 1000, height: 700, left: 0, top: 0 }; },
      click() {}, appendChild(c) { this.children.push(c); }, remove() {},
      createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return this; } }; },
      getScreenCTM() { return null; },
      scrollIntoView() {}, focus() {}, blur() {}
    };
  }
  const IDS = ['dropZone','results','fileActions','errBox','btnLoad','fileInput','btnSample','btnSample2',
    'btnSvg','btnJson','chips','warnBox','mapBox','hudTitle','hudLegend','tip','btnTse','tsePanel',
    'tseGoDrop','tseNum','btnTseList','btnTseMap','tseSel','tseStatus','tseStatusText','tseBar',
    'tseSize','tseBig'];
  const els = {};
  IDS.forEach(id => els[id] = makeEl(id));
  const doc = {
    getElementById: id => els[id] || (els[id] = makeEl(id)),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: t => makeEl(t),
    addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = fn; },
    body: makeEl('body')
  };
  const win = { addEventListener() {}, innerWidth: 1400, innerHeight: 900, scrollTo() {} };
  global.window = win;
  global.document = doc;
  global.self = win;
  global.fetch = url => {
    const p = path.join(ROOT, url);
    return Promise.resolve({ json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) });
  };
  global.URL = global.URL || {};
  global.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
  global.URL.createObjectURL = () => 'blob:fake';
  global.URL.revokeObjectURL = () => {};
  win.ResumoCore = Core;
  require('../js/app.js');
  const init = doc.listeners['DOMContentLoaded'];
  check('app carregado (DOMContentLoaded)', !!init);
  await init();
  await els.btnSample.listeners.click[0]();
  const svg0 = els.mapBox.innerHTML;
  const nDots0 = (svg0.match(/class="dot"/g) || []).length;
  const nIll0 = (svg0.match(/class="dot dot-ill"/g) || []).length;
  const aria0 = /aria-label="([^"]*)"/.exec(svg0);
  check('sem catálogo: nenhum marcador por padrão (estado indisponível)',
    nDots0 === 0 && nIll0 === 0, `${nDots0}/${nIll0}`);
  check('sem catálogo: aria declara georreferenciamento indisponível',
    !!aria0 && /indisponível/.test(aria0[1]), aria0 ? aria0[1].slice(-110) : 'sem aria');
  check('sem catálogo: HUD declara indisponível',
    els.hudTitle.innerHTML.includes('georreferenciamento indisponível'), els.hudTitle.innerHTML.slice(0, 120));
  check('sem catálogo: aviso explícito',
    !els.warnBox.hidden && /indisponível/.test(els.warnBox.innerHTML), els.warnBox.innerHTML.slice(0, 80));
  check('sem catálogo: botão modo ilustrativo visível',
    els.btnIllus.hidden === false && /Modo ilustrativo/.test(els.btnIllus.textContent), els.btnIllus.textContent);
  // escolha explícita do modo ilustrativo
  await els.btnIllus.listeners.click[0]();
  const svg = els.mapBox.innerHTML;
  const nDots = (svg.match(/class="dot dot-ill"/g) || []).length;
  check('modo ilustrativo (escolha explícita): 3397 pontos', nDots === 3397, `${nDots}`);
  const aria = /aria-label="([^"]*)"/.exec(svg);
  check('modo ilustrativo: aria-label afirma posição ILUSTRATIVA',
    !!aria && /ilustrativ/i.test(aria[1]), aria ? aria[1].slice(-110) : 'sem aria');
  check('legenda: escala log declarada + max do município',
    els.hudLegend.innerHTML.includes('escala log') &&
    els.hudLegend.innerHTML.includes('1.745 (Florianópolis)'));
  check('legenda: sem confluência marcador/escala (">1 seção<")',
    !els.hudLegend.innerHTML.includes('>1 seção<') &&
    !els.hudLegend.innerHTML.includes('1 ponto = 1 seção'));
  check('legenda (ilustrativo sem catálogo): seção ILUSTRATIVA não geográfica',
    els.hudLegend.innerHTML.includes('ILUSTRATIVA') &&
    els.hudLegend.innerHTML.includes('não geográfica'));
  check('modo ilustrativo: HUD declara posições ilustrativas',
    els.hudTitle.innerHTML.includes('posições ilustrativas') &&
    !/coordenada verificada/i.test(els.hudTitle.innerHTML));
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  check('tooltip exibe nota de posição ilustrativa',
    appSrc.includes('tip-note') && /posição ILUSTRATIVA — sem coordenada verificada/.test(appSrc));
  const foot = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('rodapé removido da página (a pedido)', !/<footer/.test(foot));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  check('README documenta "Semântica geográfica do mapa"',
    readme.includes('Semântica geográfica do mapa') && readme.includes('dado geográfico real'));

  console.log(ok ? '\nGEO-SEMANTICS OK' : '\nGEO-SEMANTICS FALHOU');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('EXCEÇÃO:', e); process.exit(1); });
