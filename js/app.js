/* Resumo Candidato — SC: app 100% no navegador (sem backend). */
(function () {
  'use strict';
  const Core = window.ResumoCore;

  // ---- paleta (idêntica à do gerador Python) ----
  const BG = '#0e1319', FILL0 = '#161d27', STROKE0 = '#2a3543',
        ACCENT = '#3b82f6', STROKE1 = '#35507a', DOT = '#ffb454',
        DOT_ED = 'rgba(255,255,255,0.25)', FG = '#e8eef5', MUTED = '#8fa0b3';
  const W = 980, PAD = 14;

  const $ = id => document.getElementById(id);
  const esc = t => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let geo = null, geoByName = null, feats = null, ringByGeo = null, proj = null;
  let model = null;       // dataset processado
  let rawJson = null;     // objeto original carregado (para exportar)
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
