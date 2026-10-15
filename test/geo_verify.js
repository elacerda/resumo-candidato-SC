/* Georreferenciamento — verificação independente (Node, sem dependências).
 *
 * Valida o catálogo publicado (data/geo_loc) com código INDEPENDENTE do
 * pipeline Python:
 *  1) integridade: 295 municípios, seção->local única, status/coord coerentes;
 *  2) WGS84: bbox de SC + ausência de lat/lon trocado;
 *  3) contenção: PIP próprio (winding number) — coordenadas verificadas
 *     dentro do polígono do município (ou flag 'edge' <= 500 m);
 *  4) plausidade por cidade de referência (test/geo_ref_cities.json,
 *     fonte independente): nenhum local verificado fica mais longe do
 *     centro de referência do que o próprio raio do município;
 *  5) multi-seção: locais com >1 seção -> 1 coordenada (mesmo índice);
 *  6) independência de candidato/cargo: mesma seção -> mesmo ponto em
 *     datasets diferentes (snapshot dep. federal x governador x 1333);
 *  7) preservação de totais (1333: 4876 votos / 3397 seções / 224 mun);
 *  8) spot-checks: re-deriva a coordenada do REGISTRO-FONTE (CSV oficial
 *     TSE no cache; prisões: ref OSM no cache) e compara com a
 *     publicada (valida a cadeia do join, independente do Python);
 *  9) front-end: marcadores = locais verificados (não seções), aria/HUD/
 *     legenda corretos, modo ilustrativo separado (círculos ocos, não
 *     mistura), fallback sem catálogo.
 *
 * Uso: node test/geo_verify.js
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
// distância exata (km) do ponto ao segmento — aproximação planar local
// (mesma convenção de sync/geo_ref.py); amostragem de vértices
// superestima a distância em segmentos longos (ex.: fronteira
// Indaial/Timbó, 3,25 km amostrado vs 6 m reais)
const kmPtSeg = (px, py, ax, ay, bx, by) => {
  const kx = Math.cos(((py + ay + by) / 3) * Math.PI / 180) * 111.32;
  const ky = 110.57;
  const axp = (ax - px) * kx, ayp = (ay - py) * ky;
  const bxp = (bx - px) * kx, byp = (by - py) * ky;
  const vx = bxp - axp, vy = byp - ayp;
  const v2 = vx * vx + vy * vy;
  const t = v2 === 0 ? 0 : Math.max(0, Math.min(1, ((-axp) * vx + (-ayp) * vy) / v2));
  return Math.hypot(axp + t * vx, ayp + t * vy);
};
const kmRing = (x, y, ring) => {
  let d = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const dd = kmPtSeg(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    if (dd < d) d = dd;
  }
  return d;
};

// PIP independente (winding number)
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
const idx = Core.buildGeoIndex(geo);
const feats = idx.feats;
const ringsByGeo = new Map(feats.map(f => [f[0], f[2]]));
const byName = new Map(feats.map(f => [f[1], f]));

console.log('== 1) catálogo: integridade ==');
const catIdx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_loc/index.json'), 'utf8'));
const locais = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_loc/locais.json'), 'utf8')).locais;
const sec2loc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_loc/secoes.json'), 'utf8')).secao2local;
const muniNoCat = new Set(locais.map(l => l[1]));
const tseMun = new Set(Object.keys(sample.mun));
check('catálogo cobre 295 municípios (295 na malha)', feats.length === 295, String(feats.length));
check('locais em todos os municípios do snapshot',
  [...tseMun].every(m => muniNoCat.has(m)),
  'faltam: ' + [...tseMun].filter(m => !muniNoCat.has(m)).join(','));
{
  const keys = new Set(sec2loc.map(r => r[0] + '/' + r[1] + '/' + r[2]));
  check('seção->local: sem duplicatas', keys.size === sec2loc.length, `${keys.size}/${sec2loc.length}`);
  const badStatus = locais.filter(l => (l[12] === 'verificado' || l[12] === 'edge') !== (l[8] !== null));
  check('status coerente com coordenada', badStatus.length === 0, String(badStatus.length));
  const nVer = locais.filter(l => l[8] !== null).length;
  check('há locais com coordenada verificada', nVer > 0, String(nVer));
}

console.log('== 2) WGS84 ==');
{
  const withc = locais.filter(l => l[8] !== null);
  const bad = withc.filter(l => !(l[8][0] > -54.5 && l[8][0] < -48 && l[8][1] > -31 && l[8][1] < -25.5));
  check('bbox de SC', bad.length === 0, bad.slice(0, 3).map(l => l[4] + ' ' + l[8]).join(' | '));
  const swap = withc.filter(l => Math.abs(l[8][1]) > Math.abs(l[8][0]));
  check('sem troca lat/lon (SC: |lon| > |lat|)', swap.length === 0, String(swap.length));
}

console.log('== 3) contenção no município (PIP independente) ==');
{
  let out = 0, edgeOk = 0, bad = '';
  for (const l of locais) {
    if (!l[8]) continue;
    const rings = ringsByGeo.get(l[2]) || [];
    const [lon, lat] = l[8];
    if (inFeature(rings, lon, lat)) continue;
    // distância mínima exata (ponto-segmento) aos anéis
    let d = Infinity;
    for (const r of rings) {
      const dd = kmRing(lon, lat, r);
      if (dd < d) d = dd;
    }
    if (l[12] === 'edge' && d <= 0.5) edgeOk++;
    else { out++; if (!bad) bad = `${l[4]} (${l[3]}) ${d.toFixed(2)} km status=${l[12]}`; }
  }
  check('coords dentro do município (ou edge <= 500 m)', out === 0, bad);
  console.log('    edge (fronteira/ilha):', edgeOk);
}

console.log('== 4) plausidade por cidade de referência ==');
{
  // raio do município: distância do centroide (biggest ring) até o
  // vértice mais distante — nenhum local verificado pode estar além
  // disso (mais margem de 2 km)
  const munRadius = new Map();
  for (const [code, nome, rings] of feats) {
    const big = Core.biggestRing(rings);
    const c = Core.centroid(big);
    let rmax = 0;
    for (const p of big) rmax = Math.max(rmax, km(c[0], c[1], p[0], p[1]));
    munRadius.set(nome, rmax);
  }
  let bad = '', n = 0;
  for (const c of ref.cities) {
    const rmax = munRadius.get(c.name) || 25;
    const lim = rmax + 2;
    for (const l of locais) {
      if (!l[8] || l[3] !== c.name) continue;
      n++;
      const d = km(c.lon, c.lat, l[8][0], l[8][1]);
      if (d > lim) { bad = `${c.name}: ${l[4]} a ${d.toFixed(1)} km (limite ${lim.toFixed(1)})`; break; }
    }
    if (bad) break;
  }
  check(`${ref.cities.length} cidades-ref: locais dentro do raio do município`, !bad, bad || `${n} locais checados`);
}

console.log('== 5) multi-seção / mesmo local ==');
{
  const multi = locais.filter(l => l[7].length > 1);
  check('locais com múltiplas seções existem', multi.length > 100, String(multi.length));
  let bad = 0;
  const idxOf = new Map(sec2loc.map(r => [r[0] + '/' + r[1] + '/' + r[2], r[3]]));
  for (const l of multi) {
    const seen = new Set();
    for (const [z, s] of l[7]) seen.add(idxOf.get(l[1] + '/' + z + '/' + s));
    if (seen.size !== 1) bad++;
  }
  check('todas as seções do mesmo local -> mesmo índice', bad === 0, String(bad));
  const top = [...multi].sort((a, b) => b[7].length - a[7].length)[0];
  console.log('    maior local:', top[4], `(${top[7].length} seções)`);
}

console.log('== 6) independência de candidato/cargo ==');
{
  // O catálogo mapeia IDENTIDADE de seção (mun, zona, seção) -> local,
  // sem nenhuma dimensão de candidato/cargo. A mesma seção deve resolver
  // para o MESMO local e a MESMA coordenada quando vista a partir de
  // datasets diferentes: arquivo publicado 1333 (strings de zona/seção)
  // x cada cargo do snapshot (zonas/seções numéricas do secoes.json).
  // Representações divergentes (ex.: "013" x 13) gerariam local
  // diferente ou ausente — o teste captura isso.
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tse_2026/secoes.json'), 'utf8'));
  const idxOf = new Map(sec2loc.map(r => [r[0] + '/' + r[1] + '/' + r[2], r[3]]));
  const coordOf = key => {
    const i = idxOf.get(key);
    return (i === undefined || i < 0) ? null : JSON.stringify(locais[i][8]);
  };
  const byKey1333 = new Map(sample.sections.map(s =>
    [s.muni + '/' + s.zona + '/' + s.secao, s]));
  const cargoFiles = ['dep_federal', 'dep_estadual', 'governador', 'senador'];
  let n = 0, diff = 0, missing = 0;
  for (const cf of cargoFiles) {
    const cargo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tse_2026', cf + '.json'), 'utf8'));
    const top = Object.entries(cargo.cand).sort((a, b) => b[1].length - a[1].length)[0][1];
    for (const [sIdx] of top) {
      const s = snap.secoes[sIdx];
      const k = String(snap.mun[s[0]][0]) + '/' + s[1] + '/' + s[2];
      if (!idxOf.has(k)) { missing++; continue; }
      const s1333 = byKey1333.get(k);
      if (!s1333) continue; // comum apenas a este cargo
      n++;
      const cCargo = coordOf(k);
      const c1333 = coordOf(s1333.muni + '/' + s1333.zona + '/' + s1333.secao);
      // as duas vistas devem concordar (coordenada igual OU ambas sem
      // coordenada verificada); divergência = bug de representação/chave
      if (c1333 !== cCargo) diff++;
    }
  }
  check('mesma seção -> mesmo local/coordenada (1333 x 4 cargos, seções comuns)',
    n > 1000 && diff === 0 && missing === 0,
    `n=${n} diff=${diff} missing=${missing}`);
  // e a mesma identidade resolve para UMA única linha no catálogo
  const dupSec = sec2loc.length - new Set(sec2loc.map(r => r[0] + '/' + r[1] + '/' + r[2])).size;
  check('catálogo: 1 linha por identidade de seção', dupSec === 0, String(dupSec));
}

console.log('== 7) totais preservados (1333) ==');
{
  check('total 4876 / 3397 seções / 224 municípios',
    sample.total === 4876 && sample.sections.length === 3397 && Object.keys(sample.mun).length === 224);
}

console.log('== 8) spot-checks: re-derivação independente da fonte ==');
{
  // Re-deriva a coordenada do registro-fonte com lógica INDEPENDENTE do
  // pipeline Python:
  //  - locais com coordenada oficial: CSV do TSE no cache
  //    (eleitorado_local_votacao_2026_SC.csv; decimal com vírgula);
  //  - prisões (TSE publica sentinela -1,-1): a ref do catálogo aponta
  //    para a feature OSM — a coord deve bater com a feature no cache.
  const normEq = (a, b) => {
    const n = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return n(a) === n(b);
  };
  const round6 = x => Math.round(x * 1e6) / 1e6;
  const rowFor = (mun, zona, code) => locais.find(L =>
    L[1] === String(mun) && L[14] === String(code) && L[6].includes(Number(zona)));
  // CSV do TSE (latin-1, ';', campos de texto entre aspas)
  const csvPath = path.join(ROOT, 'cache/eleitorado_local_votacao_2026_SC.csv');
  if (!fs.existsSync(csvPath)) { check('CSV TSE no cache (fonte dos spot-checks)', false, 'ausente'); }
  else {
    const splitCsv = (line, d) => {
      const out = []; let cur = ''; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
          else cur += c;
        } else if (c === '"') q = true;
        else if (c === d) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out;
    };
    const lines = fs.readFileSync(csvPath, 'latin1').split(/\r?\n/);
    const header = splitCsv(lines[0], ';').map(h => h.trim());
    const I = {};
    for (const c of ['CD_MUNICIPIO', 'NR_ZONA', 'NR_LOCAL_VOTACAO',
                     'NM_LOCAL_VOTACAO', 'NR_LATITUDE', 'NR_LONGITUDE'])
      I[c] = header.indexOf(c);
    const tse = new Map();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const p = splitCsv(lines[i], ';');
      if (p.length < header.length) continue;
      const key = p[I.CD_MUNICIPIO] + '/' + p[I.NR_ZONA] + '/' + p[I.NR_LOCAL_VOTACAO];
      const lat = parseFloat(p[I.NR_LATITUDE].replace(',', '.'));
      const lon = parseFloat(p[I.NR_LONGITUDE].replace(',', '.'));
      if (!tse.has(key)) tse.set(key, {
        lat: (isFinite(lat) && lat !== -1) ? lat : null,
        lon: (isFinite(lon) && lon !== -1) ? lon : null,
        nome: p[I.NM_LOCAL_VOTACAO],
      });
    }
    const spot = JSON.parse(fs.readFileSync(path.join(__dirname, 'geo_ref_locais.json'), 'utf8'));
    let n = 0, bad = '';
    for (const item of spot.checks) {
      const key = String(item.muni) + '/' + item.zona + '/' + item.local_code;
      const src = tse.get(key);
      if (!src) { check('spot ' + item.nome + ': registro no CSV TSE', false, key + ' ausente'); continue; }
      const L = rowFor(item.muni, item.zona, item.local_code);
      if (!L) { check('spot ' + item.nome + ': local no catálogo', false, 'ausente'); continue; }
      check('spot ' + item.city + '/' + item.nome + ': nome == TSE', normEq(L[4], item.nome), L[4]);
      if (src.lat === null) {
        check('spot ' + item.nome + ': TSE sem coord -> pendente/ambiguo',
          L[12] === 'pendente' || L[12] === 'ambiguo', L[12]);
        continue;
      }
      n++;
      const pub = L[8];
      // igualdade dentro do arredondamento p/ 6 casas (round do Python e
      // Math.round do Node podem divergir em meio-ulps de fronteira)
      const okC = !!pub && Math.abs(pub[0] - src.lon) <= 1.5e-6 && Math.abs(pub[1] - src.lat) <= 1.5e-6;
      if (!okC) {
        bad = item.city + ': publicado ' + JSON.stringify(pub) + ' vs TSE [' + src.lon + ',' + src.lat + ']';
      }
      check('spot ' + item.city + '/' + item.nome + ': coord catalogada == oficial TSE',
        okC, bad);
      if (okC) bad = '';
      check('spot ' + item.nome + ': dentro do município',
        inFeature(ringsByGeo.get(L[2]) || [], pub[0], pub[1]) || L[12] === 'edge');
    }
    check('spot-checks: >= 10 verificações independentes (TSE -> catálogo)', n >= 10, String(n));
    // prisões: TSE sem coordenada — se resolvido, ref OSM deve bater OU
    // revisão manual auditável (sync/geo_overrides.json): coord publicada
    // == coord do manifesto (veredito 'corrigir'), com evidência em obs.
    const osmPath = path.join(ROOT, 'cache/osm_sc_facilities.json');
    const osmFeats = fs.existsSync(osmPath) ? JSON.parse(fs.readFileSync(osmPath, 'utf8')) : [];
    const ovrPath = path.join(ROOT, 'sync/geo_overrides.json');
    const ovr = JSON.parse(fs.readFileSync(ovrPath, 'utf8'));
    const ovrBy = new Map(ovr.overrides.map(o =>
      [o.local.mun_tse + '/' + o.local.zona + '/' + o.local.local_code, o]));
    for (const pr of spot.prisons) {
      const L = rowFor(pr.muni, pr.zona, pr.local_code);
      if (!L) { check('prisão ' + pr.city + ': local no catálogo', false, 'ausente'); continue; }
      if (L[8] === null) {
        check('prisão ' + pr.city + ' (TSE sem coord): pendente reportado',
          L[12] === 'pendente' || L[12] === 'ambiguo', L[12]);
        continue;
      }
      const isOvr = String(L[9]).includes('revisão manual');
      check('prisão ' + pr.city + ': fonte OSM ou revisão manual (TSE sem coord)',
        String(L[9]).includes('OSM') || isOvr, String(L[9]));
      if (isOvr) {
        const o = ovrBy.get(pr.muni + '/' + pr.zona + '/' + pr.local_code);
        check('prisão ' + pr.city + ': entrada no manifesto (corrigir)',
          !!o && o.veredito === 'corrigir', o ? o.veredito : 'ausente');
        check('prisão ' + pr.city + ': coord == manifesto',
          !!o && Math.abs(o.coord[0] - L[8][0]) <= 1.5e-6 && Math.abs(o.coord[1] - L[8][1]) <= 1.5e-6,
          JSON.stringify(L[8]));
        check('prisão ' + pr.city + ': obs documenta evidência + revisão datada',
          L[15].some(x => /evidência:/.test(x)) &&
          L[15].some(x => /revisão manual corrigir \(\d{4}-\d{2}-\d{2}\)/.test(x)),
          String(L[15].length) + ' obs');
        check('prisão ' + pr.city + ': ref de revisão manual', String(L[13]).startsWith('override:'), String(L[13]));
      }
      const m = /OSM:(node|way)\/(\d+)/.exec(String(L[13]));
      const ft = m ? osmFeats.find(f => String(f.id) === m[2]) : null;
      if (!isOvr) {
        check('prisão ' + pr.city + ': coord == feature OSM (' + L[13] + ')',
          !!ft && Math.abs(ft.lon - L[8][0]) < 1e-6 && Math.abs(ft.lat - L[8][1]) < 1e-6,
          ft ? ft.lon + ',' + ft.lat : 'feature ausente');
      }
      check('prisão ' + pr.city + ': dentro do município',
        inFeature(ringsByGeo.get(L[2]) || [], L[8][0], L[8][1]) || L[12] === 'edge');
    }
    // manifesto: proveniência publicada + pareceres 'documentar' em obs
    const crypto = require('crypto');
    const ovrSha = crypto.createHash('sha256').update(fs.readFileSync(ovrPath)).digest('hex');
    check('fontes: revisoes_manuais presente com sha256 do manifesto',
      catIdx.fontes && catIdx.fontes.revisoes_manuais &&
      catIdx.fontes.revisoes_manuais.sha256 === ovrSha,
      catIdx.fontes && catIdx.fontes.revisoes_manuais ? catIdx.fontes.revisoes_manuais.sha256.slice(0, 12) : 'ausente');
    let nDoc = 0;
    for (const o of ovr.overrides) {
      if (o.veredito !== 'documentar') continue;
      const L = rowFor(o.local.mun_tse, o.local.zona, o.local.local_code);
      if (!L) { check('documentar ' + o.local.mun_tse + '/' + o.local.local_code + ': local no catálogo', false, 'ausente'); continue; }
      const has = L[15].some(x => String(x).startsWith('revisão manual documentar (' + o.revisado_em + ')'));
      if (!has) { check('documentar ' + L[4] + ': parecer registrado em obs', false, String(L[15].length) + ' obs'); continue; }
      nDoc++;
      check('documentar ' + L[4] + ': coord do pipeline automático (não do manifesto)',
        (String(L[9]).includes('TSE') || String(L[9]).includes('OSM')), String(L[9]));
    }
    check('todos os documentar com parecer em obs',
      nDoc === ovr.overrides.filter(o => o.veredito === 'documentar').length, String(nDoc));
    // correções manuais (corrigir) além das prisões: mesmas garantias
    for (const o of ovr.overrides) {
      if (o.veredito !== 'corrigir') continue;
      const L = rowFor(o.local.mun_tse, o.local.zona, o.local.local_code);
      if (!L) { check('corrigir ' + o.local.mun_tse + '/' + o.local.local_code + ': local no catálogo', false, 'ausente'); continue; }
      check('corrigir ' + L[4] + ': coord publicada == manifesto',
        !!L[8] && Math.abs(o.coord[0] - L[8][0]) <= 1.5e-6 && Math.abs(o.coord[1] - L[8][1]) <= 1.5e-6,
        JSON.stringify(L[8]) + ' vs ' + JSON.stringify(o.coord));
      check('corrigir ' + L[4] + ': fonte = revisão manual + ref override',
        String(L[9]).includes('revisão manual') && String(L[13]).startsWith('override:'), L[9] + ' / ' + L[13]);
      check('corrigir ' + L[4] + ': dentro do município (ou edge)',
        !!L[8] && (inFeature(ringsByGeo.get(L[2]) || [], L[8][0], L[8][1]) || L[12] === 'edge'), L[12]);
      check('corrigir ' + L[4] + ': coord anterior TSE preservada em obs',
        L[15].some(x => String(x).startsWith('coord oficial TSE anterior:')) ||
        L[15].some(x => String(x).includes('sentinela -1,-1')),
        String(L[15].length) + ' obs');
    }
  }
}

console.log('== 9) front-end (DOM shim) ==');
(async () => {
  function makeEl(tag) {
    return {
      tagName: tag, innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
      value: '', files: [], children: [], listeners: {},
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, force) { const want = force === undefined ? !this._s.has(c) : !!force; if (want) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); } },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      removeEventListener() {},
      setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs && this.attrs[k]; },
      querySelector() { return makeEl('child'); },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { width: 1000, height: 700, left: 0, top: 0 }; },
      click() {}, appendChild(c) { this.children.push(c); }, remove() {},
      createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return this; } }; },
      getScreenCTM() { return null; }
    };
  }
  const IDS = ['dropZone', 'results', 'fileActions', 'errBox', 'btnLoad', 'fileInput', 'btnSample',
    'btnSample2', 'btnSvg', 'btnJson', 'chips', 'warnBox', 'mapBox', 'hudTitle', 'hudLegend', 'tip',
    'btnTse', 'tsePanel', 'tseGoDrop', 'tseNum', 'btnTseList', 'btnTseMap', 'tseSel', 'tseStatus',
    'tseStatusText', 'tseBar', 'tseSize', 'tseBig', 'btnIllus'];
  const els = {};
  IDS.forEach(id => els[id] = makeEl(id));
  let blockGeo = false;
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
    if (blockGeo && String(url).includes('geo_loc')) return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('HTTP 404')) });
    const p = path.join(ROOT, url);
    const ex = fs.existsSync(p);
    return Promise.resolve({
      ok: ex,
      json: () => ex ? Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) : Promise.reject(new Error('HTTP 404'))
    });
  };
  global.URL = global.URL || {};
  global.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
  global.URL.createObjectURL = () => 'blob:fake';
  global.URL.revokeObjectURL = () => {};
  win.ResumoCore = Core;
  delete require.cache[require.resolve('../js/app.js')];
  require('../js/app.js');
  const init = doc.listeners['DOMContentLoaded'];
  check('app carregado', !!init);
  await init();

  // esperado: nº de locais verificados com >= 1 seção do 1333
  const idxOf = new Map(sec2loc.map(r => [r[0] + '/' + r[1] + '/' + r[2], r[3]]));
  const expLoc = new Set();
  const expNoGeo = new Set();
  for (const s of sample.sections) {
    const i = idxOf.get(s.muni + '/' + s.zona + '/' + s.secao);
    if (i === undefined || i < 0) expNoGeo.add(s.muni + '/' + s.zona + '/' + s.secao);
    else expLoc.add(i);
  }
  await els.btnSample.listeners.click[0]();
  const svg = els.mapBox.innerHTML;
  const nDots = (svg.match(/class="dot"/g) || []).length;
  const nIll = (svg.match(/class="dot dot-ill"/g) || []).length;
  check('marcadores = locais verificados do 1333 (1 marcador/local)',
    nDots === expLoc.size, `achou ${nDots}, esperado ${expLoc.size}`);
  check('sem ilustrativos por padrão (nNoGeo = ' + expNoGeo.size + ')', nIll === 0, String(nIll));
  const aria = /aria-label="([^"]*)"/.exec(svg);
  check('aria-label: coordenada verificada', !!aria && aria[1].includes('verificada'), aria ? aria[1].slice(-100) : '');
  check('HUD: locais verificados + seções sem coordenada',
    els.hudTitle.innerHTML.includes('local(is) de votação com coordenada verificada'));
  check('legenda: verificado + ilustrativo',
    els.hudLegend.innerHTML.includes('verificado') && els.hudLegend.innerHTML.includes('ilustrativo'));
  if (expNoGeo.size > 0) {
    check('aviso: seções sem coordenada', /sem coordenada verificada/.test(els.warnBox.innerHTML), els.warnBox.innerHTML.slice(0, 80));
    check('botão modo ilustrativo visível com contagem',
      els.btnIllus.hidden === false && els.btnIllus.textContent.includes(String(expNoGeo.size)),
      els.btnIllus.textContent);
  }
  // totais preservados
  check('chips: totais preservados (4.876 / 3.397 / 224 de 295)',
    els.chips.innerHTML.includes('4.876') && els.chips.innerHTML.includes('3.397') && els.chips.innerHTML.includes('224 de 295'));

  // toggle modo ilustrativo: adiciona apenas círculos ocos; marcadores
  // verificados não se movem
  const before = svg.match(/class="dot" cx="([\d.]+)" cy="([\d.]+)"/g) || [];
  await els.btnIllus.listeners.click[0]();
  const svg2 = els.mapBox.innerHTML;
  const nIll2 = (svg2.match(/class="dot dot-ill"/g) || []).length;
  const after = (svg2.match(/class="dot" cx="([\d.]+)" cy="([\d.]+)"/g) || []).filter(x => !x.includes('dot-ill'));
  check('toggle: adiciona ' + expNoGeo.size + ' círculos ocos ilustrativos',
    nIll2 === expNoGeo.size, String(nIll2));
  check('toggle: marcadores verificados não se movem',
    after.length === before.length && before.every((b, i) => b === after[i]),
    `${before.length} -> ${after.length}`);
  await els.btnIllus.listeners.click[0]();
  check('toggle: desligar remove ilustrativos',
    (els.mapBox.innerHTML.match(/class="dot dot-ill"/g) || []).length === 0);

  // modo snapshot: mesmo resultado (identidade entre modos)
  const radio = doc.querySelector; // noop
  const sel = els.tseNum;
  sel.value = '1333';
  doc.querySelectorAll = () => [];
  const radioEl = makeEl('input'); radioEl.value = 'DEPUTADO FEDERAL';
  doc.querySelector = s => String(s).includes('tseCargo') ? radioEl : null;
  await els.btnTseMap.listeners.click[0]();
  await new Promise(r => setTimeout(r, 80));
  const nDots3 = (els.mapBox.innerHTML.match(/class="dot"/g) || []).length;
  check('snapshot 1333: mesmo nº de marcadores (consistência entre modos)',
    nDots3 === expLoc.size, `${nDots3} vs ${expLoc.size}`);

  // fallback sem catálogo (404 em geo_loc) -> modo ilustrativo explícito
  blockGeo = true;
  delete require.cache[require.resolve('../js/app.js')];
  // re-monta o app do zero com o catálogo bloqueado
  const els2 = {};
  IDS.forEach(id => els2[id] = makeEl(id));
  const doc2 = {
    getElementById: id => els2[id] || (els2[id] = makeEl(id)),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: t => makeEl(t),
    addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = fn; },
    body: makeEl('body')
  };
  const win2 = { addEventListener() {}, innerWidth: 1400, innerHeight: 900, scrollTo() {} };
  win2.ResumoCore = Core;
  global.window = win2; global.document = doc2; global.self = win2;
  require('../js/app.js');
  const init2 = doc2.listeners['DOMContentLoaded'];
  await init2();
  await els2.btnSample.listeners.click[0]();
  const svg4 = els2.mapBox.innerHTML;
  const nDots4 = (svg4.match(/class="dot"/g) || []).length;
  const nIll4 = (svg4.match(/class="dot dot-ill"/g) || []).length;
  const aria4 = /aria-label="([^"]*)"/.exec(svg4);
  check('sem catálogo: nenhum marcador por padrão (estado indisponível)',
    nDots4 === 0 && nIll4 === 0, `${nDots4}/${nIll4}`);
  check('sem catálogo: aria declara georreferenciamento indisponível',
    !!aria4 && /indisponível/.test(aria4[1]), aria4 ? aria4[1].slice(-90) : '');
  check('sem catálogo: aviso explícito (sem ponto sintético)',
    /indisponível/.test(els2.warnBox.innerHTML), els2.warnBox.innerHTML.slice(0, 80));
  check('sem catálogo: totais preservados (chips)',
    els2.chips.innerHTML.includes('4.876') && els2.chips.innerHTML.includes('3.397'), els2.chips.innerHTML.slice(0, 120));
  check('sem catálogo: botão modo ilustrativo visível',
    els2.btnIllus.hidden === false && /Modo ilustrativo/.test(els2.btnIllus.textContent), els2.btnIllus.textContent);
  // escolha explícita: modo ilustrativo (3397 pontos ocos, modo declarado)
  await els2.btnIllus.listeners.click[0]();
  const svg5 = els2.mapBox.innerHTML;
  const nIll5 = (svg5.match(/class="dot dot-ill"/g) || []).length;
  const aria5 = /aria-label="([^"]*)"/.exec(svg5);
  check('sem catálogo + modo ilustrativo: 3397 pontos ocos', nIll5 === 3397, String(nIll5));
  check('sem catálogo + modo ilustrativo: aria declara ILUSTRATIVO',
    !!aria5 && /ILUSTRATIV/.test(aria5[1]), aria5 ? aria5[1].slice(-80) : '');

  console.log(ok ? '\nGEO-VERIFY OK' : '\nGEO-VERIFY FALHOU');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('EXCEÇÃO:', e); process.exit(1); });
