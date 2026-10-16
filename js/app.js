/* Resumo Candidato — SC: app 100% no navegador (sem backend). */
(function () {
  'use strict';
  const Core = window.ResumoCore;

  // ---- paleta (idêntica à do gerador Python) ----
  const BG = '#0e1319', FILL0 = '#161d27', STROKE0 = '#2a3543',
        ACCENT = '#f63b4b', STROKE1 = '#7a353b', DOT = '#ffb454',
        DOT_ED = 'rgba(255,255,255,0.25)', FG = '#e8eef5', MUTED = '#8fa0b3';
  const W = 980, PAD = 14, MAP_W2 = W + 2 * PAD; // largura total do viewBox (zoom s = vb.w/MAP_W2)

  const $ = id => document.getElementById(id);
  const esc = t => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Plural simples em pt-BR: pl(1, 'seção', 'seções') -> 'seção'.
  const pl = (n, singular, plural) => (Number(n) === 1 ? singular : plural);
  // prefers-reduced-motion: scroll suave e transições só quando o usuário não
  // pediu redução de movimento.
  const motionOK = () =>
    !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const scrollBehavior = () => (motionOK() ? 'smooth' : 'auto');
  // requestAnimationFrame (com fallback p/ testes Node): loteia a re-escala de
  // marcadores durante pan/zoom contínuo (milhares de dots por frame).
  const raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16);

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
  let tseListFull = [];      // lista completa do cargo atual (ordem por votos)
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

  /**
   * Preenche a lista de candidatos (sempre em ordem de votos, decrescente)
   * aplicando o filtro por nome (sem acento, case-insensitive) ou número.
   * Mantém a seleção anterior quando o candidato filtrado ainda existe.
   *
   * @param {string} filter texto do filtro (vazio = lista completa).
   * @sideeffect popula #tseSel, mostra #tseFilterRow e atualiza a contagem.
   */
  function renderTseList(filter) {
    const strip = x => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const q = strip(String(filter || '').trim());
    const sel = $('tseSel');
    const prev = sel.value;
    const items = q
      ? tseListFull.filter(x => x.numero.includes(q) || strip(x.nome).includes(q))
      : tseListFull;
    sel.innerHTML = items.map(x =>
      `<option value="${x.numero}">${esc(x.nome)} (${x.numero}) — ${x.votos.toLocaleString('pt-BR')} votos</option>`
    ).join('');
    sel.hidden = false;
    sel.size = Math.min(8, Math.max(1, items.length));
    if (prev && items.some(x => x.numero === prev)) sel.value = prev;
    // "N de T candidatos" (filtro) ou "T candidato(s)" (lista completa)
    $('tseFilterCount').textContent =
      (q ? items.length + ' de ' + tseListFull.length : tseListFull.length) +
      ' ' + (q ? 'candidatos' : pl(tseListFull.length, 'candidato', 'candidatos'));
  }
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
        // ordem explícita por votos: chaves numéricas de objeto JS iteram em
        // ordem numérica, não de importância (invariante 5).
        tseListFull = Object.entries(c.candidatos)
          .map(([numero, m]) => ({ numero, nome: m[0], votos: m[1] }))
          .sort((a, b) => b.votos - a.votos);
        $('tseFilterRow').hidden = false;
        renderTseList('');
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
      tseListFull = list; // listCandidates já devolve em ordem de votos
      $('tseFilterRow').hidden = false;
      renderTseList('');
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
          const ok = await loadDataset({
            total: ds.total, mun: ds.mun, sections: ds.sections,
            candidato: nome, numero, cargo: cargo.label,
            eleicao: eleicaoLabel(idx),
            fonte: 'TSE · snapshot de ' + new Date(idx.gerado_em).toLocaleDateString('pt-BR')
          }, msg => { if (msg) tseStatus(msg); });
          if (!ok) { tseStatus('Falha ao montar o mapa — a mensagem de erro está no bloco "Ou importe a sua tabela JSON", logo abaixo.'); return; }
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
      const ok = await loadDataset({
        total: ds.total, mun: ds.mun, sections: ds.sections,
        candidato: nome, numero, cargo: cargo.label,
        eleicao: eleicaoLabel(null, cargo.file),
        fonte: 'TSE · ' + cargo.file
      }, msg => { if (msg) tseStatus(msg); });
      if (!ok) { tseStatus('Falha ao montar o mapa — a mensagem de erro está no bloco "Ou importe a sua tabela JSON", logo abaixo.'); return; }
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
  let vb = null;          // viewBox atual
  let mapZoom = null;     // api de zoom exposta (botões +/−/⟲)
  let mapGesture = null;  // gestos ativos do mapa atual (pan/pinch)
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
  // Siglas institucionais que devem permanecer em maiúsculas nos nomes
  // oficiais do TSE — ex.: "E.B.M." nunca pode virar "E.b.m.". Conjunto
  // calibrado com os nomes de local de SC 2026 (catálogo data/geo_loc;
  // conferir com node -e ao adicionar). Abreviações PONTILHADAS (PROF., DR.,
  // LTDA., C.E.I., (SUBST.)…) são preservadas por regra, sem constar aqui.
  const ACRONYMS = new Set(('EBM EEB EEM EEF EEE EB EE EMEB EMEF EMEI EMEFM EMEC EMEPA EJA ' +
    'CEI CEIM CEIT CEJA CEU CEM CEMJ CEMEI CMEI CME CIEP CIEF CAIC CREI CDI CEF ' +
    'CEFID CCE CTC CSE CFH CEART CTAI CCJ CDS CI ' +
    'APAE UBS CRAS CREAS SCFV SENAI SENAC SESC IFSC UFSC UDESC IFC IEE UNC DNIT ' +
    'CEDUP FAESC FAED FAOSC FUNEI FEPOL COHAB COC ESAG').split(' '));

  /**
   * Decide se um token é sigla/abreviação a preservar no caso original.
   *
   * @param {string} token token do nome (trecho entre espaços).
   * @returns {boolean} true se o token mantém o caso original.
   */
  function isAcronym(token) {
    const t = String(token || '').trim();
    const letters = t.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
    if (letters.length < 2) return false;
    if (t.includes('.')) return true; // abreviação pontilhada: PROF., E.B.M., C.E.I.
    return ACRONYMS.has(letters.toUpperCase());
  }

  /**
   * Capitaliza um nome oficial (o TSE entrega ASCII em maiúsculas),
   * preservando siglas institucionais (EBM, EEB, EEF, CEI, …) e
   * abreviações pontilhadas (PROF., E.B.M., DR.). O restante segue
   * title-case por delimitador (espaço, '-', '/', '(').
   *
   * @param {string} s nome original (ex.: "E.B.M. ANTONIO X").
   * @returns {string} nome capitalizado fiel ao original (ex.: "E.B.M. Antonio X").
   */
  function titleCase(s) {
    return String(s || '').split(/(\s+)/).map(tok =>
      isAcronym(tok)
        ? tok
        : tok.toLowerCase().replace(/(^|[\s\-/(])\S/g, c => c.toUpperCase())
    ).join('');
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
    const munSec = new Map();
    for (const [g, list] of munSections) munSec.set(g, list.length);
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
      // distinto: círculo oco — nunca confundível com marcador verificado).
      // O TSE 2026 fornece coordenadas oficiais dos LOCAIS de votação; o
      // modo ilustrativo cobre apenas as seções cujo local ainda não tem
      // coordenada verificada no catálogo (alguns locais seguem sem
      // resolver — reports/geo_cobertura.json).
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
    // RÓTULOS ADAPTATIVOS: todos os municípios com voto > 0 são candidatos
    // (sem limiar absoluto — a escala do candidato não muda o algoritmo).
    // Prioridade = total de votos do candidato (desc; desempate determinístico
    // por código IBGE). QUANTOS aparecem é decidido por layoutLabels() na
    // vista corrente (colisão com as caixas reais do texto renderizado).
    const labelAll = [];
    for (const [g, v] of munVotes) {
      if (!(v > 0)) continue;
      const [cx, cy] = Core.centroid(Core.biggestRing(ringsByGeo.get(g)));
      const [x, y] = proj.P(cx, cy);
      labelAll.push({ g, x, y, nome: metaByName.get(g), v });
    }
    labelAll.sort((a, b) => (b.v - a.v) || (Number(a.g) - Number(b.g)));
    labelAll.forEach((lb, i) => { lb.i = i; });
    const totalVotos = ds.total || ds.sections.reduce((a, s) => a + s.votos, 0);
    const nLoc = realMode ? model_nLoc : 0;
    return {
      meta: ds.meta, tse2geo, unmatched, ambiguous, munVotes, maxmun, maxMunNome,
      dots, labelAll, munNames: metaByName, munSec, totalVotos,
      nSec: ds.sections.length,
      nMun: tse2geo.size,
      nMunTotal: geo.features.length,
      realMode, nNoGeo, nLoc
    };
  }
  let model_nLoc = 0; // contagem de locais distintos do último build

  // ---------------- layout adaptativo de rótulos de município ----------------
  // Sem limiar absoluto de votos: TODOS os municípios com voto > 0 são
  // candidatos (model.labelAll, em prioridade de votos desc). A visibilidade
  // é decidida por vista:
  //  - colisão: caixas REAIS do texto (getBBox no render; fallback
  //    determinístico sem DOM). A caixa escala com o zoom (fonte fs*s,
  //    ancorada no centroid) — duas caixas que se cruzam em unidades do
  //    SVG se cruzam na tela (projeção uniforme);
  //  - densidade: gap mínimo em PX DE TELA entre caixas. Em telas pequenas
  //    o mesmo gap ocupa mais unidades do mapa → menos rótulos no mobile;
  //  - zoom: a linha "N votos" só aparece com vb.w <= MAP_W2/LBL_VOTES_Z
  //    (no zoom de estado completo, só nomes — votos ficam no hover do
  //    choropleth e no tooltip dos marcadores);
  //  - painéis flutuantes (HUD/legenda/botões de zoom, fundo opaco 0,92)
  //    são obstáculos: rótulo que cairia embaixo deles DESVIA (ordem fixa
  //    cima/baixo/esquerda/direita, até ficar totalmente fora do painel) —
  //    nunca se desvia de outro rótulo (colisão rótulo×rótulo mantém a
  //    rejeição por prioridade). O desvio é LIMITADO: no máximo a extensão
  //    do próprio painel + gap (no eixo do desvio) e 4×(gap + w + h) do
  //    rótulo — desvio maior desliga o rótulo da posição do município
  //    (deshonesto geograficamente); sem desvio válido, o rótulo fica
  //    oculto e só reaparece quando o zoom/pan traz a âncora para fora do
  //    painel. O desvio é aplicado via transform, na mesma escala da vista,
  //    e recalculado por apply();
  //  - a recálculo roda dentro de apply() (loteado em rAF, 1x/frame).
  const LBL_GAP_PX = 14;
  const LBL_VOTES_Z = 2;
  const LBL_VIEW_MARGIN = 0.25;
  const LBL_NAME_FS = 11, LBL_VOTES_FS = 9.5;
  const votesText = v => v.toLocaleString('pt-BR') + ' votos';
  // caixa estimada (fallback sem getBBox): largura média por glifo 0.58*fs
  function estLabelBox(ax, ay, fs, text) {
    const w = Math.round(0.58 * fs * text.length * 10) / 10;
    const h = Math.round(1.25 * fs * 10) / 10;
    return { ax, ay, x: ax - w / 2, y: ay - 0.8 * fs, w, h };
  }
  function scaledBox(b, s) {
    return { x: b.ax + (b.x - b.ax) * s, y: b.ay + (b.y - b.ay) * s, w: b.w * s, h: b.h * s };
  }
  function unionBox(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }
  function boxesCollide(a, b, gap) {
    return !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x ||
             a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y);
  }
  function boxesCollideAny(box, others, gap) {
    for (const o of others) if (boxesCollide(o, box, gap)) return true;
    return false;
  }
  /**
   * Decide quais rótulos aparecem sem sobreposição na vista `vb`.
   *
   * Greedy em prioridade de votos (ordem de model.labelAll): um município é
   * aceito se a âncora estiver na vista alargada por LBL_VIEW_MARGIN e a
   * caixa (escala s = vb.w/MAP_W2, gap LBL_GAP_PX em px de tela) não cruzar a de
   * nenhum já aceito. Colisão com PAINÉIS FLUTUANTES (obstacles, em unidades
   * da vista) resolve por desvio determinístico (cima → baixo → esquerda →
   * direita, até ficar totalmente fora do painel, mantido dentro da vista
   * e limitado, por eixo, ao menor de (extensão do painel + gap) e
   * 4×(gap + w + h) do rótulo — desvio maior desliga o rótulo do
   * município; sem candidato válido, o rótulo é rejeitado). Colisão com
   * outro rótulo mantém a rejeição por prioridade.
   * Determinístico para a mesma vista, dataset e painéis.
   *
   * @param {{x:number, y:number, w:number, h:number}} vb viewBox atual.
   * @param {number} R largura do mapa em px de tela (adapta a densidade).
   * @param {{x:number, y:number, w:number, h:number}[]} [obstacles] painéis flutuantes (unidades da vista).
   * @returns {{visible: Set<number>, withVotes: boolean, nudges: ({dx:number, dy:number}|null)[]}}
   *   índices visíveis, flag da linha de votos e desvio (unidades da vista) por rótulo.
   */
  function layoutLabels(vb, R, obstacles) {
    const s = vb.w / MAP_W2;
    const gap = LBL_GAP_PX * (vb.w / Math.max(R, 1));
    const withVotes = vb.w * LBL_VOTES_Z <= MAP_W2;
    const mx = vb.w * LBL_VIEW_MARGIN, my = vb.h * LBL_VIEW_MARGIN;
    const nObs = (obstacles || []).length;
    const accepted = obstacles || [];
    const visible = new Set();
    const nudges = [];
    for (const lb of model.labelAll) {
      if (lb.x < vb.x - mx || lb.x > vb.x + vb.w + mx || lb.y < vb.y - my || lb.y > vb.y + vb.h + my) continue;
      let box = scaledBox(lb.nbox || estLabelBox(lb.x, lb.y - 4, LBL_NAME_FS, lb.nome), s);
      if (withVotes) box = unionBox(box, scaledBox(lb.vbox || estLabelBox(lb.x, lb.y + 9, LBL_VOTES_FS, votesText(lb.v)), s));
      let dx = 0, dy = 0, placed = false;
      if (!boxesCollideAny(box, accepted, gap)) {
        accepted.push(box);
        placed = true;
      } else if (!boxesCollideAny(box, accepted.slice(nObs), gap)) {
        // colide SÓ com painéis: tenta desvios em ordem fixa (o desvio
        // garante sair totalmente do painel; nunca cruza outro rótulo)
        // limite do desvio por eixo: no máximo a extensão do próprio
        // painel + gap (sair do painel é o único motivo do desvio) e
        // 4×(gap + w + h) do rótulo (além disso o rótulo pararia longe do
        // município — posição enganosa; melhor ocultá-lo até o zoom/pan
        // trazer a âncora para fora do painel).
        const baseBound = 4 * (gap + box.w + box.h);
        for (let oi = 0; oi < nObs && !placed; oi++) {
          const p = accepted[oi];
          if (!boxesCollide(p, box, gap)) continue;
          const cands = [
            { dx: 0, dy: p.y - gap - (box.y + box.h), lim: Math.min(p.h + gap, baseBound) },
            { dx: 0, dy: p.y + p.h + gap - box.y, lim: Math.min(p.h + gap, baseBound) },
            { dx: p.x - gap - (box.x + box.w), dy: 0, lim: Math.min(p.w + gap, baseBound) },
            { dx: p.x + p.w + gap - box.x, dy: 0, lim: Math.min(p.w + gap, baseBound) }
          ];
          for (const o of cands) {
            if (Math.abs(o.dx) > o.lim || Math.abs(o.dy) > o.lim) continue;
            const b2 = { x: box.x + o.dx, y: box.y + o.dy, w: box.w, h: box.h };
            if (b2.x < vb.x - 1 || b2.x + b2.w > vb.x + vb.w + 1 || b2.y < vb.y - 1 || b2.y + b2.h > vb.y + vb.h + 1) continue;
            if (boxesCollideAny(b2, accepted, gap)) continue;
            accepted.push(b2);
            dx = o.dx; dy = o.dy; placed = true;
            break;
          }
        }
      }
      if (!placed) continue;
      visible.add(lb.i);
      nudges[lb.i] = (dx || dy) ? { dx, dy } : null;
    }
    return { visible, withVotes, nudges };
  }
  /**
   * Mede as caixas REAIS do texto renderizado (getBBox, escala base) para
   * cada rótulo. Sem getBBox (testes Node) usa a estimativa determinística.
   *
   * @param {SVGSVGElement} svg mapa recém-renderizado (fontes no tamanho base).
   * @sideeffect preenche lb.nbox/lb.vbox em model.labelAll.
   */
  function measureLabelBoxes(svg) {
    const names = svg.querySelectorAll('text.lbl-name');
    const votes = svg.querySelectorAll('text.lbl-votes');
    for (let i = 0; i < model.labelAll.length; i++) {
      const lb = model.labelAll[i];
      const n = names[i] && typeof names[i].getBBox === 'function' ? names[i].getBBox() : null;
      const v = votes[i] && typeof votes[i].getBBox === 'function' ? votes[i].getBBox() : null;
      lb.nbox = n ? { ax: lb.x, ay: lb.y - 4, x: n.x, y: n.y, w: n.width, h: n.height }
                  : estLabelBox(lb.x, lb.y - 4, LBL_NAME_FS, lb.nome);
      lb.vbox = v ? { ax: lb.x, ay: lb.y + 9, x: v.x, y: v.y, w: v.width, h: v.height }
                  : estLabelBox(lb.x, lb.y + 9, LBL_VOTES_FS, votesText(lb.v));
    }
  }

  // ---------------- construção do SVG ----------------
  function svgParts(withTitles) {
    const W2 = W + 2 * PAD, H2 = proj.H + 2 * PAD;
    const m = model.meta;
    const aria = (m.candidato ? m.candidato + (m.numero ? ' (' + m.numero + ')' : '') + ' — ' : '') +
      (m.cargo || 'seções com voto') + ', Santa Catarina. ' +
      model.totalVotos.toLocaleString('pt-BR') + ' votos em ' + model.nSec.toLocaleString('pt-BR') +
      ' seções, ' + model.nMun + ' de ' + model.nMunTotal + ' municípios. ' +
      (model.realMode
        ? 'Marcadores nos locais de votação com coordenada verificada (' +
          (model.meta.eleicao
            ? 'catálogo das Eleições ' + model.meta.eleicao.split('·')[0].replace('Eleições ', '').trim() +
              ' — coordenadas oficiais do TSE + validação INEP/OSM/TRE-SC'
            : 'catálogo de coordenadas verificadas: oficiais do TSE + validação INEP/OSM/TRE-SC') +
          '); ' +
          (model.nNoGeo > 0 ? model.nNoGeo + ' ' + pl(model.nNoGeo, 'seção', 'seções') +
            ' sem coordenada não plotad' + (model.nNoGeo === 1 ? 'a' : 'as') + '. ' : '')
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
          ? `<path class="mun" data-g="${g}" d="${d}" fill="${FILL0}" stroke="${STROKE0}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>`
          : `<path class="mun" data-g="${g}" d="${d}" fill="${ACCENT}" fill-opacity="${fo}" stroke="${STROKE1}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>`);
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
          ? `<title>Local: ${esc(nomeL)}${endL}\n${esc(titleCase(L[3]))}\n${n} ${pl(n, 'seção', 'seções')} · ${dt.loc.votos} ${pl(dt.loc.votos, 'voto', 'votos')}\nCoordenada verificada${srcL}</title>`
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
    // RÓTULOS: no export (withTitles), só entram os rótulos aceitos por
    // layoutLabels na vista base (s=1 → apenas nomes): o arquivo nunca tem
    // rótulos sobrepostos. No mapa interativo, TODAS as linhas vão para o
    // DOM; a visibilidade por vista é decidida em apply() (loteado em rAF)
    // — a aplicação inicial roda síncrono no attachZoomPan (sem flash).
    const layout = layoutLabels({ x: 0, y: 0, w: W2, h: H2 }, MAP_W2);
    for (const lb of model.labelAll) {
      if (withTitles && !layout.visible.has(lb.i)) continue;
      parts.push(`<text class="lbl lbl-name" x="${lb.x}" y="${lb.y - 4}" text-anchor="middle" font-size="11" font-weight="600" fill="${FG}" stroke="${BG}" stroke-width="3" paint-order="stroke">${esc(lb.nome)}</text>`);
      if (!withTitles || layout.withVotes) {
        parts.push(`<text class="lbl lbl-votes" x="${lb.x}" y="${lb.y + 9}" text-anchor="middle" font-size="9.5" fill="${MUTED}" stroke="${BG}" stroke-width="3" paint-order="stroke">${esc(votesText(lb.v))}</text>`);
      }
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
    const sub = `${esc(m.eleicao ? m.eleicao + ' · ' : '')}${model.totalVotos.toLocaleString('pt-BR')} votos em ${model.nSec.toLocaleString('pt-BR')} ${pl(model.nSec, 'seção', 'seções')} · ${model.nMun} de ${model.nMunTotal} municípios · ` +
      (model.realMode
        ? `${model.nLoc} ${pl(model.nLoc, 'local', 'locais')} de votação com coordenada verificada` + (model.nNoGeo > 0 ? ` · ${model.nNoGeo} ${pl(model.nNoGeo, 'seção', 'seções')} sem coordenada` : '')
        : (showIllus
          ? 'posições ilustrativas (sem catálogo de coordenadas verificadas)'
          : 'georreferenciamento indisponível (sem catálogo) — sem marcadores de seção'));
    $('hudTitle').innerHTML = `<div class="t">${titulo}</div><div class="s">${sub}</div>`;
    // Legenda em dois idiomas independentes, sem confluir os dois:
    // (1) PREENCHIMENTO do município = votos do candidato, escala log2
    //     (Core.fillFor: 0.12 + 0.73 · log2(v+1)/log2(max+1));
    // (2) MARCADORES = locais de votação. O raio codifica os VOTOS agregados
    //     no local (Core.dotR, saturado a partir de 5 votos) — nunca o
    //     número de seções, e nunca com relação linear ilimitada.
    const sw = Array.from({ length: 8 }, (_, i) => {
      const t = i / 7;
      return `<rect x="${i * 15}" y="0" width="15" height="9" fill="${ACCENT}" fill-opacity="${Math.round((0.12 + 0.73 * t) * 1000) / 1000}"/>`;
    }).join('');
    const maxLbl = model.maxmun.toLocaleString('pt-BR') +
      (model.maxMunNome ? ' (' + esc(model.maxMunNome) + ')' : '');
    let dotLegend;
    if (model.realMode) {
      // linha ilustrativa só quando há o que ilustrar (seções sem
      // coordenada) — nunca um símbolo morto na legenda.
      const illusLine = (model.nNoGeo > 0 || showIllus)
        ? `<div class="l2"><span class="o"></span><span>ilustrativo: posição NÃO geográfica (${model.nNoGeo} ${pl(model.nNoGeo, 'seção', 'seções')} sem coordenada ${showIllus ? '— modo ativo' : '— não desenhada por padrão'})</span></div>`
        : '';
      dotLegend =
        `<div class="l2"><span class="d"></span><span>local de votação (verificado) · tamanho = votos no local (satura a partir de 5)</span></div>` +
        illusLine;
    } else if (showIllus) {
      dotLegend = `<div class="l2"><span class="o"></span><span>1 seção · posição ILUSTRATIVA (não geográfica)</span></div>`;
    } else {
      dotLegend = `<div class="l2"><span>sem marcadores — georreferenciamento indisponível</span></div>`;
    }
    $('hudLegend').innerHTML =
      `<div class="l1">votos por município (escala log):</div>` +
      `<div class="lg-scale"><svg viewBox="0 0 120 9" preserveAspectRatio="none" aria-hidden="true">${sw}</svg>` +
      `<div class="l2"><span>0</span><span style="flex:1"></span><span>${maxLbl}</span></div></div>` +
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
      msgs.push(`${model.unmatched.length} ${pl(model.unmatched.length, 'município', 'municípios')} sem correspondência na malha (votos não plotados): ${nomes}${model.unmatched.length > 8 ? '…' : ''}`);
    }
    if (model.ambiguous.length) msgs.push(`${model.ambiguous.length} ${pl(model.ambiguous.length, 'nome', 'nomes')} ${pl(model.ambiguous.length, 'ambíguo', 'ambíguos')} na malha — uso o primeiro correspondente.`);
    if (model.realMode) {
      if (model.nNoGeo > 0) msgs.push(`${model.nNoGeo} ${pl(model.nNoGeo, 'seção', 'seções')} sem coordenada verificada não est${model.nNoGeo === 1 ? 'á' : 'ão'} no mapa — os totais preservam essas seções (use “modo ilustrativo” para visualizá-las com posição aproximada).`);
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
    const lblNames = Array.from(svg.querySelectorAll('text.lbl-name'));
    const lblVotes = Array.from(svg.querySelectorAll('text.lbl-votes'));
    const baseHalo = 3;
    const tip = $('tip');

    // Obstáculos do layout de rótulos: painéis flutuantes com fundo opaco
    // que cobrem o mapa (HUD de título, legenda, coluna de botões de zoom).
    // A posição é cacheada como DESLOJAMENTO em px relativo ao canto
    // superior esquerdo do SVG (medido na mesma leitura de retângulo):
    // é invariante a scroll da página (painel e SVG se movem juntos em
    // .mapwrap) — re-medir só quando o TAMANHO do SVG muda (chave do
    // cache), mantendo o invariante de 1 getBoundingClientRect por frame
    // durante pan/zoom. Em mobile (≤640px) a legenda sai do mapa
    // (position: static) — o filtro de interseção com o retângulo do SVG
    // a exclui automaticamente.
    const panelCache = { key: '', rects: [] };
    /**
     * Painéis flutuantes que cobrem o mapa, em unidades da vista atual.
     *
     * @param {{width:number, height:number}} sr retângulo renderizado do SVG
     *   (mesma leitura de apply()).
     * @returns {{x:number, y:number, w:number, h:number}[]|null} obstáculos
     *   em unidades do viewBox (null = nenhum painel cobre o mapa).
     */
    function panelObstacles(sr) {
      const key = Math.round(sr.width) + 'x' + Math.round(sr.height);
      if (panelCache.key !== key) {
        panelCache.rects = [];
        const push = el => {
          if (!el || typeof el.getBoundingClientRect !== 'function') return;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) panelCache.rects.push({ l: r.left - sr.left, t: r.top - sr.top, w: r.width, h: r.height });
        };
        push(document.getElementById('hudTitle'));
        push(document.getElementById('hudLegend'));
        push(document.querySelector('.mapzoom'));
        panelCache.key = key;
      }
      if (!panelCache.rects.length) return null;
      const kx = vb.w / Math.max(1, sr.width);
      const ky = vb.h / Math.max(1, sr.height);
      const obs = [];
      for (const p of panelCache.rects) {
        // só conta painel que realmente cobre parte do SVG na tela
        if (p.l + p.w < -1 || p.l > sr.width + 1 || p.t + p.h < -1 || p.t > sr.height + 1) continue;
        obs.push({ x: vb.x + p.l * kx, y: vb.y + p.t * ky, w: p.w * kx, h: p.h * ky });
      }
      return obs.length ? obs : null;
    }
    let applyPending = 0;
    function apply() {
      applyPending = 0;
      svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
      const s = vb.w / W2; // pontos e rótulos com tamanho constante na tela
      for (let i = 0; i < dots.length; i++) dots[i].setAttribute('r', (baseR[i] * s).toFixed(2));
      for (let i = 0; i < lbls.length; i++) {
        lbls[i].setAttribute('font-size', (baseFs[i] * s).toFixed(2));
        lbls[i].setAttribute('stroke-width', (baseHalo * s).toFixed(2));
      }
      // visibilidade adaptativa dos rótulos no MESMO lote rAF de pan/zoom:
      // colisão com caixas reais do texto + densidade por px de tela +
      // desvio determinístico em volta dos painéis flutuantes (transform
      // recalculado a cada vista; o export não passa obstáculos → inalterado)
      const sr = svg.getBoundingClientRect();
      const R = Math.max(1, sr.width || 0);
      const lay = layoutLabels(vb, R, panelObstacles(sr));
      for (let i = 0; i < lblNames.length; i++) {
        const on = lay.visible.has(i);
        lblNames[i].style.display = on ? '' : 'none';
        lblVotes[i].style.display = on && lay.withVotes ? '' : 'none';
        const nd = lay.nudges[i];
        const tr = on && nd ? `translate(${nd.dx.toFixed(2)} ${nd.dy.toFixed(2)})` : null;
        for (const t of [lblNames[i], lblVotes[i]]) {
          if (t.getAttribute('transform') === tr) continue;
          if (tr) t.setAttribute('transform', tr);
          else t.removeAttribute('transform');
        }
      }
    }
    // loteia apply() em 1x por frame: com milhares de marcadores, um apply
    // por evento de movimento derrubaria o frame rate durante pan/zoom.
    function scheduleApply() {
      if (applyPending) return;
      applyPending = raf(() => apply());
    }
    function zoomBy(f) {
      const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
      const nw = Math.min(W2, Math.max(MIN_W, vb.w / f));
      const k = nw / vb.w;
      vb.x = cx - (cx - vb.x) * k;
      vb.y = cy - (cy - vb.y) * k;
      vb.w = nw; vb.h = H2 * (nw / W2);
      scheduleApply();
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
        scheduleApply();
        tip.style.display = 'none';
      }
    }, { passive: false });

    // ---- gestos (Pointer Events: mouse, toque e pinch) ----
    // 1 ponteiro = pan; 2 ponteiros = pinch (zoom + pan simultâneos). O
    // scroll da página é suprimido por `touch-action: none` no CSS do SVG
    // (só sobre o mapa, nunca na página). Sem setPointerCapture: preserva o
    // click/tap nos marcadores (tooltip) e o dblclick (reset). Os listeners
    // de movimento/saída ficam na window, registrados UMA vez no init —
    // `mapGesture` aponta sempre para o mapa atual.
    const gesture = {
      active: new Map(), pan0: null, pinch0: null, moved: false,
      suppressClickUntil: 0,
      onMove(ev) {
        if (!gesture.active.has(ev.pointerId)) return;
        gesture.active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (gesture.pinch0 && gesture.active.size >= 2) {
          const pts = [...gesture.active.values()];
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
          const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
          const nw = Math.min(W2, Math.max(MIN_W, gesture.pinch0.vb0.w * (gesture.pinch0.d0 / d)));
          const k = nw / gesture.pinch0.rect.width;
          vb.w = nw; vb.h = H2 * (nw / W2);
          // o ponto SVG sob o meio da pinça inicial deve ficar sob o meio
          // atual (zoom centrado nos dedos + pan pelo deslocamento deles)
          vb.x = gesture.pinch0.q0.x - (mid.x - gesture.pinch0.rect.left) * k;
          vb.y = gesture.pinch0.q0.y - (mid.y - gesture.pinch0.rect.top) * k;
          gesture.moved = true;
          tip.style.display = 'none';
          scheduleApply();
          return;
        }
        if (gesture.pan0) {
          const dx = ev.clientX - gesture.pan0.sx, dy = ev.clientY - gesture.pan0.sy;
          if (!gesture.moved && Math.hypot(dx, dy) > 4) {
            gesture.moved = true;
            tip.style.display = 'none';
          }
          vb.x = gesture.pan0.vx - dx * gesture.pan0.k;
          vb.y = gesture.pan0.vy - dy * gesture.pan0.k;
          scheduleApply();
        }
      },
      onEnd(ev) {
        if (!gesture.active.has(ev.pointerId)) return;
        gesture.active.delete(ev.pointerId);
        if (gesture.pinch0 && gesture.active.size >= 1) {
          // um ponteiro sobrou do pinch: reancora o pan sem salto
          const p = [...gesture.active.values()][0];
          const rw = Math.max(1, svg.getBoundingClientRect().width);
          gesture.pan0 = { sx: p.x, sy: p.y, vx: vb.x, vy: vb.y, k: vb.w / rw };
        }
        gesture.pinch0 = null;
        if (gesture.active.size === 0) {
          if (gesture.moved) gesture.suppressClickUntil = Date.now() + 400;
          gesture.pan0 = null;
          gesture.moved = false;
          svg.classList.remove('dragging');
        }
      }
    };
    mapGesture = gesture;

    svg.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      gesture.active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (gesture.active.size === 1) {
        const rw = Math.max(1, svg.getBoundingClientRect().width);
        gesture.pan0 = { sx: ev.clientX, sy: ev.clientY, vx: vb.x, vy: vb.y, k: vb.w / rw };
        svg.classList.add('dragging');
      } else if (gesture.active.size === 2) {
        const pts = [...gesture.active.values()];
        const mid0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        gesture.pinch0 = {
          d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          rect: svg.getBoundingClientRect(),
          q0: toSvg({ clientX: mid0.x, clientY: mid0.y }),
          vb0: { ...vb }
        };
        gesture.pan0 = null;
        svg.classList.remove('dragging');
      }
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
        `<div class="v">${s.votos} ${pl(s.votos, 'voto', 'votos')}</div>`;
    }
    function tipLoc(m) {
      const L = geoCat.locais[m.i];
      const linhas = m.secs.slice(0, 8).map(s =>
        `<div class="m">seção ${esc(s.secao)} (zona ${esc(s.zona)}) — ${s.votos} ${pl(s.votos, 'voto', 'votos')}</div>`).join('');
      const mais = m.secs.length > 8 ? `<div class="m">… e mais ${m.secs.length - 8} ${pl(m.secs.length - 8, 'seção', 'seções')}</div>` : '';
      const src = L[9] ? ' · ' + esc(L[9]) : '';
      const edge = L[12] === 'edge' ? '<div class="tip-note">próximo da fronteira do município (validado)</div>' : '';
      return `<div class="h">${esc(titleCase(L[4]))}</div>` +
        `<div class="muni">${esc(titleCase(L[3]))}</div>` +
        (L[5] ? `<div class="m">${esc(L[5])}</div>` : '') +
        `<div class="m">zona(s): ${esc(L[6].map(z => 'Z' + z).join(', '))}</div>` +
        linhas + mais +
        `<div class="tip-note">coordenada verificada${src}</div>` + edge +
        `<div class="v">${m.votes} ${pl(m.votes, 'voto', 'votos')} em ${m.secs.length} ${pl(m.secs.length, 'seção', 'seções')}</div>`;
    }
    function showTipAt(html, cx, cy) {
      tip.innerHTML = html;
      tip.style.display = 'block';
      const bw = tip.offsetWidth, bh = tip.offsetHeight;
      let x = cx + 14, y = cy + 14;
      if (x + bw > window.innerWidth - 8) x = cx - bw - 14;
      if (y + bh > window.innerHeight - 8) y = cy - bh - 14;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    function showTip(dt, cx, cy) {
      // dt.kind: 'loc' (marcador verificado) ou 'sec-ill' (modo ilustrativo).
      showTipAt(dt.kind === 'loc'
        ? tipLoc(dt.loc)
        : tipSec(dt.s, 'posição ILUSTRATIVA — sem coordenada verificada'), cx, cy);
    }
    function tipMun(g) {
      const v = model.munVotes.get(g) || 0;
      const nSec = model.munSec.get(g) || 0;
      const pct = model.totalVotos ? (100 * v / model.totalVotos).toFixed(1).replace('.', ',') : '0,0';
      return `<div class="h">${esc(model.munNames.get(g) || g)}</div>` +
        `<div class="v">${v.toLocaleString('pt-BR')} ${pl(v, 'voto', 'votos')} · ${pct}% dos votos</div>` +
        `<div class="m">${nSec.toLocaleString('pt-BR')} ${pl(nSec, 'seção', 'seções')} com voto</div>`;
    }
    svg.addEventListener('mousemove', ev => {
      if (gesture.pan0) return;
      const t = ev.target;
      if (t.classList && t.classList.contains('dot')) showTip(model.dots[+t.dataset.i], ev.clientX, ev.clientY);
      else if (t.classList && t.classList.contains('mun')) showTipAt(tipMun(t.dataset.g), ev.clientX, ev.clientY);
      else if (tip.style.display === 'block') tip.style.display = 'none';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    svg.addEventListener('click', ev => {
      // click derivado de um pan não abre tooltip (dedo/solto longe do start)
      if (gesture.suppressClickUntil > Date.now()) return;
      const t = ev.target;
      if (t.classList && t.classList.contains('dot')) showTip(model.dots[+t.dataset.i], ev.clientX, ev.clientY);
      else if (t.classList && t.classList.contains('mun')) showTipAt(tipMun(t.dataset.g), ev.clientX, ev.clientY);
      else if (tip.style.display === 'block') tip.style.display = 'none';
    });
    // mede as caixas REAIS do texto (getBBox) e aplica a visão inicial;
    // síncrono na mesma task do renderMap (sem flash de rótulos)
    measureLabelBoxes(svg);
    apply();
  }

  // ---------------- carregar dataset ----------------
  function showError(msg) {
    const dz = $('dropZone');
    dz.classList.remove('hidden');
    $('results').hidden = true;
    $('errBox').textContent = msg;
    $('errBox').hidden = false;
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }
  /**
   * Carrega e desenha um dataset.
   *
   * @param {object} obj dataset {total, mun, sections, …} (formato do README).
   * @param {(msg: string) => void} [onStage] callback de estado de carga
   *   (msg '' = limpar). O chamador decide a superfície (status do painel
   *   TSE ou linha do dropzone); sem percentual — só há progresso
   *   mensurável no download do CDN (já coberto por tseStatus).
   * @returns {Promise<boolean>} true se o mapa foi desenhado.
   */
  async function loadDataset(obj, onStage) {
    const stage = msg => { if (onStage) onStage(msg); };
    $('errBox').hidden = true;
    if (!geo) stage('Carregando a malha municipal de SC…');
    try { await ensureGeo(); }
    catch (e) {
      stage('');
      showError('Falha ao carregar a malha municipal de SC (data/geo_sc_municipios.json) — tente novamente.');
      return false;
    }
    if (geoCat == null && !geoCatPromise) stage('Carregando o catálogo de coordenadas verificadas…');
    await loadGeoCatalog(); // null = catálogo indisponível (modo ilustrativo)
    stage('');
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
    // O mapa é o produto: recolhe o painel TSE (se aberto) e leva os
    // resultados à frente do viewport (scroll suave, salvo reduced-motion).
    if (!$('tsePanel').hidden) {
      $('tsePanel').hidden = true;
      $('btnTse').classList.remove('active');
    }
    if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) {
      // no mobile o mapa (o produto) deve entrar inteiro no viewport, logo
      // abaixo da topbar sticky; chips ficam a um gesto acima
      const tb = document.querySelector('.topbar');
      const docTop = $('mapBox').getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, docTop - (tb ? tb.offsetHeight : 64) - 10), behavior: scrollBehavior() });
    } else {
      $('results').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }
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
    // Landing TSE-first: o painel de consulta já nasce visível (é o modo
    // padrão do produto); a importação de JSON fica como ação secundária.
    $('btnTse').classList.add('active');
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
      $('tsePanel').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    });
    document.querySelectorAll('input[name="tseCargo"]').forEach(r =>
      r.addEventListener('change', () => {
        const sel = $('tseSel');
        sel.hidden = true;
        sel.innerHTML = ''; // reseta opções/valor do cargo anterior
        $('tseNum').value = '';
        $('tseFilterRow').hidden = true;
        $('tseFilter').value = '';
        $('tseFilterCount').textContent = '';
        tseListFull = [];
        $('tseSize').textContent = tseCargoSel().sizeMB.toLocaleString('pt-BR') + ' MB';
        $('tseBig').hidden = tseCargoSel().id !== 'PRESIDENTE';
      }));
    $('btnTseList').addEventListener('click', tseList);
    $('tseFilter').addEventListener('input', () => renderTseList($('tseFilter').value));
    $('btnPick').addEventListener('click', () => $('fileInput').click());
    // pan/pinch: um único par de listeners na window, delegados ao mapa atual
    window.addEventListener('pointermove', ev => { if (mapGesture) mapGesture.onMove(ev); });
    window.addEventListener('pointerup', ev => { if (mapGesture) mapGesture.onEnd(ev); });
    window.addEventListener('pointercancel', ev => { if (mapGesture) mapGesture.onEnd(ev); });
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
      $('tsePanel').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      const n = $('tseNum');
      if (n.focus) n.focus();
    });
    $('btnClear').addEventListener('click', () => {
      $('results').hidden = true;
      $('fileActions').hidden = true;
      $('dropZone').classList.remove('hidden');
      $('tseSel').hidden = true;
      $('tseSel').innerHTML = '';
      $('tseFilterRow').hidden = true;
      $('tseFilter').value = '';
      $('tseFilterCount').textContent = '';
      tseListFull = [];
      window.scrollTo({ top: 0, behavior: scrollBehavior() });
    });
    $('tseCancel').addEventListener('click', () => { if (tseAbort) tseAbort.abort(); });
    $('btnIllus').addEventListener('click', () => {
      showIllus = !showIllus;
      if (model) {
        model.dots = buildModel(modelSrcCache).dots;
        // HUD/legenda antes do mapa: o apply() inicial mede os painéis
        // como obstáculos dos rótulos (cache por tamanho do SVG)
        renderHud();
        renderWarnings();
        renderMap();
        updateIllusBtn();
      }
    });
    $('zoomIn').addEventListener('click', () => { if (mapZoom) mapZoom.zoomBy(1.4); });
    $('zoomOut').addEventListener('click', () => { if (mapZoom) mapZoom.zoomBy(1 / 1.4); });
    $('zoomReset').addEventListener('click', () => { if (mapZoom) mapZoom.resetView(); });

    // Carga inicial da malha municipal (2,3 MB): estado visível no bloco de
    // importação enquanto não está pronta.
    $('dzStatus').textContent = 'Preparando a malha municipal de SC…';
    try {
      await ensureGeo();
      $('dzStatus').textContent = '';
    } catch (e) {
      $('dzStatus').textContent = '';
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
