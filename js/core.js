/* Resumo Candidato — SC: núcleo de geometria/projeção.
 * MT19937 bit-idêntico ao CPython (random.Random). Posicionamento das
 * seções: sorteio determinístico e uniforme DENTRO do polígono do
 * município, seedeado pela IDENTIDADE da seção (município + zona +
 * seção). Os pontos são ILUSTRATIVOS: o TSE não publica coordenadas
 * das seções — ver README ("Semântica geográfica do mapa"). */
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

  // ---- geometria (WGS84, anéis = [[lon, lat], ...]) ----
  /** Todos os anéis exteriores de uma feature (Polygon ou MultiPolygon).
   *
   * @param {{type: string, coordinates: any}} geom geometria GeoJSON.
   * @returns {number[][][]} lista de anéis exteriores (lon, lat).
   */
  function ringsOf(geom) {
    if (geom.type === 'Polygon') return [geom.coordinates[0]];
    return geom.coordinates.map(p => p[0]);
  }
  /** Maior anel (por nº de vértices) — usado p/ posicionar rótulos.
   *
   * @param {number[][][]} rings anéis exteriores.
   * @returns {number[][]} anel maior.
   */
  function biggestRing(rings) {
    return rings.reduce((best, r) => (r.length > best.length ? r : best));
  }
  /** Bounding box da união dos anéis.
   *
   * @param {number[][][]} rings anéis exteriores.
   * @returns {[number, number, number, number]} [minLon, minLat, maxLon, maxLat].
   */
  function bboxAll(rings) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const ring of rings) for (const p of ring) {
      if (p[0] < minx) minx = p[0];
      if (p[1] < miny) miny = p[1];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] > maxy) maxy = p[1];
    }
    return [minx, miny, maxx, maxy];
  }
  /** Point-in-polygon (ray casting, paridade) na UNIÃO dos anéis.
   *
   * @param {number[][][]} rings anéis exteriores.
   * @param {number} x longitude (graus).
   * @param {number} y latitude (graus).
   * @returns {boolean} true se (x, y) está em algum anel.
   */
  function inAnyPoly(rings, x, y) {
    for (const ring of rings) {
      let inside = false;
      let j = ring.length - 1;
      for (let i = 0; i < ring.length; i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        j = i;
      }
      if (inside) return true;
    }
    return false;
  }
  function decimate(ring, step) {
    const pts = [];
    for (let i = 0; i < ring.length; i += step) pts.push(ring[i]);
    if (pts[0] !== ring[ring.length - 1]) pts.push(ring[ring.length - 1]);
    return pts;
  }
  /** Média dos vértices (amostrados a cada 5) de um anel — aproximação
   * do centro, p/ rótulos de município.
   *
   * @param {number[][]} ring anel (lon, lat).
   * @returns {[number, number]} [lon, lat].
   */
  function centroid(ring) {
    const rs = [];
    for (let i = 0; i < ring.length; i += 5) rs.push(ring[i]);
    let sx = 0, sy = 0;
    for (const p of rs) { sx += p[0]; sy += p[1]; }
    return [sx / rs.length, sy / rs.length];
  }
  /** Média dos vértices de todos os anéis (fallback de posicionamento).
   *
   * @param {number[][][]} rings anéis exteriores.
   * @returns {[number, number]} [lon, lat].
   */
  function centroidAll(rings) {
    const rs = [];
    for (const ring of rings) for (let i = 0; i < ring.length; i += 5) rs.push(ring[i]);
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

  // ---- posicionamento das seções (ilustrativo, por identidade) ----
  // O TSE NÃO publica coordenadas das seções/locais de votação. A posição
  // de cada seção é, portanto, um ponto ilustrativo DENTRO do polígono do
  // município (WGS84), sorteado de forma determinística e uniforme a
  // partir da identidade da seção (município IBGE + zona + seção).
  // Consequência: a mesma seção aparece SEMPRE no mesmo ponto, em qualquer
  // candidato, cargo ou dataset — mas o ponto NÃO é o endereço real da
  // seção (o endereço real só existe como texto nos dados do TSE).
  /**
   * Semente determinística (32 bits) da identidade da seção.
   *
   * FNV-1a sobre os bytes little-endian de (muniId, zona, secao), com o
   * finalizer do Murmur3-32. Somente aritmética inteira de 32 bits
   * (>>> 0, Math.imul) — determinístico em qualquer motor JS.
   *
   * @param {number} muniId código IBGE do município (ex.: 4209102).
   * @param {number} zona   zona eleitoral (inteiro >= 0).
   * @param {number} secao  seção eleitoral (inteiro >= 0).
   * @returns {number} semente 32-bit.
   */
  function sectionSeed(muniId, zona, secao) {
    let h = 0x811c9dc5;
    const push = u => {
      u >>>= 0;
      for (let i = 0; i < 4; i++) {
        h ^= (u >>> (i * 8)) & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    };
    push(muniId); push(zona); push(secao);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }
  /**
   * Posição (lon, lat) WGS84 de uma seção dentro do município.
   *
   * Sorteio determinístico e uniforme: MT19937 (bit-idêntico ao CPython)
   * seedeado por `sectionSeed(muniId, zona, secao)`, com rejeição sobre o
   * bbox da união dos anéis (até 64 tentativas). Fallback determinístico:
   * média dos vértices dos anéis; se ainda fora, centro do bbox.
   * A distribuição condicionada ao polígono é uniforme em área.
   *
   * @param {number[][][]} rings    anéis exteriores do município (lon, lat).
   * @param {number}        muniId  código IBGE do município.
   * @param {string|number} zona    zona eleitoral.
   * @param {string|number} secao   seção eleitoral.
   * @returns {[number, number]} [lon, lat] WGS84 dentro do município.
   */
  function placeSection(rings, muniId, zona, secao) {
    const [bx0, by0, bx1, by1] = bboxAll(rings);
    if (!(bx1 > bx0 && by1 > by0)) return [(bx0 + bx1) / 2, (by0 + by1) / 2];
    const rng = new MT19937(sectionSeed(muniId, zona >>> 0 | 0, secao >>> 0 | 0));
    for (let t = 0; t < 64; t++) {
      const lon = rng.uniform(bx0, bx1), lat = rng.uniform(by0, by1);
      if (inAnyPoly(rings, lon, lat)) return [lon, lat];
    }
    const c = centroidAll(rings);
    if (inAnyPoly(rings, c[0], c[1])) return c;
    return [(bx0 + bx1) / 2, (by0 + by1) / 2];
  }

  function dotR(v) { return Math.round((1.3 + 0.55 * Math.min(v - 1, 4)) * 100) / 100; }

  function fillFor(v, maxmun) {
    if (!v) return null;
    const t = Math.log2(v + 1) / Math.log2(maxmun + 1);
    return Math.round((0.12 + 0.73 * t) * 1000) / 1000;
  }

  /**
   * Índice da malha: uma entrada por feature [código IBGE, nome, anéis].
   *
   * Mantém TODOS os anéis exteriores (MultiPolygon: ilhas/penínsulas
   * inclusas) e o mapa nome normalizado -> [códigos IBGE].
   *
   * @param {{features: any[]}} geo FeatureCollection (WGS84).
   * @returns {{feats: [string, string, number[][][]][], geoByName: Map<string, string[]>}}
   */
  function buildGeoIndex(geo) {
    const feats = [];
    const geoByName = new Map();
    for (const f of geo.features) {
      const p = f.properties || {};
      const muni = String(p.id != null ? p.id : '');
      const nome = p.name || p.description || '';
      feats.push([muni, nome, ringsOf(f.geometry)]);
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

  const Core = { norm, MT19937, ringsOf, biggestRing, bboxAll, inAnyPoly, decimate, centroid, centroidAll, makeProjector, sectionSeed, placeSection, dotR, fillFor, buildGeoIndex, mapTseToGeo, parseDataset };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.ResumoCore = Core;
})(typeof self !== 'undefined' ? self : globalThis);
