/* Compara o pipeline JS (app) com o mapa gerado pelo Python (já publicado). */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const ROOT = path.join(__dirname, '..');

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'geo_sc_municipios.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '1333_sc_2026.json'), 'utf8'));
// referência: fixture gerada por test/gen_mapa_1333_ref.py (regenerar com
// `python3 test/gen_mapa_1333_ref.py data/geo_sc_municipios.json test/fixture_1333`
// se o gerador ou os dados mudarem)
const html = fs.readFileSync(path.join(ROOT, 'test', 'fixture_1333', '1333_sc_mapa.html'), 'utf8');

// 1) índice de geometria + mapeamento TSE -> IBGE
const { feats, geoByName } = C.buildGeoIndex(geo);
const { tse2geo, unmatched, ambiguous } = C.mapTseToGeo(data.mun, geoByName);
console.log('mapeados', tse2geo.size, '/', Object.keys(data.mun).length,
  '| sem geometria:', unmatched.length, '| ambíguos:', ambiguous.length);
if (unmatched.length) { unmatched.slice(0,5).forEach(u => console.log('  SEM GEO:', u)); process.exit(1); }

// 2) projeção
const rings = feats.map(f => f[2]);
const proj = C.makeProjector(rings);
const ringByGeo = new Map(feats.map(f => [f[0], f[2]]));

// 3) seções agrupadas por município IBGE (ordem de aparição)
const munSections = new Map();
for (const s of data.sections) {
  const g = tse2geo.get(s.muni);
  if (!g) continue;
  if (!munSections.has(g)) munSections.set(g, []);
  munSections.get(g).push(s);
}
const sortedKeys = [...munSections.keys()].sort();
const dots = [];
for (const g of sortedKeys) {
  const ring = ringByGeo.get(g);
  const pts = C.placePoints(ring, munSections.get(g).length, parseInt(g, 10));
  if (pts.length !== munSections.get(g).length) {
    console.log('ERRO: pontos insuficientes para', g, pts.length, munSections.get(g).length); process.exit(1);
  }
  for (const p of pts) {
    const [x, y] = proj.P(p[0], p[1]);
    dots.push([x, y]);
  }
}

// 4) pontos do HTML gerado pelo Python (mesma ordem: data-i 0..n-1)
const re = /<circle class="dot" data-i="(\d+)" cx="([\d.]+)" cy="([\d.]+)"/g;
const py = new Map();
let m;
while ((m = re.exec(html)) !== null) py.set(+m[1], [+m[2], +m[3]]);
console.log('dots JS:', dots.length, '| dots HTML:', py.size);
if (dots.length !== py.size) process.exit(1);

let diff = 0;
for (let i = 0; i < dots.length; i++) {
  const [px, pyy] = py.get(i);
  if (px !== dots[i][0] || pyy !== dots[i][1]) {
    diff++;
    if (diff <= 3) console.log('DIFF', i, 'JS', dots[i], 'PY', [px, pyy]);
  }
}
console.log(diff === 0 ? '✓ 3397 pontos idênticos ao mapa publicado' : `✗ ${diff} pontos diferentes`);
process.exit(diff === 0 ? 0 : 1);
