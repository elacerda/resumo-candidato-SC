/* Resumo Candidato — SC: núcleo de geometria/projeção.
 * Porta 1:1 do gerador Python original (fora do repo), incluindo o Mersenne
 * Twister do Python (random.Random) para posições idênticas dos pontos. */
(function (root) {
  'use strict';

  function norm(s) {
    s = String(s == null ? '' : s).normalize('NFKD');
    s = s.replace(/[\u0300-\u036f]/g, '');
    return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // ---- Mersenne Twister (mesmo algoritimo de CPython random.Random) ----
  function MT19937(seed) {
    this.mt = new Uint32Array(624);
    this.idx = 624;
    this.mt[0] = 19650218;
    for (let i = 1; i < 624; i++) {
      const x = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, x) + i) >>> 0;
    }
    const key = [seed >>> 0];
    let i = 1, j = 0, k;
    for (k = 624; k > 0; k--) {
      const x = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (this.mt[i] ^ (Math.imul(x, 1664525) >>> 0)) >>> 0;
      this.mt[i] = (this.mt[i] + key[j] + j) >>> 0;
      i++; j++;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (k = 623; k > 0; k--) {
      const x = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (this.mt[i] ^ (Math.imul(x, 1566083941) >>> 0)) >>> 0;
      this.mt[i] = (this.mt[i] - i) >>> 0;
      i++;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
    }
    this.mt[0] = 0x80000000;
  }
  MT19937.prototype.nextUint32 = function () {
    const mt = this.mt;
    if (this.idx >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = (mt[i] & 0x80000000) | (mt[(i + 1) % 624] & 0x7fffffff);
        mt[i] = (mt[(i + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      this.idx = 0;
    }
    let y = mt[this.idx++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  };
  // res53: mesma fórmula de CPython random.Random.random()
  MT19937.prototype.random = function () {
    const a = this.nextUint32() >>> 5, b = this.nextUint32() >>> 6;
    return (a * 67108864 + b) * (1 / 9007199254740992);
  };
  MT19937.prototype.uniform = function (a, b) { return a + (b - a) * this.random(); };

  // ---- geometria ----
  function ringOf(geom) {
    if (geom.type === 'Polygon') return geom.coordinates[0];
    const rings = geom.coordinates.map(p => p[0]);
    return rings.reduce((best, r) => (r.length > best.length ? r : best));
  }
  function bbox(ring) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const p of ring) {
      if (p[0] < minx) minx = p[0];
      if (p[1] < miny) miny = p[1];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] > maxy) maxy = p[1];
    }
    return [minx, miny, maxx, maxy];
  }
  function inPoly(x, y, ring) {
    let inside = false;
    let j = ring.length - 1;
    for (let i = 0; i < ring.length; i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      j = i;
    }
    return inside;
  }
  function decimate(ring, step) {
    const pts = [];
    for (let i = 0; i < ring.length; i += step) pts.push(ring[i]);
    if (pts[0] !== ring[ring.length - 1]) pts.push(ring[ring.length - 1]);
    return pts;
  }
  function centroid(ring) {
    const rs = [];
    for (let i = 0; i < ring.length; i += 5) rs.push(ring[i]);
    let sx = 0, sy = 0;
    for (const p of rs) { sx += p[0]; sy += p[1]; }
    return [sx / rs.length, sy / rs.length];
  }

  // projeção equiretangular (idêntica ao Python)
  function makeProjector(rings) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const ring of rings) for (const p of ring) {
      if (p[0] < minx) minx = p[0];
      if (p[1] < miny) miny = p[1];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] > maxy) maxy = p[1];
    }
    const kx = Math.cos((miny + maxy) / 2 * Math.PI / 180);
    const W = 980, pad = 14;
    const scale = W / ((maxx - minx) * kx);
    const H = Math.ceil((maxy - miny) * scale);
    return {
      W: W, H: H, pad: pad,
      P: (lon, lat) => [
        Math.round((pad + (lon - minx) * kx * scale) * 10) / 10,
        Math.round((pad + (maxy - lat) * scale) * 10) / 10
      ]
    };
  }

  // n pontos determinísticos dentro do polígono (grade + jitter + rejeição)
  function placePoints(ring, n, seed) {
    const rng = new MT19937(seed);
    const [bx0, by0, bx1, by1] = bbox(ring);
    const pts = [];
    if (n > 0 && (bx1 - bx0) > 0 && (by1 - by0) > 0) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n * (bx1 - bx0) / (by1 - by0))));
      const rows = Math.max(1, Math.ceil(n / cols));
      const cw = (bx1 - bx0) / cols, ch = (by1 - by0) / rows;
      outer:
      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          if (pts.length >= n) break outer;
          const lon = bx0 + (rx + 0.5) * cw + rng.uniform(-0.45, 0.45) * cw;
          const lat = by0 + (ry + 0.5) * ch + rng.uniform(-0.45, 0.45) * ch;
          if (inPoly(lon, lat, ring)) pts.push([lon, lat]);
        }
      }
      let tries = 0;
      while (pts.length < n && tries < n * 40) {
        tries++;
        const lon = rng.uniform(bx0, bx1), lat = rng.uniform(by0, by1);
        if (inPoly(lon, lat, ring)) pts.push([lon, lat]);
      }
      const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
      while (pts.length < n) pts.push([cx, cy]);
    }
    return pts;
  }

  function dotR(v) { return Math.round((1.3 + 0.55 * Math.min(v - 1, 4)) * 100) / 100; }

  function fillFor(v, maxmun) {
    if (!v) return null;
    const t = Math.log2(v + 1) / Math.log2(maxmun + 1);
    return Math.round((0.12 + 0.73 * t) * 1000) / 1000;
  }

  // índice nome normalizado -> [códigos IBGE], na ordem das features
  function buildGeoIndex(geo) {
    const feats = [];
    const geoByName = new Map();
    for (const f of geo.features) {
      const p = f.properties || {};
      const muni = String(p.id != null ? p.id : '');
      const nome = p.name || p.description || '';
      feats.push([muni, nome, ringOf(f.geometry)]);
      if (!geoByName.has(norm(nome))) geoByName.set(norm(nome), []);
      geoByName.get(norm(nome)).push(muni);
    }
    return { feats, geoByName };
  }

  // código TSE -> código IBGE (por nome normalizado)
  function mapTseToGeo(tseMun, geoByName) {
    const tse2geo = new Map();
    const unmatched = [];
    const ambiguous = [];
    for (const [m, v] of Object.entries(tseMun)) {
      const cands = geoByName.get(norm(v.nome)) || [];
      if (cands.length === 1) tse2geo.set(m, cands[0]);
      else if (cands.length > 1) { tse2geo.set(m, cands[0]); ambiguous.push([m, v.nome, cands]); }
      else unmatched.push([m, v.nome]);
    }
    return { tse2geo, unmatched, ambiguous };
  }

  // valida a estrutura do JSON do usuário
  function parseDataset(obj) {
    const errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, errors: ['O arquivo precisa ser um objeto JSON.'] };
    }
    if (!obj.mun || typeof obj.mun !== 'object' || Array.isArray(obj.mun)) {
      errors.push('Falta o objeto "mun" (código do município -> {nome, votos, secoes}).');
    }
    if (!Array.isArray(obj.sections)) {
      errors.push('Falta o array "sections" (uma entrada por seção de votação).');
    }
    if (errors.length) return { ok: false, errors };
    const sections = [];
    for (const s of obj.sections) {
      if (!s || typeof s !== 'object') { errors.push('Há entrada inválida em "sections".'); continue; }
      if (s.muni == null || s.votos == null) { errors.push('Seção sem "muni" ou "votos".'); continue; }
      sections.push({
        muni: String(s.muni),
        muniNome: String(s.muni_nome || (obj.mun[String(s.muni)] && obj.mun[String(s.muni)].nome) || ''),
        zona: String(s.zona != null ? s.zona : ''),
        secao: String(s.secao != null ? s.secao : ''),
        votos: Number(s.votos),
        local: String(s.local || ''),
        end: String(s.end || '')
      });
    }
    if (errors.length) return { ok: false, errors };
    const meta = {
      candidato: obj.candidato != null ? String(obj.candidato) : '',
      numero: obj.numero != null ? String(obj.numero) : '',
      cargo: obj.cargo != null ? String(obj.cargo) : '',
      estado: obj.estado != null ? String(obj.estado) : 'SC',
      eleicao: obj.eleicao != null ? String(obj.eleicao) : '',
      fonte: obj.fonte != null ? String(obj.fonte) : ''
    };
    return { ok: true, meta, mun: obj.mun, sections, total: Number(obj.total) || sections.reduce((a, s) => a + s.votos, 0) };
  }

  const Core = { norm, MT19937, ringOf, bbox, inPoly, decimate, centroid, makeProjector, placePoints, dotR, fillFor, buildGeoIndex, mapTseToGeo, parseDataset };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.ResumoCore = Core;
})(typeof self !== 'undefined' ? self : globalThis);
