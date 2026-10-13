/* Resumo Candidato — SC: parser do CSV oficial do TSE
 * (votacao_secao_<ANO>_<UF>.zip, latin-1, separador ';').
 * Funções puras, testáveis no Node e no navegador. */
(function (root) {
  'use strict';

  // ---- linhas completas a partir de um chunk (estado entre chunks) ----
  // Presume registros de linha única (formato máquina do TSE): uma quebra de
  // linha só termina uma linha se a paridade de aspas no buffer está fechada
  // até ela. state.buf guarda a linha incompleta do fim do chunk anterior.
  function newLineState() { return { buf: '' }; }
  function feedLines(state, text, onLine) {
    const buf = state.buf + text;
    const li = buf.lastIndexOf('\n');
    if (li < 0) { state.buf = buf; return; }
    const head = buf.slice(0, li + 1);
    state.buf = buf.slice(li + 1);
    const nl = head.split('\n');
    for (let i = 0; i < nl.length - 1; i++) onLine(nl[i].replace(/\r$/, ''));
  }

  // ---- linha -> campos (fast path: split nativo; fallback: parser p/ aspas) ----
  const NCOLS = 26;
  function parseLine(line) {
    const out = line.split(';');
    if (out.length === NCOLS) {
      // no formato TSE, campos de texto vêm entre aspas ("SC", "Deputado Federal")
      for (let i = 0; i < out.length; i++) {
        const x = out[i];
        if (x.length > 1 && x.charCodeAt(0) === 34 && x.charCodeAt(x.length - 1) === 34) out[i] = x.slice(1, -1);
      }
      return out;
    }
    // fallback: campos aspas com ';' dentro
    const f = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ';') { f.push(cur); cur = ''; }
      else cur += c;
    }
    f.push(cur);
    return f;
  }

  // decodifica bytes latin-1 em chunks de texto (1 byte = 1 char, sempre seguro)
  async function* csvChunks(bytes) {
    const dec = new TextDecoder('iso-8859-1');
    const CH = 8 * 1024 * 1024;
    for (let off = 0; off < bytes.length; off += CH) {
      yield dec.decode(bytes.subarray(off, Math.min(off + CH, bytes.length)));
    }
  }

  // varredura única: filtra UF/turno/cargo(/número) e chama onRow(f, c)
  async function scanTse(chunks, opts, onRow) {
    const st = newLineState();
    let cols = null;
    const cargoProbe = opts.cargo.toLowerCase();
    for await (const chunk of chunks) {
      feedLines(st, chunk, line => {
        if (!cols) {
          if (line.indexOf('DT_GERACAO"') <= 1) {
            const h = parseLine(line).map(x => x.replace(/^"|"$/g, ''));
            cols = {};
            for (let i = 0; i < h.length; i++) cols[h[i]] = i;
          }
          return;
        }
        // pré-filtro barato antes de parsear a linha inteira
        if (line.toLowerCase().indexOf(cargoProbe) < 0) return;
        const f = parseLine(line);
        if (f[cols.SG_UF] !== 'SC') return;
        if (f[cols.NR_TURNO] !== '1') return;
        if (f[cols.DS_CARGO].toUpperCase() !== opts.cargo) return;
        if (opts.numero && f[cols.NR_VOTAVEL] !== opts.numero) return;
        onRow(f, cols);
      });
    }
    return cols;
  }

  function isBlankOrNull(num, nome) {
    if (num === '0' || num === '1' || num === '95' || num === '99') return true;
    return /VOTO\s+(BRANCO|NULO)/.test(nome);
  }

  // lista de candidatos do cargo: [{numero, nome, votos}] (ordem: votos desc)
  async function listCandidates(chunks, cargo) {
    const map = new Map();
    await scanTse(chunks, { cargo }, (f, c) => {
      const num = f[c.NR_VOTAVEL];
      const nome = f[c.NM_VOTAVEL];
      if (isBlankOrNull(num, nome)) return;
      const v = +f[c.QT_VOTOS] || 0;
      let e = map.get(num);
      if (!e) { e = [nome, 0]; map.set(num, e); }
      else if (!e[0] && nome) e[0] = nome;
      e[1] += v;
    });
    return [...map.entries()]
      .map(([numero, [nome, votos]]) => ({ numero, nome, votos }))
      .sort((a, b) => b.votos - a.votos);
  }

  // dataset do formato do app para um candidato: {total, mun, sections, nome}
  async function candidateDataset(chunks, { cargo, numero }) {
    const mun = new Map();
    const sections = [];
    let total = 0, nome = '';
    await scanTse(chunks, { cargo, numero }, (f, c) => {
      const v = +f[c.QT_VOTOS] || 0;
      if (v <= 0) return;
      if (!nome) nome = f[c.NM_VOTAVEL];
      total += v;
      const cd = f[c.CD_MUNICIPIO];
      let m = mun.get(cd);
      if (!m) { m = { nome: f[c.NM_MUNICIPIO], votos: 0, secoes: 0 }; mun.set(cd, m); }
      m.votos += v;
      m.secoes += 1;
      sections.push({
        muni: cd, muni_nome: m.nome,
        zona: f[c.NR_ZONA], secao: f[c.NR_SECAO],
        votos: v, local: f[c.NM_LOCAL_VOTACAO], end: f[c.DS_LOCAL_VOTACAO_ENDERECO]
      });
    });
    const munObj = {};
    for (const [k, v] of mun) munObj[k] = v;
    return { total, mun: munObj, sections, nome };
  }

  const Tse = { csvChunks, listCandidates, candidateDataset, parseLine, scanTse };
  if (typeof module !== 'undefined' && module.exports) module.exports = Tse;
  else root.TseCore = Tse;
})(typeof self !== 'undefined' ? self : globalThis);
