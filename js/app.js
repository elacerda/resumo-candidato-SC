/* Resumo Candidato — SC: app 100% no navegador (sem backend). */
(function () {
  'use strict';
  const Core = window.ResumoCore;

  // ---- paleta (idêntica à do gerador Python) ----
  const BG = '#0e1319', FILL0 = '#161d27', STROKE0 = '#2a3543',
        ACCENT = '#f63b4b', STROKE1 = '#7a353b', DOT = '#ffb454',
        DOT_ED = 'rgba(255,255,255,0.25)', FG = '#e8eef5', MUTED = '#8fa0b3';
  const W = 980, PAD = 14;

  const $ = id => document.getElementById(id);
  const esc = t => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let geo = null, geoByName = null, feats = null, ringsByGeo = null, proj = null;
  let model = null;       // dataset processado
  let rawJson = null;     // objeto original carregado (para exportar)
  let modelSrcCache = null; // último ds parseado (rebuild no toggle ilustrativo)

  // ---- catálogo de georreferenciamento (data/geo_loc) ----
  // Coordenadas VERIFICADAS dos locais de votação (pipeline offline
  // sync/geo_ref.py: TSE 2026 + TRE-SC + INEP/OSM). Sem o catálogo, o
  // mapa cai no modo ILUSTRATIVO (posição determinística no município)
  // com aviso explícito — os dois modos nunca se misturam.
  const GEO_BASE = 'data/geo_loc/';
  let geoCat = null;         // {index, locais, sec2loc: Map} | null
  let geoCatPromise = null;
  let showIllus = false;     // desenhar seções sem coordenada (modo ilustrativo)
  function loadGeoCatalog() {
    if (geoCatPromise) return geoCatPromise;
    geoCatPromise = (async () => {
      try {
        const r = await fetch(GEO_BASE + 'index.json');
        if (!r.ok) return null;
        const index = await r.json();
        const [rl, rs] = await Promise.all([
          fetch(GEO_BASE + (index.locais || 'locais.json')),
          fetch(GEO_BASE + (index.secao2local || 'secoes.json'))
        ]);
        if (!rl.ok || !rs.ok) return null;
        const lj = await rl.json();
        const sj = await rs.json();
        const sec2loc = new Map();
        for (const row of sj.secao2local) sec2loc.set(row[0] + '/' + row[1] + '/' + row[2], row[3]);
        geoCat = { index, locais: lj.locais, sec2loc };
      } catch (e) { /* catálogo indisponível -> modo ilustrativo */ }
      return geoCat;
    })();
    return geoCatPromise;
  }

  // ---- dados oficiais TSE (download no navegador, cache IndexedDB) ----
  const TSE_BASE = 'https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/';
  const TSE_CARGOS = [
    { id: 'DEPUTADO FEDERAL', label: 'Deputado Federal', file: 'votacao_secao_2026_SC.zip', sizeMB: 74.5 },
    { id: 'DEPUTADO ESTADUAL', label: 'Deputado Estadual', file: 'votacao_secao_2026_SC.zip', sizeMB: 74.5 },
    { id: 'GOVERNADOR', label: 'Governador', file: 'votacao_secao_2026_SC.zip', sizeMB: 74.5 },
    { id: 'SENADOR', label: 'Senador', file: 'votacao_secao_2026_SC.zip', sizeMB: 74.5 },
    { id: 'PRESIDENTE', label: 'Presidente', file: 'votacao_secao_2026_BR.zip', sizeMB: 154 }
  ];
  const tseMem = new Map();  // file -> {bytes, csv}
  let tseBusy = false;
  let tseAbort = null;      // AbortController do download em curso
  let tseRetryFn = null;   // última ação TSE (botão Tentar novamente)
  const IDB_NAME = 'resumo-candidato-cache', IDB_STORE = 'files';
  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      rq.onsuccess = () => res(rq.result == null ? null : rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function fetchTseFile(filename, onProgress, signal) {
    const url = TSE_BASE + filename;
    let bytes = tseMem.get(filename);
    if (bytes) return bytes;
    if (typeof indexedDB !== 'undefined') {
      try { const c = await idbGet(url); if (c) { bytes = c; tseMem.set(filename, bytes); onProgress({ phase: 'cached' }); return bytes; } }
      catch (e) { /* cache indisponível */ }
    }
    const res = await fetch(url, signal ? { signal } : undefined);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ao baixar ' + filename);
    const total = +res.headers.get('content-length') || 0;
    const bufs = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bufs.push(value);
      got += value.length;
      onProgress({ phase: 'download', got, total });
    }
    bytes = new Uint8Array(got);
    let o = 0;
    for (const b of bufs) { bytes.set(b, o); o += b.length; }
    tseMem.set(filename, bytes);
    if (typeof indexedDB !== 'undefined') idbSet(url, bytes).catch(() => {});
    return bytes;
  }
  async function getTseCsv(filename, onProgress, signal) {
    let entry = tseMem.get(filename);
    if (entry && entry.csv) return entry.csv;
    const bytes = await fetchTseFile(filename, onProgress, signal);
    if (!entry) entry = { bytes };
    if (entry.csv) return entry.csv;
    onProgress({ phase: 'unzip' });
    await new Promise(r => setTimeout(r, 30)); // pinta o status antes do unzip síncrono
    const entries = window.fflate.unzipSync(bytes);
    const csv = Object.values(entries).find(v => v.length > 1e6) || Object.values(entries)[0];
    entry.csv = csv;
    return csv;
  }
  // ---- snapshot TSE: pré-computado no repositório (sync/tse_sync.py + GitHub
  // Actions). Consulta por número sem baixar o CSV do CDN; o download direto
  // continua funcionando como fallback. ----
  const SNAP_BASE = 'data/tse_2026/';
  const snapMem = new Map();      // nome de arquivo -> JSON parseado
  let snapIndex = null;           // index.json (null = indisponível; re-tenta até carregar)
  async function getSnapIndex() {
    if (snapIndex) return snapIndex;
    try {
      const res = await fetch(SNAP_BASE + 'index.json');
      if (res.ok) snapIndex = await res.json();
    } catch (e) { /* sem snapshot -> fallback CDN */ }
    return snapIndex;
  }
  async function getSnapFile(name) {
    const hit = snapMem.get(name);
    if (hit) return hit;
    const res = await fetch(SNAP_BASE + name);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + name);
    const j = await res.json();
    snapMem.set(name, j);
    return j;
  }
  async function snapDataset(cargoId, numero) {
    const idx = await getSnapIndex();
    const c = idx && idx.cargos[cargoId];
    if (!c || !c.candidatos || !c.candidatos[numero]) return null;
    const [snap, secoes] = await Promise.all([
      getSnapFile(c.arquivo),
      getSnapFile(idx.secoes || 'secoes.json')
    ]);
    const meta = c.candidatos[numero];
    const munObj = {}; const sections = [];
    for (const [sIdx, v] of snap.cand[numero]) {
      const s = secoes.secoes[sIdx];
      const [code, nome] = secoes.mun[s[0]];
      const m = munObj[code] || (munObj[code] = { nome, votos: 0, secoes: 0 });
      m.votos += v; m.secoes += 1;
      sections.push({ muni: code, muni_nome: nome, zona: s[1], secao: s[2],
                      votos: v, local: s[3], end: s[4] });
    }
    return { total: meta[1], mun: munObj, sections, nome: meta[0] };
  }
  function snapInfoLine() {
    const el = $('tseInfo');
    if (!snapIndex) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = '✔ Snapshot do TSE no servidor (gerado em ' +
      new Date(snapIndex.gerado_em).toLocaleDateString('pt-BR') +
      '): lista e mapa por número na hora, sem download. Números fora do snapshot ' +
      'usam o arquivo do CDN.';
  }
  function tseStatus(msg, pct) {
    const el = $('tseStatus');
    el.hidden = false;
    el.classList.remove('error');
    $('tseStatusText').textContent = msg;
    const bar = $('tseBar');
    bar.style.width = pct == null ? '100%' : Math.max(3, Math.min(100, pct * 100)) + '%';
    bar.style.opacity = pct == null ? '0.35' : '1';
  }
  function tseHideStatus() { $('tseStatus').hidden = true; }
  function tseCargoSel() {
    return TSE_CARGOS.find(c => c.id === document.querySelector('input[name="tseCargo"]:checked').value);
  }
  function mb(n) { return (n / 1048576).toFixed(1).replace('.', ',') + ' MB'; }
  async function tseList() {
    if (tseBusy) return;
    tseBusy = true;
    tseRetryFn = tseList;
    $('tseRetry').hidden = true;
    const cargo = tseCargoSel();
    try {
      tseStatus('Verificando snapshot do TSE…');
      const idx = await getSnapIndex();
      snapInfoLine();
      const c = idx && idx.cargos[cargo.id];
      if (c && c.candidatos && Object.keys(c.candidatos).length) {
        tseStatus('Montando a lista de candidatos…');
        const list = Object.entries(c.candidatos)
          .map(([numero, m]) => ({ numero, nome: m[0], votos: m[1] }))
          .sort((a, b) => b.votos - a.votos);
        const sel = $('tseSel');
        sel.innerHTML = list.map(x =>
          `<option value="${x.numero}">${esc(x.nome)} (${x.numero}) — ${x.votos.toLocaleString('pt-BR')} votos</option>`
        ).join('');
        sel.hidden = false;
        sel.size = Math.min(8, list.length);
        tseHideStatus();
        return;
      }
      // sem snapshot para este cargo -> download do CDN
      tseStatus('Sem snapshot para este cargo; baixando ' + mb(cargo.sizeMB * 1048576) + ' do TSE (uma vez; fica em cache)…');
      tseAbort = new AbortController();
      $('tseCancel').hidden = false;
      const csv = await getTseCsv(cargo.file, p => {
        if (p.phase === 'download') tseStatus('Baixando ' + mb(p.got) + ' de ' + mb(p.total) + '…', p.got / p.total);
        else if (p.phase === 'cached') tseStatus('Arquivo em cache no dispositivo.');
        else if (p.phase === 'unzip') tseStatus('Descompactando (' + mb(cargo.sizeMB * 1048576) + ' → ~' + (cargo.id === 'PRESIDENTE' ? '1,5 GB' : '600 MB') + ')…');
      }, tseAbort.signal);
      tseStatus('Montando a lista de candidatos…');
      const list = await window.TseCore.listCandidates(window.TseCore.csvChunks(csv), cargo.id);
      const sel = $('tseSel');
      sel.innerHTML = list.map(x =>
        `<option value="${x.numero}">${esc(x.nome)} (${x.numero}) — ${x.votos.toLocaleString('pt-BR')} votos</option>`
      ).join('');
      sel.hidden = false;
      sel.size = Math.min(8, list.length);
      tseHideStatus();
    } catch (e) {
      if (e && e.name === 'AbortError') { tseStatus('Download cancelado.'); return; }
      tseError(e);
    } finally {
      tseBusy = false;
      $('tseCancel').hidden = true;
      tseAbort = null;
    }
  }
  async function tseMap() {
    if (tseBusy) return;
    const cargo = tseCargoSel();
    const numero = ($('tseNum').value.trim() || ($('tseSel').value || ''));
    if (!numero) { tseStatus('Informe o número do candidato ou escolha na lista.'); return; }
    tseBusy = true;
    tseRetryFn = tseMap;
    $('tseRetry').hidden = true;
    try {
      tseStatus('Verificando snapshot do TSE…');
      const idx = await getSnapIndex();
      snapInfoLine();
      const c = idx && idx.cargos[cargo.id];
      if (c && c.candidatos && c.candidatos[numero]) {
        tseStatus('Carregando as seções do candidato ' + numero + ' (snapshot, sem download)…');
        const ds = await snapDataset(cargo.id, numero);
        if (ds && ds.sections.length) {
          const nome = titleCase(ds.nome || '');
          await loadDataset({
            total: ds.total, mun: ds.mun, sections: ds.sections,
            candidato: nome, numero, cargo: cargo.label,
            eleicao: eleicaoLabel(idx),
            fonte: 'TSE · snapshot de ' + new Date(idx.gerado_em).toLocaleDateString('pt-BR')
          });
          tseHideStatus();
          return;
        }
      }
      if (c && c.candidatos && Object.keys(c.candidatos).length) {
        tseStatus('Número ' + numero + ' não encontrado nos dados do TSE para ' + cargo.label +
          ' (1º turno; snapshot de ' + new Date(idx.gerado_em).toLocaleDateString('pt-BR') +
          '). Use “Listar candidatos” para ver os números válidos.');
        return;
      }
      // fallback: download direto do CDN (sem snapshot para este cargo)
      tseStatus('Baixando ' + mb(cargo.sizeMB * 1048576) + ' do TSE (uma vez; fica em cache)…');
      tseAbort = new AbortController();
      $('tseCancel').hidden = false;
      const csv = await getTseCsv(cargo.file, p => {
        if (p.phase === 'download') tseStatus('Baixando ' + mb(p.got) + ' de ' + mb(p.total) + '…', p.got / p.total);
        else if (p.phase === 'cached') tseStatus('Arquivo em cache no dispositivo.');
        else if (p.phase === 'unzip') tseStatus('Descompactando…');
      }, tseAbort.signal);
      tseStatus('Extraindo as seções com voto do candidato ' + numero + '…');
      const ds = await window.TseCore.candidateDataset(window.TseCore.csvChunks(csv), { cargo: cargo.id, numero });
      if (!ds.sections.length) { tseStatus('Este candidato não tem votos em seções de SC (' + cargo.label + ').'); return; }
      const nome = titleCase(ds.nome || '');
      await loadDataset({
        total: ds.total, mun: ds.mun, sections: ds.sections,
        candidato: nome, numero, cargo: cargo.label,
        eleicao: eleicaoLabel(null, cargo.file),
        fonte: 'TSE · ' + cargo.file
      });
      tseHideStatus();
    } catch (e) {
      if (e && e.name === 'AbortError') { tseStatus('Download cancelado.'); return; }
      tseError(e);
    } finally {
      tseBusy = false;
      $('tseCancel').hidden = true;
      tseAbort = null;
    }
  }
  function tseError(e) {
    const r = describeTseError(e);
    tseStatus(r.msg); // textContent limpo (remove detalhe anterior, se houver)
    if (r.detail) {
      const d = document.createElement('div');
      d.className = 'tse-err-detail';
      d.textContent = 'detalhe técnico: ' + r.detail;
      $('tseStatusText').appendChild(d);
    }
    $('tseStatus').classList.add('error');
    $('tseRetry').hidden = false;
  }
  function describeTseError(e) {
    if (e && e.name === 'AbortError') return { msg: 'download cancelado.' };
    const m = (e && e.message) || String(e);
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
      return { msg: 'Falha de rede ao acessar cdn.tse.jus.br. Verifique sua conexão: adblocker, ' +
        'proxy corporativo ou VPN costumam causar isso. Tente novamente — ou use a lista ' +
        'de candidatos do snapshot, que não precisa de download.' };
    }
    if (/HTTP 404/.test(m)) return { msg: 'arquivo ainda não está disponível no CDN do TSE.', detail: m };
    if (/HTTP 403/.test(m)) return { msg: 'acesso negado pelo CDN do TSE; tente novamente mais tarde.', detail: m };
    return { msg: 'falha inesperada ao consultar o TSE.', detail: m };
  }
  function eleicaoLabel(idx, cargoFile) {
    const ano = (idx && idx.eleicao) || (cargoFile && (cargoFile.match(/votacao_secao_(\d+)/) || [])[1]) || '2026';
    return 'Eleições ' + ano + ' · 1º turno';
  }
  let drag = null;        // estado do pan
  let vb = null;          // viewBox atual
  let mapZoom = null;     // api de zoom exposta (botões +/−/⟲)
  const VB = { w: 0, h: 0 };

  // ---------------- carga da malha ----------------
  let geoPromise = null, geoFailed = null;
  function ensureGeo() {
    if (!geoPromise) geoPromise = loadGeo().catch(e => { geoFailed = e; throw e; });
    return geoPromise;
  }
  async function loadGeo() {
    const res = await fetch('data/geo_sc_municipios.json');
    geo = await res.json();
    const idx = Core.buildGeoIndex(geo);
    feats = idx.feats;
    geoByName = idx.geoByName;
    ringsByGeo = new Map(feats.map(f => [f[0], f[2]]));
    proj = Core.makeProjector(feats.flatMap(f => f[2]));
  }

  // ---------------- modelo (mesma lógica do Python) ----------------
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-/(])\S/g, c => c.toUpperCase());
  }
  function buildModel(ds) {
    const { tse2geo, unmatched, ambiguous } = Core.mapTseToGeo(ds.mun, geoByName);
    const realMode = geoCat != null;
    // locIdx por seção: -1 = sem coordenada verificada; -2 = sem catálogo
    for (const s of ds.sections) {
      s.locIdx = realMode
        ? (geoCat.sec2loc.has(s.muni + '/' + s.zona + '/' + s.secao) ? geoCat.sec2loc.get(s.muni + '/' + s.zona + '/' + s.secao) : -1)
        : -2;
    }
    const munVotes = new Map();
    for (const [m, v] of Object.entries(ds.mun)) if (tse2geo.has(m)) munVotes.set(tse2geo.get(m), v.votos);
    let maxmun = 0, maxMunKey = '';
    for (const [m, v] of Object.entries(ds.mun)) {
      if (tse2geo.has(m) && v.votos > maxmun) { maxmun = v.votos; maxMunKey = m; }
    }
    const maxMunNome = maxMunKey ? titleCase(ds.mun[maxMunKey].nome) : '';
    const munSections = new Map();
    for (const s of ds.sections) {
      const g = tse2geo.get(s.muni);
      if (!g) continue;
      if (!munSections.has(g)) munSections.set(g, []);
      munSections.get(g).push(s);
    }
    // MODO REAL (catálogo data/geo_loc presente): 1 marcador por LOCAL DE
    // VOTAÇÃO, na coordenada verificada do catálogo (seções do mesmo local
    // coincidem; o marcador agrega as seções). Sem catálogo: 1 ponto por
    // seção em posição ILUSTRATIVA determinística (identidade da seção =
    // muni IBGE + zona + seção) — o modo é declarado na UI (aria/legenda/
    // aviso) e nunca se mistura com marcadores verificados (ver README:
    // "Semântica geográfica do mapa").
    const dots = [];
    let nNoGeo = 0;
    if (realMode) {
      // MODO REAL: 1 marcador por LOCAL DE VOTAÇÃO (coordenada verificada).
      // Seções sem coordenada não são plotadas (contadas em nNoGeo).
      const byLoc = new Map();
      for (const s of ds.sections) {
        if (s.locIdx < 0) { nNoGeo++; continue; }
        let m = byLoc.get(s.locIdx);
        if (!m) {
          const L = geoCat.locais[s.locIdx];
          const [lon, lat] = L[8];
          m = { i: s.locIdx, x: proj.P(lon, lat)[0], y: proj.P(lon, lat)[1], votes: 0, secs: [] };
          byLoc.set(s.locIdx, m);
        }
        m.votes += s.votos;
        m.secs.push(s);
      }
      model_nLoc = byLoc.size;
      for (const m of [...byLoc.values()].sort((a, b) => b.votes - a.votes)) {
        dots.push({ x: m.x, y: m.y, r: Core.dotR(m.votes), kind: 'loc', loc: m });
      }
      // opcional: seções sem coordenada em MODO ILUSTRATIVO (estilo
      // distinto: círculo oco — nunca confundível com marcador verificado)
      if (showIllus) {
        const illus = ds.sections.filter(s => s.locIdx < 0)
          .sort((a, b) => (a.muni + a.zona + a.secao) < (b.muni + b.zona + b.secao) ? -1 : 1);
        for (const s of illus) {
          const g = tse2geo.get(s.muni);
          if (!g) continue;
          const p = Core.placeSection(ringsByGeo.get(g), parseInt(g, 10), s.zona, s.secao);
          dots.push({ x: proj.P(p[0], p[1])[0], y: proj.P(p[0], p[1])[1], r: Core.dotR(s.votos), kind: 'sec-ill', s });
        }
      }
    } else {
      // SEM CATÁLOGO: georreferenciamento indisponível. Por padrão NENHUM
      // ponto sintético é desenhado (estado declarado; choropleth, rótulos e
      // totais permanecem). O modo ilustrativo (posição determinística da
      // identidade da seção no polígono do município) só é exibido por
      // escolha explícita do usuário (botão "Modo ilustrativo"), como
      // círculos ocos tracejados — nunca confundível com marcador verificado.
      if (showIllus) {
        for (const g of [...munSections.keys()].sort()) {
          const rings = ringsByGeo.get(g);
          const sects = munSections.get(g);
          for (const s of sects) {
            const p = Core.placeSection(rings, parseInt(g, 10), s.zona, s.secao);
            dots.push({ x: proj.P(p[0], p[1])[0], y: proj.P(p[0], p[1])[1], r: Core.dotR(s.votos), kind: 'sec-ill', s });
          }
        }
      }
      nNoGeo = -1; // -1 = modo sem catálogo
    }
    const metaByName = new Map();
    for (const [m, v] of Object.entries(ds.mun)) if (tse2geo.has(m)) metaByName.set(tse2geo.get(m), titleCase(v.nome));
    const labels = [];
    for (const [g, v] of munVotes) {
      if (v >= 60) {
        const [cx, cy] = Core.centroid(Core.biggestRing(ringsByGeo.get(g)));
        const [x, y] = proj.P(cx, cy);
        labels.push({ x, y, nome: metaByName.get(g), v });
      }
    }
    if (labels.length < 1) {
      [...munVotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([g, v]) => {
        const [cx, cy] = Core.centroid(Core.biggestRing(ringsByGeo.get(g)));
        const [x, y] = proj.P(cx, cy);
        labels.push({ x, y, nome: metaByName.get(g), v });
      });
    }
    labels.sort((a, b) => b.v - a.v);
    const totalVotos = ds.total || ds.sections.reduce((a, s) => a + s.votos, 0);
    const nLoc = realMode ? model_nLoc : 0;
    return {
      meta: ds.meta, tse2geo, unmatched, ambiguous, munVotes, maxmun, maxMunNome,
      dots, labels, totalVotos,
      nSec: ds.sections.length,
      nMun: tse2geo.size,
      nMunTotal: geo.features.length,
      realMode, nNoGeo, nLoc
    };
  }
  let model_nLoc = 0; // contagem de locais distintos do último build

  // ---------------- construção do SVG ----------------
  function svgParts(withTitles) {
    const W2 = W + 2 * PAD, H2 = proj.H + 2 * PAD;
    const m = model.meta;
    const aria = (m.candidato ? m.candidato + (m.numero ? ' (' + m.numero + ')' : '') + ' — ' : '') +
      (m.cargo || 'seções com voto') + ', Santa Catarina. ' +
      model.totalVotos.toLocaleString('pt-BR') + ' votos em ' + model.nSec.toLocaleString('pt-BR') +
      ' seções, ' + model.nMun + ' de ' + model.nMunTotal + ' municípios. ' +
      (model.realMode
        ? 'Marcadores nos locais de votação com coordenada verificada (catálogo ' +
          (model.meta.eleicao ? 'das Eleições ' + model.meta.eleicao.split('·')[0].replace('Eleições ', '') : '') + ', coordenadas oficiais do TSE + validação INEP/OSM/TRE-SC); ' +
          (model.nNoGeo > 0 ? model.nNoGeo + ' seções sem coordenada não plotadas. ' : '')
        : (showIllus
          ? 'Posições ILUSTRATIVAS dentro do polígono do município (sem catálogo de coordenadas verificadas).'
          : 'Sem marcadores de seção — georreferenciamento indisponível (sem catálogo de coordenadas verificadas); choropleth por município preservado.'));
    const parts = [];
    parts.push(`<svg id="map" viewBox="0 0 ${W2} ${H2}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(aria)}" font-family="system-ui, -apple-system, sans-serif">`);
    parts.push(`<rect x="0" y="0" width="${W2}" height="${H2}" fill="${BG}"/>`);
    for (const [g, nome, rings] of feats) {
      const fo = Core.fillFor(model.munVotes.get(g) || 0, model.maxmun);
      for (const ring of rings) {
        const pts = ring.length > 12 ? Core.decimate(ring, 3) : ring;
        const d = 'M ' + pts.map(p => proj.P(p[0], p[1]).join(' ')).join(' L ') + ' Z';
        parts.push(fo === null
          ? `<path d="${d}" fill="${FILL0}" stroke="${STROKE0}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>`
          : `<path d="${d}" fill="${ACCENT}" fill-opacity="${fo}" stroke="${STROKE1}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>`);
      }
    }
    model.dots.forEach((dt, i) => {
      let title = '';
      if (dt.kind === 'loc') {
        // linha do catálogo: [i, mun_tse, ibge, mun_nome, nome, end,
        // zonas, secoes, [lon,lat], fonte, match, conf, status, ref]
        const L = geoCat.locais[dt.loc.i];
        const nomeL = titleCase(L[4]);
        const endL = L[5] ? ' · ' + L[5] : '';
        const srcL = L[9] ? ' · ' + L[9] : '';
        const n = dt.loc.secs.length;
        title = withTitles
          ? `<title>Local: ${esc(nomeL)}${endL}\n${esc(titleCase(L[3]))}\n${n} seção${n === 1 ? '' : 'ões'} · ${dt.loc.votos} voto(s)\nCoordenada verificada${srcL}</title>`
          : '';
      } else {
        const s = dt.s;
        title = withTitles
          ? `<title>Seção ${esc(s.secao)} · Zona ${esc(s.zona)} — ${esc(s.muniNome)}\n${s.votos} voto(s)\nLocal: ${esc(s.local)}\nPosição ilustrativa (sem coordenada verificada)</title>`
          : '';
      }
      if (dt.kind === 'sec-ill') {
        const attrs = withTitles ? '' : ` class="dot dot-ill" data-i="${i}"`;
        parts.push(`<circle${attrs} cx="${dt.x}" cy="${dt.y}" r="${dt.r}" fill="none" stroke="${ACCENT}" stroke-width="1" stroke-dasharray="2 1.5" vector-effect="non-scaling-stroke">${title}</circle>`);
      } else {
        const attrs = withTitles ? '' : ` class="dot" data-i="${i}"`;
        parts.push(`<circle${attrs} cx="${dt.x}" cy="${dt.y}" r="${dt.r}" fill="${DOT}" fill-opacity="0.9" stroke="${DOT_ED}" stroke-width="0.5" vector-effect="non-scaling-stroke">${title}</circle>`);
      }
    });
    for (const lb of model.labels) {
      parts.push(`<text class="lbl" x="${lb.x}" y="${lb.y - 4}" text-anchor="middle" font-size="11" font-weight="600" fill="${FG}" stroke="${BG}" stroke-width="3" paint-order="stroke">${esc(lb.nome)}</text>`);
      parts.push(`<text class="lbl" x="${lb.x}" y="${lb.y + 9}" text-anchor="middle" font-size="9.5" fill="${MUTED}" stroke="${BG}" stroke-width="3" paint-order="stroke">${lb.v} votos</text>`);
    }
    parts.push('</svg>');
    return { body: parts.join('\n'), W2, H2 };
  }

  // ---------------- HUD / chips / avisos ----------------
  function renderHud() {
    const m = model.meta;
    const titulo = m.candidato
      ? `${esc(m.candidato)}${m.numero ? ` (${esc(m.numero)})` : ''} — ${esc(m.cargo || 'Candidata/o')} · Santa Catarina`
      : 'Seções com voto · Santa Catarina';
    const sub = `${esc(m.eleicao ? m.eleicao + ' · ' : '')}${model.totalVotos.toLocaleString('pt-BR')} votos em ${model.nSec.toLocaleString('pt-BR')} seções · ${model.nMun} de ${model.nMunTotal} municípios · ` +
      (model.realMode
        ? `${model.nLoc} local(is) de votação com coordenada verificada` + (model.nNoGeo > 0 ? ` · ${model.nNoGeo} seção(ões) sem coordenada` : '')
        : (showIllus
          ? 'posições ilustrativas (sem catálogo de coordenadas verificadas)'
          : 'georreferenciamento indisponível (sem catálogo) — sem marcadores de seção'));
    $('hudTitle').innerHTML = `<div class="t">${titulo}</div><div class="s">${sub}</div>`;
    const sw = Array.from({ length: 8 }, (_, i) => {
      const t = i / 7;
      return `<rect x="${i * 15}" y="0" width="15" height="9" fill="${ACCENT}" fill-opacity="${Math.round((0.12 + 0.73 * t) * 1000) / 1000}"/>`;
    }).join('');
    const dotLegend = model.realMode
      ? `<div class="l2" style="margin-top:6px"><span class="d"></span><span>local de votação (verificado)</span><span style="flex:1"></span><span class="o"></span><span>ilustrativo (sem coordenada)</span></div>`
      : showIllus
        ? `<div class="l2" style="margin-top:6px"><span class="o"></span><span>1 seção · posição ILUSTRATIVA (sem coordenada verificada)</span></div>`
        : `<div class="l2" style="margin-top:6px"><span>sem marcadores de seção — georreferenciamento indisponível</span></div>`;
    $('hudLegend').innerHTML =
      `<div class="l1">votos por município:</div>` +
      `<svg width="120" height="9">${sw}</svg>` +
      `<div class="l2"><span>0</span><span class="d"></span><span>1 seção</span><span style="flex:1"></span><span>${model.maxmun.toLocaleString('pt-BR')}${model.maxMunNome ? ' (' + esc(model.maxMunNome) + ')' : ''}</span></div>` +
      dotLegend;
  }
  function renderChips() {
    const m = model.meta;
    const ident = [];
    if (m.candidato) ident.push(['Candidata/o', m.candidato]);
    if (m.numero) ident.push(['Número', m.numero]);
    if (m.cargo) ident.push(['Cargo', m.cargo]);
    if (m.eleicao) ident.push(['Eleição', m.eleicao]);
    if (m.fonte) ident.push(['Fonte', m.fonte]);
    const metrics = [
      ['Votos totais', model.totalVotos.toLocaleString('pt-BR')],
      ['Seções com voto', model.nSec.toLocaleString('pt-BR')],
      ['Municípios', `${model.nMun} de ${model.nMunTotal}`]
    ];
    if (model.realMode) {
      const pct = model.nSec ? Math.round(100 * (model.nSec - Math.max(0, model.nNoGeo)) / model.nSec) : 100;
      metrics.push(['Locais verificados', String(model.nLoc)]);
      metrics.push(['Seções georreferenciadas', pct + '%']);
    }
    const chip = (k, v, metric) =>
      `<span class="chip${metric ? ' metric' : ''}"><span class="k">${esc(k)}</span> ${esc(v)}</span>`;
    $('chips').innerHTML =
      `<span class="chips-g">${ident.map(([k, v]) => chip(k, v, false)).join('')}</span>` +
      `<span class="chips-g metrics">${metrics.map(([k, v]) => chip(k, v, true)).join('')}</span>`;
  }
  function renderWarnings() {
    const box = $('warnBox');
    const msgs = [];
    if (model.unmatched.length) {
      const nomes = model.unmatched.slice(0, 8).map(u => u[1]).join(', ');
      msgs.push(`${model.unmatched.length} município(s) sem correspondência na malha (votos não plotados): ${nomes}${model.unmatched.length > 8 ? '…' : ''}`);
    }
    if (model.ambiguous.length) msgs.push(`${model.ambiguous.length} nome(s) ambíguo(s) na malha — uso o primeiro correspondente.`);
    if (model.realMode) {
      if (model.nNoGeo > 0) msgs.push(`${model.nNoGeo} seção(ões) sem coordenada verificada não estão no mapa — os totais preservam essas seções (use “modo ilustrativo” para visualizá-las com posição aproximada).`);
    } else if (showIllus) {
      msgs.push('Sem catálogo de coordenadas verificadas (data/geo_loc) — posições ILUSTRATIVAS dentro do município (modo ilustrativo ativo por escolha sua).');
    } else {
      msgs.push('Catálogo de georreferenciamento (data/geo_loc) indisponível: nenhuma coordenada verificada foi carregada e nenhum ponto sintético é desenhado. Votos e choropleth por município permanecem; use “Modo ilustrativo” para posições aproximadas (ilustrativas).');
    }
    if (msgs.length) { box.innerHTML = msgs.map(esc).join('<br>'); box.hidden = false; }
    else box.hidden = true;
  }

  function updateIllusBtn() {
    const b = $('btnIllus');
    if (!b) return;
    const n = model && model.realMode ? model.nNoGeo : 0;
    const noCatalog = model && !model.realMode;
    b.hidden = !model || (model.realMode && n === 0);
    b.textContent = noCatalog
      ? (showIllus ? '✓ ' : '') + 'Modo ilustrativo (sem catálogo)' + (showIllus ? ' — ATIVO' : '')
      : (showIllus ? '✓ ' : '') + 'Sem coordenada: modo ilustrativo' + (n > 0 ? ` (${n})` : '');
    b.classList.toggle('active', showIllus);
    b.setAttribute('aria-pressed', String(showIllus));
  }
  function renderMap() {
    const { body, W2, H2 } = svgParts(false);
    const box = $('mapBox');
    box.innerHTML = body;
    attachZoomPan(box.querySelector('svg'), W2, H2);
  }

  function attachZoomPan(svg, W2, H2) {
    VB.w = W2; VB.h = H2;
    vb = { x: 0, y: 0, w: W2, h: H2 };
    const MIN_W = W2 / 60;
    const dots = Array.from(svg.querySelectorAll('circle.dot'));
    const baseR = dots.map(d => parseFloat(d.getAttribute('r')));
    const lbls = Array.from(svg.querySelectorAll('text.lbl'));
    const baseFs = lbls.map(t => parseFloat(t.getAttribute('font-size')));
    const baseHalo = 3;
    const tip = $('tip');

    function apply() {
      svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
      const s = vb.w / W2; // pontos e rótulos com tamanho constante na tela
      for (let i = 0; i < dots.length; i++) dots[i].setAttribute('r', (baseR[i] * s).toFixed(2));
      for (let i = 0; i < lbls.length; i++) {
        lbls[i].setAttribute('font-size', (baseFs[i] * s).toFixed(2));
        lbls[i].setAttribute('stroke-width', (baseHalo * s).toFixed(2));
      }
    }
    function zoomBy(f) {
      const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
      const nw = Math.min(W2, Math.max(MIN_W, vb.w / f));
      const k = nw / vb.w;
      vb.x = cx - (cx - vb.x) * k;
      vb.y = cy - (cy - vb.y) * k;
      vb.w = nw; vb.h = H2 * (nw / W2);
      apply();
    }
    function resetView() { vb = { x: 0, y: 0, w: W2, h: H2 }; apply(); }
    mapZoom = { zoomBy, resetView };
    function toSvg(ev) {
      const m = svg.getScreenCTM();
      if (!m) return { x: 0, y: 0 };
      const p = svg.createSVGPoint();
      p.x = ev.clientX; p.y = ev.clientY;
      return p.matrixTransform(m.inverse());
    }
    svg.addEventListener('wheel', ev => {
      ev.preventDefault();
      const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.008 : 0.0015));
      if (Math.abs(f - 1) > 1e-4) {
        const p = toSvg(ev);
        const nw = Math.min(W2, Math.max(MIN_W, vb.w / f));
        const k = nw / vb.w;
        vb.x = p.x - (p.x - vb.x) * k;
        vb.y = p.y - (p.y - vb.y) * k;
        vb.w = nw; vb.h = H2 * (nw / W2);
        apply();
        tip.style.display = 'none';
      }
    }, { passive: false });
    svg.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      const r = svg.getBoundingClientRect();
      drag = { sx: ev.clientX, sy: ev.clientY, vx: vb.x, vy: vb.y, k: vb.w / r.width };
      svg.classList.add('dragging');
      ev.preventDefault();
    });
    window.addEventListener('mousemove', ev => {
      if (!drag) return;
      vb.x = drag.vx - (ev.clientX - drag.sx) * drag.k;
      vb.y = drag.vy - (ev.clientY - drag.sy) * drag.k;
      apply();
      tip.style.display = 'none';
    });
    window.addEventListener('mouseup', () => {
      if (drag) { drag = null; svg.classList.remove('dragging'); }
    });
    svg.addEventListener('dblclick', ev => {
      ev.preventDefault();
      resetView();
    });

    // tooltip (por tipo de marcador)
    function tipSec(s, illusNote) {
      const end = s.end ? `<div class="m">${esc(s.end)}</div>` : '';
      return `<div class="h">Seção ${esc(s.secao)} · Zona ${esc(s.zona)}</div>` +
        `<div class="muni">${esc(s.muniNome)}</div>` +
        `<div class="m">${esc(s.local)}</div>${end}` +
        (illusNote ? `<div class="tip-note">${illusNote}</div>` : '') +
        `<div class="v">${s.votos} ${s.votos === 1 ? 'voto' : 'votos'}</div>`;
    }
    function tipLoc(m) {
      const L = geoCat.locais[m.i];
      const linhas = m.secs.slice(0, 8).map(s =>
        `<div class="m">seção ${esc(s.secao)} (zona ${esc(s.zona)}) — ${s.votos} voto(s)</div>`).join('');
      const mais = m.secs.length > 8 ? `<div class="m">… e mais ${m.secs.length - 8} seção(ões)</div>` : '';
      const src = L[9] ? ' · ' + esc(L[9]) : '';
      const edge = L[12] === 'edge' ? '<div class="tip-note">próximo da fronteira do município (validado)</div>' : '';
      return `<div class="h">${esc(titleCase(L[4]))}</div>` +
        `<div class="muni">${esc(titleCase(L[3]))}</div>` +
        (L[5] ? `<div class="m">${esc(L[5])}</div>` : '') +
        `<div class="m">zona(s): ${esc(L[6].map(z => 'Z' + z).join(', '))}</div>` +
        linhas + mais +
        `<div class="tip-note">coordenada verificada${src}</div>` + edge +
        `<div class="v">${m.votes} ${m.votes === 1 ? 'voto' : 'votos'} em ${m.secs.length} seção(ões)</div>`;
    }
    function showTip(dt, cx, cy) {
      tip.innerHTML = dt.kind === 'loc'
        ? tipLoc(dt.loc)
        : tipSec(dt.s, dt.kind === 'sec-ill'
            ? 'posição ILUSTRATIVA — sem coordenada verificada'
            : 'posição ilustrativa dentro do município (o TSE não publica coordenadas)');
      tip.style.display = 'block';
      const bw = tip.offsetWidth, bh = tip.offsetHeight;
      let x = cx + 14, y = cy + 14;
      if (x + bw > window.innerWidth - 8) x = cx - bw - 14;
      if (y + bh > window.innerHeight - 8) y = cy - bh - 14;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    svg.addEventListener('mousemove', ev => {
      if (drag) return;
      const t = ev.target;
      if (t.classList && t.classList.contains('dot')) showTip(model.dots[+t.dataset.i], ev.clientX, ev.clientY);
      else if (tip.style.display === 'block') tip.style.display = 'none';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    svg.addEventListener('click', ev => {
      const t = ev.target;
      if (t.classList && t.classList.contains('dot')) showTip(model.dots[+t.dataset.i], ev.clientX, ev.clientY);
      else if (tip.style.display === 'block') tip.style.display = 'none';
    });
  }

  // ---------------- carregar dataset ----------------
  function showError(msg) {
    const dz = $('dropZone');
    dz.classList.remove('hidden');
    $('results').hidden = true;
    $('errBox').textContent = msg;
    $('errBox').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function loadDataset(obj) {
    $('errBox').hidden = true;
    try { await ensureGeo(); }
    catch (e) {
      showError('Falha ao carregar a malha municipal de SC (data/geo_sc_municipios.json) — tente novamente.');
      return false;
    }
    await loadGeoCatalog(); // null = catálogo indisponível (modo ilustrativo)
    showIllus = false;
    updateIllusBtn();
    const ds = Core.parseDataset(obj);
    if (!ds.ok) { showError(ds.errors.join(' ')); return false; }
    try {
      model = buildModel(ds);
    } catch (e) {
      showError('Falha ao processar os dados (detalhe técnico: ' + e.message + ').');
      return false;
    }
    if (model.nMun === 0) {
      showError('Nenhum município reconhecido na malha de SC — verifique os códigos/nomes no campo "mun".');
      return false;
    }
    rawJson = obj;
    modelSrcCache = ds;
    $('dropZone').classList.add('hidden');
    $('results').hidden = false;
    $('fileActions').hidden = false;
    renderChips();
    renderWarnings();
    renderHud();
    renderMap();
    updateIllusBtn();
    return true;
  }
  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      let obj;
      try { obj = JSON.parse(reader.result); }
      catch (e) {
        let det = e.message;
        if (/unexpected token/i.test(det)) det = 'o arquivo começa com um caractere inesperado (talvez não seja JSON)';
        else if (/unexpected end/i.test(det)) det = 'o arquivo parece estar truncado';
        showError('Arquivo inválido: não é um JSON legível (' + det + ').');
        return;
      }
      await loadDataset(obj);
    };
    reader.onerror = () => showError('Não foi possível ler o arquivo.');
    reader.readAsText(file);
  }

  // ---------------- exportações ----------------
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
  function baseName() {
    const m = model.meta;
    return `mapa_${(m.numero || m.candidato || 'secoes').toLowerCase().replace(/[^a-z0-9]+/gi, '_')}_SC`;
  }

  // ---------------- eventos / init ----------------
  async function init() {
    $('btnLoad').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', ev => { handleFile(ev.target.files[0]); ev.target.value = ''; });
    $('btnSample').addEventListener('click', loadSample);
    $('btnSample2').addEventListener('click', loadSample);
    $('btnTse').addEventListener('click', () => {
      const p = $('tsePanel');
      p.hidden = !p.hidden;
      if (!p.hidden) $('btnTse').classList.add('active'); else $('btnTse').classList.remove('active');
    });
    $('tseGoDrop').addEventListener('click', () => {
      $('tsePanel').hidden = false;
      $('btnTse').classList.add('active');
      $('tsePanel').scrollIntoView({ behavior: 'smooth' });
    });
    document.querySelectorAll('input[name="tseCargo"]').forEach(r =>
      r.addEventListener('change', () => {
        const sel = $('tseSel');
        sel.hidden = true;
        $('tseNum').value = '';
        $('tseSize').textContent = tseCargoSel().sizeMB.toLocaleString('pt-BR') + ' MB';
        $('tseBig').hidden = tseCargoSel().id !== 'PRESIDENTE';
      }));
    $('btnTseList').addEventListener('click', tseList);
    $('btnTseMap').addEventListener('click', tseMap);
    $('tseRetry').addEventListener('click', () => {
      $('tseRetry').hidden = true;
      if (tseRetryFn) tseRetryFn();
    });
    $('tseNum').addEventListener('keydown', ev => { if (ev.key === 'Enter') tseMap(); });
    $('btnSvg').addEventListener('click', () => download(baseName() + '.svg', svgParts(true).body, 'image/svg+xml'));
    $('btnJson').addEventListener('click', () => download(baseName() + '.json', JSON.stringify(rawJson, null, 2), 'application/json'));

    // drag & drop global
    let dragDepth = 0;
    window.addEventListener('dragenter', ev => {
      ev.preventDefault();
      if (++dragDepth === 1) $('dropZone').classList.add('dragover');
    });
    window.addEventListener('dragleave', ev => {
      ev.preventDefault();
      if (--dragDepth <= 0) { dragDepth = 0; $('dropZone').classList.remove('dragover'); }
    });
    window.addEventListener('dragover', ev => ev.preventDefault());
    window.addEventListener('drop', ev => {
      ev.preventDefault();
      dragDepth = 0;
      $('dropZone').classList.remove('dragover');
      const f = ev.dataTransfer && ev.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    $('btnChange').addEventListener('click', () => {
      $('tsePanel').hidden = false;
      $('btnTse').classList.add('active');
      $('tsePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const n = $('tseNum');
      if (n.focus) n.focus();
    });
    $('btnClear').addEventListener('click', () => {
      $('results').hidden = true;
      $('fileActions').hidden = true;
      $('dropZone').classList.remove('hidden');
      $('tseSel').hidden = true;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('tseCancel').addEventListener('click', () => { if (tseAbort) tseAbort.abort(); });
    $('btnIllus').addEventListener('click', () => {
      showIllus = !showIllus;
      if (model) {
        model.dots = buildModel(modelSrcCache).dots;
        renderMap();
        renderHud();
        renderWarnings();
        updateIllusBtn();
      }
    });
    $('zoomIn').addEventListener('click', () => { if (mapZoom) mapZoom.zoomBy(1.4); });
    $('zoomOut').addEventListener('click', () => { if (mapZoom) mapZoom.zoomBy(1 / 1.4); });
    $('zoomReset').addEventListener('click', () => { if (mapZoom) mapZoom.resetView(); });

    try {
      await ensureGeo();
    } catch (e) {
      showError('Falha ao carregar a malha municipal de SC (data/geo_sc_municipios.json).');
    }
  }

  async function loadSample() {
    try {
      const res = await fetch('data/1333_sc_2026.json');
      const obj = await res.json();
      if (!obj.candidato) {
        obj.candidato = 'Profª Ju Andózio';
        obj.numero = '1333';
        obj.cargo = 'Deputada Federal';
        obj.estado = 'SC';
        obj.eleicao = 'Eleições 2026 · 1º turno';
      }
      await loadDataset(obj);
    } catch (e) {
      showError('Falha ao carregar o exemplo (data/1333_sc_2026.json).');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
