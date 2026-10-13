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

  let geo = null, geoByName = null, feats = null, ringByGeo = null, proj = null;
  let model = null;       // dataset processado
  let rawJson = null;     // objeto original carregado (para exportar)

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
  async function fetchTseFile(filename, onProgress) {
    const url = TSE_BASE + filename;
    let bytes = tseMem.get(filename);
    if (bytes) return bytes;
    if (typeof indexedDB !== 'undefined') {
      try { const c = await idbGet(url); if (c) { bytes = c; tseMem.set(filename, bytes); onProgress({ phase: 'cached' }); return bytes; } }
      catch (e) { /* cache indisponível */ }
    }
    const res = await fetch(url);
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
  async function getTseCsv(filename, onProgress) {
    let entry = tseMem.get(filename);
    if (entry && entry.csv) return entry.csv;
    const bytes = await fetchTseFile(filename, onProgress);
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
  let snapIndex = null;           // index.json (null = indisponível)
  let snapIndexTried = false;
  async function getSnapIndex() {
    if (snapIndexTried) return snapIndex;
    snapIndexTried = true;
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
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
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
      const csv = await getTseCsv(cargo.file, p => {
        if (p.phase === 'download') tseStatus('Baixando ' + mb(p.got) + ' de ' + mb(p.total) + '…', p.got / p.total);
        else if (p.phase === 'cached') tseStatus('Arquivo em cache no dispositivo.');
        else if (p.phase === 'unzip') tseStatus('Descompactando (' + mb(cargo.sizeMB * 1048576) + ' → ~' + (cargo.id === 'PRESIDENTE' ? '1,5 GB' : '600 MB') + ')…');
      });
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
      tseError(e);
    } finally {
      tseBusy = false;
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
          loadDataset({
            total: ds.total, mun: ds.mun, sections: ds.sections,
            candidato: nome, numero, cargo: cargo.label,
            eleicao: 'Eleições 2026 · 1º turno (04/10)',
            fonte: 'TSE · snapshot de ' + new Date(idx.gerado_em).toLocaleDateString('pt-BR')
          });
          tseHideStatus();
          return;
        }
      }
      // fallback: download direto do CDN (sem snapshot, ou número fora dele)
      tseStatus('Baixando ' + mb(cargo.sizeMB * 1048576) + ' do TSE (uma vez; fica em cache)…');
      const csv = await getTseCsv(cargo.file, p => {
        if (p.phase === 'download') tseStatus('Baixando ' + mb(p.got) + ' de ' + mb(p.total) + '…', p.got / p.total);
        else if (p.phase === 'cached') tseStatus('Arquivo em cache no dispositivo.');
        else if (p.phase === 'unzip') tseStatus('Descompactando…');
      });
      tseStatus('Extraindo as seções com voto do candidato ' + numero + '…');
      const ds = await window.TseCore.candidateDataset(window.TseCore.csvChunks(csv), { cargo: cargo.id, numero });
      if (!ds.sections.length) { tseStatus('Este candidato não tem votos em seções de SC (' + cargo.label + ').'); return; }
      const nome = titleCase(ds.nome || '');
      loadDataset({
        total: ds.total, mun: ds.mun, sections: ds.sections,
        candidato: nome, numero, cargo: cargo.label,
        eleicao: 'Eleições 2026 · 1º turno (04/10)',
        fonte: 'TSE · ' + cargo.file
      });
      tseHideStatus();
    } catch (e) {
      tseError(e);
    } finally {
      tseBusy = false;
    }
  }
  function tseError(e) {
    tseStatus('Falha: ' + describeTseError(e));
    $('tseStatus').classList.add('error');
    $('tseRetry').hidden = false;
  }
  function describeTseError(e) {
    if (e && e.name === 'AbortError') return 'download cancelado.';
    const m = (e && e.message) || String(e);
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
      return 'Falha de rede ao acessar cdn.tse.jus.br. Verifique sua conexão: adblocker, ' +
        'proxy corporativo ou VPN costumam causar isso. Tente novamente — ou use a lista ' +
        'de candidatos do snapshot, que não precisa de download.';
    }
    if (/HTTP 404/.test(m)) return 'arquivo ainda não está disponível no CDN do TSE.';
    if (/HTTP 403/.test(m)) return 'acesso negado pelo CDN do TSE; tente novamente mais tarde.';
    return m;
  }
  let drag = null;        // estado do pan
  let vb = null;          // viewBox atual
  const VB = { w: 0, h: 0 };

  // ---------------- carga da malha ----------------
  async function loadGeo() {
    const res = await fetch('data/geo_sc_municipios.json');
    geo = await res.json();
    const idx = Core.buildGeoIndex(geo);
    feats = idx.feats;
    geoByName = idx.geoByName;
    ringByGeo = new Map(feats.map(f => [f[0], f[2]]));
    proj = Core.makeProjector(feats.map(f => f[2]));
  }

  // ---------------- modelo (mesma lógica do Python) ----------------
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-/(])\S/g, c => c.toUpperCase());
  }
  function buildModel(ds) {
    const { tse2geo, unmatched, ambiguous } = Core.mapTseToGeo(ds.mun, geoByName);
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
    const dots = [];
    for (const g of [...munSections.keys()].sort()) {
      const ring = ringByGeo.get(g);
      const sects = munSections.get(g);
      const pts = Core.placePoints(ring, sects.length, parseInt(g, 10));
      pts.forEach((p, i) => dots.push({ x: proj.P(p[0], p[1])[0], y: proj.P(p[0], p[1])[1], r: Core.dotR(sects[i].votos), s: sects[i] }));
    }
    const metaByName = new Map();
    for (const [m, v] of Object.entries(ds.mun)) if (tse2geo.has(m)) metaByName.set(tse2geo.get(m), titleCase(v.nome));
    const labels = [];
    for (const [g, v] of munVotes) {
      if (v >= 60) {
        const [cx, cy] = Core.centroid(ringByGeo.get(g));
        const [x, y] = proj.P(cx, cy);
        labels.push({ x, y, nome: metaByName.get(g), v });
      }
    }
    if (labels.length < 1) {
      [...munVotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([g, v]) => {
        const [cx, cy] = Core.centroid(ringByGeo.get(g));
        const [x, y] = proj.P(cx, cy);
        labels.push({ x, y, nome: metaByName.get(g), v });
      });
    }
    labels.sort((a, b) => b.v - a.v);
    const totalVotos = ds.total || ds.sections.reduce((a, s) => a + s.votos, 0);
    return {
      meta: ds.meta, tse2geo, unmatched, ambiguous, munVotes, maxmun, maxMunNome,
      dots, labels, totalVotos,
      nSec: ds.sections.length,
      nMun: tse2geo.size,
      nMunTotal: geo.features.length
    };
  }

  // ---------------- construção do SVG ----------------
  function svgParts(withTitles) {
    const W2 = W + 2 * PAD, H2 = proj.H + 2 * PAD;
    const parts = [];
    if (!withTitles) parts.push(`<svg id="map" viewBox="0 0 ${W2} ${H2}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, -apple-system, sans-serif">`);
    else parts.push(`<svg id="map" viewBox="0 0 ${W2} ${H2}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, -apple-system, sans-serif">`);
    parts.push(`<rect x="0" y="0" width="${W2}" height="${H2}" fill="${BG}"/>`);
    for (const [g, nome, ring] of feats) {
      const d = 'M ' + Core.decimate(ring, 3).map(p => proj.P(p[0], p[1]).join(' ')).join(' L ') + ' Z';
      const fo = Core.fillFor(model.munVotes.get(g) || 0, model.maxmun);
      parts.push(fo === null
        ? `<path d="${d}" fill="${FILL0}" stroke="${STROKE0}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>`
        : `<path d="${d}" fill="${ACCENT}" fill-opacity="${fo}" stroke="${STROKE1}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>`);
    }
    model.dots.forEach((dt, i) => {
      const title = withTitles
        ? `<title>Seção ${esc(dt.s.secao)} · Zona ${esc(dt.s.zona)} — ${esc(dt.s.muniNome)}\n${dt.s.votos} voto(s)\nLocal: ${esc(dt.s.local)}</title>`
        : '';
      const attrs = withTitles ? '' : ` class="dot" data-i="${i}"`;
      parts.push(`<circle${attrs} cx="${dt.x}" cy="${dt.y}" r="${dt.r}" fill="${DOT}" fill-opacity="0.9" stroke="${DOT_ED}" stroke-width="0.5" vector-effect="non-scaling-stroke">${title}</circle>`);
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
    const sub = `${esc(m.eleicao ? m.eleicao + ' · ' : '')}${model.totalVotos.toLocaleString('pt-BR')} votos em ${model.nSec.toLocaleString('pt-BR')} seções · ${model.nMun} de ${model.nMunTotal} municípios · cada ponto = 1 seção com voto`;
    $('hudTitle').innerHTML = `<div class="t">${titulo}</div><div class="s">${sub}</div>`;
    const sw = Array.from({ length: 8 }, (_, i) => {
      const t = i / 7;
      return `<rect x="${i * 15}" y="0" width="15" height="9" fill="${ACCENT}" fill-opacity="${Math.round((0.12 + 0.73 * t) * 1000) / 1000}"/>`;
    }).join('');
    $('hudLegend').innerHTML =
      `<div class="l1">votos por município:</div>` +
      `<svg width="120" height="9">${sw}</svg>` +
      `<div class="l2"><span>0</span><span class="d"></span><span>1 seção</span><span style="flex:1"></span><span>${model.maxmun.toLocaleString('pt-BR')}${model.maxMunNome ? ' (' + esc(model.maxMunNome) + ')' : ''}</span></div>`;
  }
  function renderChips() {
    const m = model.meta;
    const chips = [];
    if (m.candidato) chips.push(['Candidata/o', m.candidato]);
    if (m.numero) chips.push(['Número', m.numero]);
    if (m.cargo) chips.push(['Cargo', m.cargo]);
    if (m.eleicao) chips.push(['Eleição', m.eleicao]);
    if (m.fonte) chips.push(['Fonte', m.fonte]);
    chips.push(['Votos totais', model.totalVotos.toLocaleString('pt-BR')]);
    chips.push(['Seções com voto', model.nSec.toLocaleString('pt-BR')]);
    chips.push(['Municípios', `${model.nMun} de ${model.nMunTotal}`]);
    $('chips').innerHTML = chips.map(([k, v]) => `<span class="chip"><span class="k">${esc(k)}</span> ${esc(v)}</span>`).join('');
  }
  function renderWarnings() {
    const box = $('warnBox');
    const msgs = [];
    if (model.unmatched.length) {
      const nomes = model.unmatched.slice(0, 8).map(u => u[1]).join(', ');
      msgs.push(`${model.unmatched.length} município(s) sem correspondência na malha (votos não plotados): ${nomes}${model.unmatched.length > 8 ? '…' : ''}`);
    }
    if (model.ambiguous.length) msgs.push(`${model.ambiguous.length} nome(s) ambíguo(s) na malha — uso o primeiro correspondente.`);
    if (msgs.length) { box.innerHTML = msgs.map(esc).join('<br>'); box.hidden = false; }
    else box.hidden = true;
  }

  // ---------------- render do mapa + zoom/pan ----------------
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
      vb = { x: 0, y: 0, w: W2, h: H2 };
      apply();
    });

    // tooltip
    function showTip(s, cx, cy) {
      const end = s.end ? `<div class="m">${esc(s.end)}</div>` : '';
      tip.innerHTML =
        `<div class="h">Seção ${esc(s.secao)} · Zona ${esc(s.zona)}</div>` +
        `<div class="muni">${esc(s.muniNome)}</div>` +
        `<div class="m">${esc(s.local)}</div>${end}` +
        `<div class="v">${s.votos} ${s.votos === 1 ? 'voto' : 'votos'}</div>`;
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
      if (t.classList && t.classList.contains('dot')) showTip(model.dots[+t.dataset.i].s, ev.clientX, ev.clientY);
      else if (tip.style.display === 'block') tip.style.display = 'none';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
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
  function loadDataset(obj) {
    $('errBox').hidden = true;
    const ds = Core.parseDataset(obj);
    if (!ds.ok) { showError(ds.errors.join(' ')); return; }
    try {
      model = buildModel(ds);
    } catch (e) {
      showError('Falha ao processar os dados: ' + e.message);
      return;
    }
    if (!model.dots.length) {
      showError('Nenhum município reconhecido na malha de SC — verifique os códigos/nomes no campo "mun".');
      return;
    }
    rawJson = obj;
    $('dropZone').classList.add('hidden');
    $('results').hidden = false;
    $('fileActions').hidden = false;
    renderChips();
    renderWarnings();
    renderHud();
    renderMap();
  }
  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let obj;
      try { obj = JSON.parse(reader.result); }
      catch (e) { showError('Arquivo inválido: não é um JSON legível (' + e.message + ').'); return; }
      loadDataset(obj);
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
        $('tseSize').textContent = tseCargoSel().sizeMB + ' MB';
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

    try {
      await loadGeo();
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
        obj.eleicao = 'Eleições 2026 · 1º turno (04/10)';
      }
      loadDataset(obj);
    } catch (e) {
      showError('Falha ao carregar o exemplo: ' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
