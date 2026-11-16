(function (root) {
  'use strict';
  /** Serviço eleitoral: mantém agregados e seções como fontes independentes.
   * @param {Function} fetcher Fetch HTTP. @param {Object} snapshots Cliente granular.
   * @param {Object} ea20 Cliente EA20. @returns {Object} Métodos aggregate e candidate.
   */
  function createService(fetcher, snapshots, ea20) {
    let manifest;
    async function aggregate(cargo, turno = '1', municipio = '', zona = '') {
      if (!manifest) {
        const r = await fetcher('data/ea20/index.json');
        if (!r.ok) throw new Error('Resultados agregados indisponíveis');
        manifest = await r.json();
      }
      const e = manifest.resultados.find(x => x.cargo === cargo && x.t === turno);
      if (!e) throw new Error('Cargo/turno indisponível em Santa Catarina');
      if (municipio && !/^\d{5}$/.test(municipio) || zona && (!municipio || !/^\d{1,4}$/.test(zona))) throw new Error('Município/zona inválidos');
      let url = 'data/ea20/' + e.arquivo;
      // Nomenclatura oficial confirmada no manual e em respostas reais.
      if (municipio) url = e.url.replace('/sc-c', '/sc' + municipio + (zona ? '-z' + zona.padStart(4, '0') : '') + '-c');
      const result = await ea20.get(url, { ele: e.ele, t: turno, cargo: e.cargoId,
        tpabr: zona ? 'zona' : municipio ? 'mu' : 'uf', cdabr: zona ? zona.padStart(4, '0') : municipio || 'sc' });
      result.fonte = url;
      return result;
    }
    return { aggregate, candidate: (cargo, numero, turno) => snapshots.candidate(cargo, numero, turno) };
  }
  const api = { createService };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Electoral = api;
})(typeof window !== 'undefined' ? window : globalThis);
