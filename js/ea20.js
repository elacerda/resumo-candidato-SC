/* Contrato EA20 observado em respostas oficiais de 2026; sem votos por seção. */
(function (root) {
  'use strict';
  /** Converte contador oficial decimal inteiro; rejeita ausência e valores inválidos.
   * @param {string|number} value Contador de votos ou seções.
   * @returns {number} Inteiro não negativo. @throws {Error} Contador inválido.
   */
  function integer(value) {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Contador EA20 inválido');
    return Number(value);
  }
  /** Normaliza EA20 preservando classificações oficiais e metadados de totalização.
   * @param {Object} raw JSON oficial. @param {Object} expected Identidade esperada (ele, t, cargo, tpabr, cdabr).
   * @returns {Object} Candidatos nominais, partidos e contadores separados.
   * @throws {Error} Identidade ou estrutura incompatível.
   */
  function normalize(raw, expected) {
    for (const k of ['ele', 't', 'tpabr', 'cdabr']) {
      if (expected[k] !== undefined && String(raw[k]) !== String(expected[k])) throw new Error('EA20: abrangência/eleição incompatível: ' + k);
    }
    if (raw.f !== 'o' || !['1', '2'].includes(raw.t)) throw new Error('EA20 não oficial ou turno inválido');
    const cargo = raw.carg.find(c => String(c.cd) === String(expected.cargo));
    if (!cargo) throw new Error('Cargo ausente do EA20');
    const candidatos = [], partidos = [];
    for (const agr of cargo.agr) for (const par of agr.par) {
      partidos.push({ numero: par.n, nome: par.nm, sigla: par.sg, classificacao: par.dvt || null,
        legenda: par.tvtl === undefined ? null : integer(par.tvtl), legendaValida: par.tval === undefined ? null : integer(par.tval) });
      for (const c of par.cand || []) candidatos.push({ numero: c.n, id: c.sqcand, nome: c.nm,
        urna: c.nmu, votos: integer(c.vap), classificacao: c.dvt, situacao: c.st, eleito: c.e,
        partido: par.n, categoria: 'nominal' });
    }
    if (new Set(candidatos.map(c => c.numero)).size !== candidatos.length || candidatos.some(c => !c.id || !c.classificacao || !c.situacao)) throw new Error('Cadastro EA20 inválido');
    return { schema: 1, eleicaoId: raw.ele, turno: raw.t, cargo: cargo.nmn, cargoId: cargo.cd,
      abrangencia: { tipo: raw.tpabr, codigo: raw.cdabr }, atualizado: raw.dt + ' ' + raw.ht,
      gerado: raw.dg + ' ' + raw.hg, idg: raw.idg, andamento: raw.and, totalizacaoFinal: raw.tf,
      secoes: raw.s, votos: raw.v, candidatos, partidos };
  }
  /** Descobre eleições/cargos no EA11, sem constantes de códigos eleitorais.
   * @param {Object} config EA11. @param {string} ciclo Ciclo oficial. @returns {Array<Object>} Opções de cargo e turno.
   */
  function elections(config, ciclo) {
    return config.pl.filter(p => p.c === ciclo).flatMap(p => p.e.flatMap(e => e.abr.flatMap(a => a.cp.flatMap(c => {
      return [{ ciclo: p.c, cargo: c.cd, nome: c.ds, ele: e.cd, t: e.t, uf: a.cd }];
    }))));
  }
  /** Cria cliente de JSONs pequenos com cache de promessas e recuperação após falha.
   * @param {Function} fetcher Implementação de fetch. @returns {Object} Método get(url, expected).
   */
  function createClient(fetcher) {
    const cache = new Map();
    return { async get(url, expected) {
      if (!cache.has(url)) cache.set(url, fetcher(url).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' no EA20');
        return r.json();
      }).catch(e => { cache.delete(url); throw e; }));
      return normalize(await cache.get(url), expected);
    } };
  }
  const api = { integer, normalize, elections, createClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ea20 = api;
})(typeof window !== 'undefined' ? window : globalThis);
