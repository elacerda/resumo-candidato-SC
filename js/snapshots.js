(function (root) {
  'use strict';
  /** Reconstitui um candidato sem alterar a ordem oficial das seções.
   * A categoria permanece nominal; historico indica ausência no cadastro EA20
   * atual e classificacao=null declara que o CSV não classifica juridicamente votos.
   * @param {Object} idx Índice v2. @param {string} cargo Cargo oficial.
   * @param {string} numero Número nominal. @param {Object} votes Arquivo individual.
   * @param {Object} table Tabela compartilhada de seções.
   * @returns {Object} Dataset do mapa. @throws {Error} Referências ou somas inválidas.
   */
  function dataset(idx, cargo, numero, votes, table) {
    if (votes.schema !== 2 || votes.eleicao_id !== (idx.cargos[cargo].eleicao_id || null) || votes.numero !== numero || votes.cargo !== cargo || votes.turno !== idx.turno || votes.uf !== idx.uf || votes.eleicao !== idx.eleicao) throw new Error('Identidade do snapshot incompatível');
    const meta = idx.cargos[cargo].candidatos[numero], mun = {}, sections = [], seen = new Set();
    let total = 0;
    for (const [i, v] of votes.votos) {
      if (!Number.isInteger(i) || seen.has(i) || !Number.isSafeInteger(v) || v <= 0 || !table.secoes[i]) throw new Error('Referência de seção inválida');
      seen.add(i);
      const s = table.secoes[i], m = table.mun[s[0]];
      if (!m) throw new Error('Município inválido');
      const [code, nome] = m;
      const row = mun[code] || (mun[code] = { nome, votos: 0, secoes: 0 });
      row.votos += v; row.secoes++; total += v;
      sections.push({ muni: code, muni_nome: nome, zona: s[1], secao: s[2], votos: v, local: s[3], end: s[4] });
    }
    if (total !== meta[1] || sections.length !== meta[2] || Object.keys(mun).length !== meta[3]) throw new Error('Somas do snapshot incompatíveis');
    return { total, mun, sections, nome: meta[0], categoria: 'nominal', historico: (idx.cargos[cargo].sem_cadastro_ea20 || []).includes(numero), classificacao: null };
  }
  /** Cliente sob demanda; nunca consulta ZIPs nem arquivos de cargo inteiro.
   * @param {Function} fetcher Fetch. @param {string} base Diretório estático.
   * @returns {Object} Métodos index, file e candidate; falhas não ficam em cache.
   */
  function createClient(fetcher, base = 'data/tse_2026/') {
    const cache = new Map(), bodies = new Map(), verified = new Map();
    async function verify(name, expected) {
      if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Hash do snapshot ausente ou inválido');
      const key = name + '/' + expected;
      if (!verified.has(key)) verified.set(key, (async () => {
        if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error('Verificação de integridade indisponível; abra por HTTPS ou localhost.');
        const bytes = new TextEncoder().encode(bodies.get(name));
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        const actual = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
        if (actual !== expected) throw new Error('Snapshot incompatível: hash SHA-256 diferente em ' + name + '. Recarregue a página.');
      })().catch(e => { verified.delete(key); cache.delete(name); bodies.delete(name); throw e; }));
      return verified.get(key);
    }
    function file(name) {
      if (!/^[\w/.-]+\.json$/.test(name) || name.includes('..')) throw new Error('Caminho de snapshot inválido');
      if (!cache.has(name)) cache.set(name, fetcher(base + name).then(async r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' no snapshot');
        if (typeof r.text === 'function') {
          const text = await r.text(); bodies.set(name, text); return JSON.parse(text);
        }
        // Adaptadores de teste sem Response.text usam JSON compacto canônico.
        const value = await r.json(); bodies.set(name, JSON.stringify(value)); return value;
      }).catch(e => { cache.delete(name); throw e; }));
      return cache.get(name);
    }
    return { file, index: () => file('index.json'), async candidate(cargo, numero, turno = '1') {
      const idx = await file('index.json');
      if (idx.schema !== 2 || idx.uf !== 'SC' || idx.turno !== turno) return null;
      const c = idx.cargos[cargo];
      if (!c || !Object.hasOwn(c.candidatos, numero)) return null;
      const name = c.diretorio + '/' + numero + '.json';
      const [votes, table] = await Promise.all([file(name), file(idx.secoes)]);
      await Promise.all([verify(name, c.arquivos_sha256[numero]), verify(idx.secoes, idx.secoes_sha256)]);
      return dataset(idx, cargo, numero, votes, table);
    } };
  }
  const api = { dataset, createClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Snapshots = api;
})(typeof window !== 'undefined' ? window : globalThis);
