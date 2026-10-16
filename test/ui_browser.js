/* Validação de UI no navegador real (headless Chrome via CDP), sem imagens:
 * evidência por DOM, bounding boxes, computed styles, viewBox do SVG e eventos
 * sintéticos (Pointer Events, wheel, dblclick, downloads, console).
 *
 * Uso: node test/ui_browser.js [--shot]
 * Requer: Node >= 22 (WebSocket global), google-chrome (ou chromium) no PATH
 * (override: CHROME_BIN). O script sobe um servidor estático em
 * 127.0.0.1:8123 (mesma origem do Pages) e o Chrome headless; usa as portas
 * fixas 8123/9337. Dados: apenas o conteúdo do repositório (snapshot + exemplo
 * + catálogo) — sem cache/ externa e sem download.
 *
 * Viewports: desktop 1440x882 e mobile 390x844 (mesmos da auditoria UX).
 * Saída: 0 = ok, 1 = falha. Com --shot, screenshots vão para /tmp/uxshots2/
 * (arquivos locais — NUNCA abrir no modelo; apenas para revisão humana).
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8123;
const CDP_PORT = 9337;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOT = process.argv.includes('--shot');
const SHOT_DIR = '/tmp/uxshots2';
function whichCmd(c) { try { return spawnSync('which', [c]).status === 0 ? c : null; } catch (e) { return null; } }
const CHROME = process.env.CHROME_BIN ||
  ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(whichCmd).find(Boolean);

let ok = true;
const results = [];
function check(name, pass, extra) {
  results.push({ name, pass, extra });
  console.log((pass ? '  ✓' : '  ✗') + ' ' + name + (extra ? ' (' + extra + ')' : ''));
  if (!pass) ok = false;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- servidor estático (mesma origem do Pages) ----------------
function startServer() {
  const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((res, rej) => { srv.on('error', rej); srv.listen(PORT, '127.0.0.1', () => res(srv)); });
}

// ---------------- cliente CDP (WebSocket nativo do Node 22) ----------------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const c = new Cdp(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) { (c.handlers.get(m.method) || []).forEach(h => h(m.params)); }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(method, h) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(h); }
  close() { try { this.ws.close(); } catch (e) { /* noop */ } }
}

async function launchChrome() {
  const userDataDir = fs.mkdtempSync('/tmp/cdp-resumo-');
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir, 'about:blank'
  ], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version');
      if (r.ok) { const j = await r.json(); return { chrome, browser: await Cdp.connect(j.webSocketDebuggerUrl) }; }
    } catch (e) { /* ainda subindo */ }
    await sleep(250);
  }
  chrome.kill();
  throw new Error('Chrome não respondeu no porta ' + CDP_PORT);
}

async function newTab(browser, url) {
  const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?' + url, { method: 'PUT' });
  const t = await r.json();
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Log.enable');
  c.consoleErrors = [];
  c.on('Runtime.exceptionThrown', p => c.consoleErrors.push('exceção: ' + (p.exceptionDetails.text || '') + ' ' + ((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || '')));
  c.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') c.consoleErrors.push('console: ' + (p.args || []).map(a => a.value || a.description || '').join(' ')); });
  c.on('Log.entryAdded', p => { if (p.entry.level === 'error') c.consoleErrors.push('log: ' + p.entry.text); });
  return c;
}

async function evalJs(c, expr, awaitPromise) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  return r.result.value;
}
async function shot(c, name) {
  if (!SHOT) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log('  [shot] ' + f);
}
async function metrics(c, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: mobile ? 3 : 1, mobile: !!mobile,
    screenWidth: w, screenHeight: h, hasTouch: !!mobile, isMobile: !!mobile
  });
}
async function goto(c, url) {
  await c.send('Page.bringToFront');
  await c.send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    const st = await evalJs(c, 'document.readyState');
    if (st === 'complete') break;
    await sleep(100);
  }
  await sleep(150);
}
async function waitFor(c, expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try { if (await evalJs(c, expr)) return; } catch (e) { /* ainda carregando */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout esperando: ' + (label || expr));
    await sleep(120);
  }
}

// ---------- visibilidade REAL (renderizada) de #tseFilterRow / #tseSel ----------
// O atributo .hidden só prova a intenção do app: regras de display do autor
// (.tse-row{display:flex}, #tseSel{display:block}) sobrescrevem o default do UA
// ([hidden]{display:none}) se a regra global [hidden]{display:none !important}
// não existir — por isso checa o computed style e as caixas layoutadas.
const VIS_EXPR = `(() => {
  const st = id => {
    const el = document.getElementById(id);
    return { hidden: el.hidden, display: getComputedStyle(el).display, rects: el.getClientRects().length };
  };
  return { row: st('tseFilterRow'), sel: st('tseSel') };
})()`;
async function visState(c) { return evalJs(c, VIS_EXPR, true); }
function assertVis(tag, v, shown) {
  for (const [key, id] of [['row', '#tseFilterRow'], ['sel', '#tseSel']]) {
    const s2 = v[key];
    const extra = 'hidden=' + s2.hidden + ' display=' + s2.display + ' rects=' + s2.rects;
    if (shown) check(tag + ': ' + id + ' visível renderizado (display≠none, rects>0)',
      s2.hidden === false && s2.display !== 'none' && s2.rects > 0, extra);
    else check(tag + ': ' + id + ' invisível renderizado (display=none, 0 rects)',
      s2.hidden === true && s2.display === 'none' && s2.rects === 0, extra);
  }
}

// bloqueia snapshot (404) + CDN (DNS falha) para forçar listagem sem sucesso
async function blockedListTab(browser, w, h, mobile) {
  const t = await newTab(browser, 'about:blank');
  await metrics(t, w, h, mobile);
  await t.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/tse_2026/index.json', requestStage: 'Response' },
      { urlPattern: 'https://cdn.tse.jus.br/*', requestStage: 'Request' }
    ]
  });
  t.on('Fetch.requestPaused', async p => {
    try {
      if (p.request.url.includes('cdn.tse.jus.br')) await t.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'NameNotResolved' });
      else await t.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 404, responseHeaders: [], body: Buffer.from('não encontrado').toString('base64') });
    } catch (e) { /* noop */ }
  });
  await goto(t, BASE + '/');
  await evalJs(t, `(() => { document.getElementById('btnTseList').click(); return true; })()`, true);
  await waitFor(t, `!document.getElementById('tseRetry').hidden`, 15000, 'erro de listagem');
  return t;
}

// ---------- esperado: top-8 locais por votos (mesma lógica dos testes Node) ----------
function expected1333() {
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/1333_sc_2026.json'), 'utf8'));
  const locais = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_loc/locais.json'), 'utf8')).locais;
  const sec2loc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_loc/secoes.json'), 'utf8')).secao2local;
  const idxOf = new Map(sec2loc.map(r => [r[0] + '/' + r[1] + '/' + r[2], r[3]]));
  const byLoc = new Map();
  for (const s of sample.sections) {
    const i = idxOf.get(s.muni + '/' + s.zona + '/' + s.secao);
    if (i === undefined || i < 0) continue;
    let m = byLoc.get(i);
    if (!m) { m = { votes: 0 }; byLoc.set(i, m); }
    m.votes += s.votos;
  }
  const Core = require('../js/core.js');
  const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_sc_municipios.json'), 'utf8'));
  const idx = Core.buildGeoIndex(geo);
  const proj = Core.makeProjector(idx.feats.flatMap(f => f[2]));
  const sorted = [...byLoc.entries()].map(([i, m]) => ({ i, votes: m.votes })).sort((a, b) => b.votes - a.votes);
  const pts = sorted.slice(0, 8).map(m => {
    const [lon, lat] = locais[m.i][8];
    const [x, y] = proj.P(lon, lat);
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, r: Core.dotR(m.votes) };
  });
  return { nLoc: byLoc.size, pts };
}

let DL_DIR = '';
function listDownloads() {
  try { return fs.readdirSync(DL_DIR).filter(f => !f.endsWith('.crdownload')); } catch (e) { return []; }
}
function waitForDownload(name, ms) {
  const t0 = Date.now();
  return new Promise(res => {
    const t = setInterval(() => {
      if (listDownloads().includes(name) || Date.now() - t0 > ms) { clearInterval(t); res(); }
    }, 200);
  });
}
function downloadFile(name) {
  const f = path.join(DL_DIR, name);
  return fs.existsSync(f) ? f : null;
}

async function main() {
  if (!CHROME) { console.error('Chrome não encontrado — defina CHROME_BIN ou instale google-chrome.'); process.exit(2); }
  const srv = await startServer();
  const { chrome, browser } = await launchChrome();
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: (DL_DIR = fs.mkdtempSync('/tmp/uxdl-')) });
  const exp = expected1333();
  console.log('esperado (catálogo): ' + exp.nLoc + ' locais verificados p/ 1333');

  const desktop = await newTab(browser, 'about:blank');
  const mobile = await newTab(browser, 'about:blank');

  try {
    // ================= DESKTOP 1440x882 =================
    console.log('\n== desktop 1440x882 ==');
    await metrics(desktop, 1440, 882, false);
    await goto(desktop, BASE + '/');

    // 1) landing TSE-first
    const land = await evalJs(desktop, `(() => {
      const p = document.getElementById('tsePanel');
      const d = document.getElementById('dropZone');
      const pr = p.getBoundingClientRect(), dr = d.getBoundingClientRect();
      return {
        panelHidden: p.hidden,
        panelTop: Math.round(pr.top), dropTop: Math.round(dr.top),
        btnTseActive: document.getElementById('btnTse').classList.contains('active'),
        hero: (document.querySelector('#tsePanel h2') || {}).textContent || '',
        intro: (document.querySelector('#tsePanel p.dim') || {}).textContent || '',
        filterRowHidden: document.getElementById('tseFilterRow').hidden,
        selHidden: document.getElementById('tseSel').hidden,
        scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth
      };
    })()`, true);
    check('landing: painel TSE visível na carga', land.panelHidden === false);
    check('landing: painel TSE antes da dropzone (TSE-first)', land.panelTop < land.dropTop, `panel.top=${land.panelTop} drop.top=${land.dropTop}`);
    check('landing: título hero no painel TSE', /Mapa de seções por candidato/.test(land.hero), land.hero);
    check('landing: btnTse ativo (painel aberto)', land.btnTseActive);
    check('landing: sem scroll horizontal', land.scrollW <= land.innerW + 1, `scrollW=${land.scrollW}`);
    check('landing: filtro e select ocultos (antes de listar)',
      land.filterRowHidden === true && land.selHidden === true,
      'row=' + land.filterRowHidden + ' sel=' + land.selHidden);
    assertVis('landing (desktop)', await visState(desktop), false);
    check('landing: parágrafo intro simplificado (sem termos técnicos)',
      land.intro.trim() === 'Consulte um candidato pelo número, utilizando os dados oficiais do TSE (Eleições 2026, 1º turno).',
      land.intro.trim().slice(0, 90));
    await shot(desktop, 'd1_landing');

    // 2) busca: número 1333 -> mapa (snapshot, sem download)
    await evalJs(desktop, `(() => {
      document.getElementById('tseNum').value = '1333';
      document.getElementById('btnTseMap').click();
      return true;
    })()`, true);
    await waitFor(desktop, `!document.getElementById('results').hidden && document.querySelectorAll('#map circle.dot').length > 0`, 15000, 'mapa 1333');
    await sleep(800); // smooth scroll assentando
    const dres = await evalJs(desktop, `(() => {
      const svg = document.querySelector('#map');
      const mapR = document.getElementById('mapBox').getBoundingClientRect();
      return {
        nDots: document.querySelectorAll('#map circle.dot').length,
        nIll: document.querySelectorAll('#map circle.dot-ill').length,
        chips: document.getElementById('chips').textContent,
        hud: document.getElementById('hudTitle').textContent,
        legend: document.getElementById('hudLegend').innerHTML,
        mapTop: Math.round(mapR.top), mapBottom: Math.round(mapR.bottom),
        vb: svg.getAttribute('viewBox'),
        panelHidden: document.getElementById('tsePanel').hidden,
        aria: svg.getAttribute('aria-label'),
        scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth
      };
    })()`, true);
    check('mapa 1333: marcadores = locais verificados', dres.nDots === exp.nLoc, `${dres.nDots} vs ${exp.nLoc}`);
    check('mapa 1333: sem ilustrativos por padrão', dres.nIll === 0, String(dres.nIll));
    check('chips: totais oficiais (4.876 / 3.397 / 224 de 295)',
      dres.chips.includes('4.876') && dres.chips.includes('3.397') && dres.chips.includes('224 de 295'), dres.chips.replace(/\s+/g, ' ').slice(0, 120));
    check('HUD: candidata + totais', /Juliana Andozio \(1333\)/.test(dres.hud) && /4\.876 votos em 3\.397 seções/.test(dres.hud), dres.hud.replace(/\s+/g, ' ').slice(0, 100));
    check('HUD: plural "locais de votação"', dres.hud.includes('locais de votação com coordenada verificada'));
    check('mapa dentro do viewport após seleção', dres.mapTop >= 0 && dres.mapTop < 600, `top=${dres.mapTop} bottom=${dres.mapBottom}`);
    check('painel TSE colapsado após carregar', dres.panelHidden === true);
    check('aria: coordenada verificada (sem espaço órfão)', /coordenada verificada \(catálogo das Eleições 2026 —/.test(dres.aria), dres.aria.slice(0, 130));
    check('desktop: sem scroll horizontal no resultado', dres.scrollW <= dres.innerW + 1, `scrollW=${dres.scrollW}`);
    await shot(desktop, 'd2_results');

    // 4) semântica da legenda
    check('legenda: escala log declarada', dres.legend.includes('escala log'));
    check('legenda: 0 … max (Florianópolis) na escala do choropleth', dres.legend.includes('1.745 (Florianópolis)'));
    check('legenda: sem confluência marcador/escala (">1 seção<")', !dres.legend.includes('>1 seção<'));
    check('legenda: marcador = local verificado + tamanho = votos (satura)',
      dres.legend.includes('local de votação (verificado)') && dres.legend.includes('tamanho = votos no local') && dres.legend.includes('satura'));
    check('legenda: sem linha ilustrativa morta (nNoGeo=0)', !dres.legend.includes('ilustrativo'));

    // 13) coordenadas/radios idênticos ao catálogo (top-8 por votos)
    const browserPts = await evalJs(desktop, `Array.from(document.querySelectorAll('#map circle.dot')).slice(0, 8)
      .map(c => ({ x: Math.round(parseFloat(c.getAttribute('cx')) * 100) / 100,
                   y: Math.round(parseFloat(c.getAttribute('cy')) * 100) / 100,
                   r: Math.round(parseFloat(c.getAttribute('r')) * 100) / 100 }))`);
    check('coordenadas dos marcadores = catálogo (top-8, ±0.01)',
      browserPts.length === exp.pts.length && exp.pts.every((p, i) => Math.abs(p.x - browserPts[i].x) < 0.01 && Math.abs(p.y - browserPts[i].y) < 0.01),
      JSON.stringify(browserPts.slice(0, 2)) + ' vs ' + JSON.stringify(exp.pts.slice(0, 2)));
    check('raios = Core.dotR(votos) no zoom inicial', browserPts.every((b, i) => Math.abs(b.r - exp.pts[i].r) < 0.01), JSON.stringify(browserPts.slice(0, 3)));

    // 7) mouse: pan, wheel, reset
    const vb0 = dres.vb;
    const [vx0, , vw0, vh0] = vb0.split(' ').map(Number);
    await evalJs(desktop, `(() => {
      const svg = document.querySelector('#map');
      const r = svg.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const P = (type, cx, cy, buttons, onEl) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: buttons || 0, clientX: cx, clientY: cy });
        (onEl ? svg : window).dispatchEvent(ev);
      };
      P('pointerdown', x, y, 1, true);
      for (let i = 1; i <= 4; i++) P('pointermove', x + i * 25, y + i * 15, 1);
      P('pointerup', x + 100, y + 60, 0);
      return true;
    })()`, true);
    await sleep(120);
    const [vx1] = (await evalJs(desktop, `document.querySelector('#map').getAttribute('viewBox')`)).split(' ').map(Number);
    check('mouse: arrastar faz pan (viewBox.x muda)', vx1 < vx0, `x ${vx0} -> ${vx1}`);

    await evalJs(desktop, `(() => {
      const svg = document.querySelector('#map');
      const r = svg.getBoundingClientRect();
      svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -400 }));
      return true;
    })()`, true);
    await sleep(120);
    const [, , ww, wh] = (await evalJs(desktop, `document.querySelector('#map').getAttribute('viewBox')`)).split(' ').map(Number);
    check('mouse: wheel faz zoom (viewBox w diminui)', ww < vw0, `w ${vw0} -> ${ww}`);
    check('mouse: zoom mantém proporção h/w', Math.abs(vh0 / vw0 - wh / ww) < 1e-6, `${(vh0 / vw0).toFixed(4)} -> ${(wh / ww).toFixed(4)}`);

    await evalJs(desktop, `(() => {
      const svg = document.querySelector('#map');
      const r = svg.getBoundingClientRect();
      svg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      return true;
    })()`, true);
    await sleep(80);
    const vbReset = await evalJs(desktop, `document.querySelector('#map').getAttribute('viewBox')`);
    check('mouse: duplo clique restaura visão completa', vbReset === vb0, vbReset);

    // tooltip por mousemove sobre um dot
    const tipCheck = await evalJs(desktop, `(() => {
      const dot = document.querySelector('#map circle.dot');
      dot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
      const tip = document.getElementById('tip');
      const shown = tip.style.display === 'block' && tip.innerHTML.length > 0;
      const txt = tip.textContent.replace(/\\s+/g, ' ');
      tip.style.display = 'none';
      return { shown, txt };
    })()`, true);
    check('tooltip (mouse): local verificado + coordenada verificada',
      tipCheck.shown && tipCheck.txt.includes('coordenada verificada'), tipCheck.txt.slice(0, 90));

    // siglas preservadas no tooltip (varre dots até achar nome com sigla)
    const acr = await evalJs(desktop, `(() => {
      const dots = Array.from(document.querySelectorAll('#map circle.dot'));
      const re = /E\\.[BE]\\.[BM]|EBM|EEB|CEI|CMEI|APAE|PROF\\./;
      for (const dot of dots.slice(0, 600)) {
        dot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
        const tip = document.getElementById('tip');
        const h = tip.querySelector('.h');
        if (h && re.test(h.textContent)) { const found = h.textContent; tip.style.display = 'none'; return found; }
      }
      tip.style.display = 'none';
      return null;
    })()`, true);
    check('tooltip: sigla de instituição preservada (sem "E.b.m.")',
      !!acr && !/e\\.[be]\\.[bm]/i.test(acr), acr);
    await shot(desktop, 'd3_tooltip');

    // 2) filtro de candidatos
    await evalJs(desktop, `(() => { document.getElementById('btnChange').click(); return true; })()`, true);
    await waitFor(desktop, `!document.getElementById('tsePanel').hidden`, 4000, 'painel reaberto');
    await evalJs(desktop, `(() => { document.getElementById('btnTseList').click(); return true; })()`, true);
    await waitFor(desktop, `!document.getElementById('tseSel').hidden`, 8000, 'lista de candidatos');
    const listInfo = await evalJs(desktop, `(() => ({
      nOptions: document.getElementById('tseSel').options.length,
      filterRowHidden: document.getElementById('tseFilterRow').hidden,
      selHidden: document.getElementById('tseSel').hidden,
      count: document.getElementById('tseFilterCount').textContent
    }))()`, true);
    check('lista: 253 candidatos (Deputado Federal)', listInfo.nOptions === 253, String(listInfo.nOptions));
    check('lista: filtro + select visíveis + contagem',
      listInfo.filterRowHidden === false && listInfo.selHidden === false && /253 candidatos/.test(listInfo.count),
      listInfo.count);
    assertVis('lista ok (desktop)', await visState(desktop), true);
    await evalJs(desktop, `(() => {
      const f = document.getElementById('tseFilter');
      f.value = 'andozio';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, true);
    await sleep(60);
    const filt = await evalJs(desktop, `(() => {
      const sel = document.getElementById('tseSel');
      return { n: sel.options.length, val: sel.value, txt: sel.options[0] ? sel.options[0].text : '',
               count: document.getElementById('tseFilterCount').textContent };
    })()`, true);
    check('filtro "andozio": só o 1333', filt.n === 1 && filt.val === '1333' && /1333/.test(filt.txt), filt.n + ' ' + filt.txt);
    check('filtro: contagem "1 de 253 candidatos"', filt.count === '1 de 253 candidatos', filt.count);
    await evalJs(desktop, `(() => {
      const f = document.getElementById('tseFilter');
      f.value = '';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, true);
    await sleep(60);
    check('filtro limpo: lista completa volta (253)', (await evalJs(desktop, `document.getElementById('tseSel').options.length`, true)) === 253);

    // 2b) troca de cargo: reseta e oculta filtro + select até nova lista
    await evalJs(desktop, `(() => { document.querySelector('input[name="tseCargo"][value="SENADOR"]').click(); return true; })()`, true);
    await sleep(60);
    const cargoSw = await evalJs(desktop, `(() => ({
      filterRowHidden: document.getElementById('tseFilterRow').hidden,
      selHidden: document.getElementById('tseSel').hidden,
      nOptions: document.getElementById('tseSel').options.length,
      filterVal: document.getElementById('tseFilter').value,
      count: document.getElementById('tseFilterCount').textContent,
      numVal: document.getElementById('tseNum').value
    }))()`, true);
    check('troca de cargo: filtro + select ocultos e resetados',
      cargoSw.filterRowHidden === true && cargoSw.selHidden === true && cargoSw.nOptions === 0 &&
      cargoSw.filterVal === '' && cargoSw.count === '' && cargoSw.numVal === '',
      JSON.stringify(cargoSw));
    assertVis('troca de cargo (desktop)', await visState(desktop), false);
    await evalJs(desktop, `(() => { document.getElementById('btnTseList').click(); return true; })()`, true);
    await waitFor(desktop, `!document.getElementById('tseSel').hidden && !document.getElementById('tseFilterRow').hidden`, 8000, 'lista SENADOR');
    const relist = await evalJs(desktop, `(() => ({
      n: document.getElementById('tseSel').options.length,
      count: document.getElementById('tseFilterCount').textContent
    }))()`, true);
    check('troca de cargo: nova lista reexibe filtro + select',
      relist.n > 0 && /candidato/.test(relist.count), relist.n + ' · ' + relist.count);

    // 2c) listagem sem sucesso (sem snapshot nem CDN): controles seguem invisíveis
    const dfail = await blockedListTab(browser, 1440, 882, false);
    check('lista falha (desktop): erro amigável no painel TSE',
      (await evalJs(dfail, `document.getElementById('tseStatus').classList.contains('error')`, true)) === true);
    assertVis('lista falha (desktop)', await visState(dfail), false);
    dfail.close();

    // 9) a11y: labels e estrutura
    const a11y = await evalJs(desktop, `(() => ({
      zbtnLabel: document.getElementById('zoomIn').getAttribute('aria-label'),
      zbtnReset: document.getElementById('zoomReset').getAttribute('aria-label'),
      svgRole: document.querySelector('#map').getAttribute('role'),
      svgAria: !!document.querySelector('#map').getAttribute('aria-label'),
      filterLabel: document.getElementById('tseFilter').getAttribute('aria-label'),
      hudLegendPe: getComputedStyle(document.getElementById('hudLegend')).pointerEvents
    }))()`, true);
    check('a11y: botões de zoom com aria-label', a11y.zbtnLabel === 'Aproximar' && /Restaurar/.test(a11y.zbtnReset), a11y.zbtnLabel + '/' + a11y.zbtnReset);
    check('a11y: SVG com role=img + aria-label', a11y.svgRole === 'img' && a11y.svgAria);
    check('a11y: filtro com aria-label descritivo', /Filtrar candidatos/.test(a11y.filterLabel || ''));
    check('a11y: HUD não intercepta eventos (pointer-events none)', a11y.hudLegendPe === 'none');

    // 11) exportação SVG/JSON
    const svgName = 'mapa_1333_SC.svg';
    const jsonName = 'mapa_1333_SC.json';
    await evalJs(desktop, `(() => { document.getElementById('btnSvg').click(); return true; })()`, true);
    await waitForDownload(svgName, 8000);
    const dlSvg = downloadFile(svgName);
    check('export SVG: arquivo gerado', !!dlSvg, dlSvg);
    if (dlSvg) {
      const svgTxt = fs.readFileSync(dlSvg, 'utf8');
      check('export SVG: <title> (tooltips nativos) + aria + coordenada verificada',
        svgTxt.includes('<title>') && svgTxt.includes('aria-label') && svgTxt.includes('coordenada verificada'));
    }
    await evalJs(desktop, `(() => { document.getElementById('btnJson').click(); return true; })()`, true);
    await waitForDownload(jsonName, 8000);
    const dlJson = downloadFile(jsonName);
    check('export JSON: arquivo gerado', !!dlJson, dlJson);
    if (dlJson) {
      const j = JSON.parse(fs.readFileSync(dlJson, 'utf8'));
      check('export JSON: total 4876 / 3397 seções / 224 muni',
        j.total === 4876 && j.sections.length === 3397 && Object.keys(j.mun).length === 224);
    }

    // 12) console limpo (desktop)
    check('desktop: sem erros de console/exceção', desktop.consoleErrors.length === 0, desktop.consoleErrors.slice(0, 3).join(' | '));

    // ================= MOBILE 390x844 =================
    console.log('\n== mobile 390x844 ==');
    await metrics(mobile, 390, 844, true);
    await goto(mobile, BASE + '/');

    const mland = await evalJs(mobile, `(() => {
      const p = document.getElementById('tsePanel').getBoundingClientRect();
      const dz = document.getElementById('dropZone').getBoundingClientRect();
      const tb = document.querySelector('.topbar').getBoundingClientRect();
      return {
        panelHidden: document.getElementById('tsePanel').hidden,
        panelTop: Math.round(p.top), dropTop: Math.round(dz.top),
        topbarBottom: Math.round(tb.bottom),
        filterRowHidden: document.getElementById('tseFilterRow').hidden,
        selHidden: document.getElementById('tseSel').hidden,
        scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth
      };
    })()`, true);
    check('mobile: painel TSE visível na carga', mland.panelHidden === false);
    check('mobile: painel TSE no topo (abaixo da topbar)', Math.abs(mland.panelTop - mland.topbarBottom) < 60, `top=${mland.panelTop} topbar=${mland.topbarBottom}`);
    check('mobile: sem scroll horizontal (landing)', mland.scrollW <= mland.innerW + 1, `scrollW=${mland.scrollW}`);
    check('mobile: filtro e select ocultos (antes de listar)', mland.filterRowHidden === true && mland.selHidden === true);
    assertVis('landing (mobile)', await visState(mobile), false);
    await shot(mobile, 'm1_landing');

    // 5) lista + troca de cargo no mobile (mesma semântica do desktop)
    await evalJs(mobile, `(() => { document.getElementById('btnTseList').click(); return true; })()`, true);
    await waitFor(mobile, `!document.getElementById('tseSel').hidden`, 8000, 'lista mobile');
    check('mobile: lista 253 candidatos (Deputado Federal)',
      (await evalJs(mobile, `document.getElementById('tseSel').options.length`, true)) === 253);
    assertVis('lista ok (mobile)', await visState(mobile), true);
    await evalJs(mobile, `(() => { document.querySelector('input[name="tseCargo"][value="SENADOR"]').click(); return true; })()`, true);
    await sleep(60);
    assertVis('troca de cargo (mobile)', await visState(mobile), false);
    await evalJs(mobile, `(() => { document.querySelector('input[name="tseCargo"][value="DEPUTADO FEDERAL"]').click(); return true; })()`, true);
    await sleep(60);

    await evalJs(mobile, `(() => {
      document.getElementById('tseNum').value = '1333';
      document.getElementById('btnTseMap').click();
      return true;
    })()`, true);
    await waitFor(mobile, `!document.getElementById('results').hidden && document.querySelectorAll('#map circle.dot').length > 0`, 15000, 'mapa 1333 mobile');
    await sleep(800); // smooth scroll assentando
    const mres = await evalJs(mobile, `(() => {
      const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const map = document.getElementById('mapBox').getBoundingClientRect();
      const hud = document.getElementById('hudTitle').getBoundingClientRect();
      const leg = document.getElementById('hudLegend').getBoundingClientRect();
      const zr = document.querySelector('.mapzoom').getBoundingClientRect();
      const tb = document.querySelector('.topbar').getBoundingClientRect();
      const res = document.getElementById('results').getBoundingClientRect();
      const zb = document.querySelector('.zbtn').getBoundingClientRect();
      const btn = document.querySelector('#resultActions .btn').getBoundingClientRect();
      return {
        mapTop: Math.round(map.top), mapBottom: Math.round(map.bottom),
        resultsTop: Math.round(res.top), topbarBottom: Math.round(tb.bottom),
        innerH: window.innerHeight,
        hudZoom: overlap(hud, zr), legZoom: overlap(leg, zr), hudLeg: overlap(hud, leg),
        zbtnW: Math.round(zb.width), zbtnH: Math.round(zb.height),
        btnH: Math.round(btn.height),
        scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        legRight: Math.round(leg.right), winW: window.innerWidth
      };
    })()`, true);
    check('mobile: mapa inteiro visível após seleção', mres.mapTop >= 0 && mres.mapBottom <= mres.innerH + 1, `top=${mres.mapTop} bottom=${mres.mapBottom}`);
    check('mobile: mapa abaixo da topbar sticky (sem cobertura)', mres.mapTop >= mres.topbarBottom - 2, `map.top=${mres.mapTop} topbar=${mres.topbarBottom}`);
    check('mobile: HUD não sobrepõe botões de zoom', mres.hudZoom === false, 'overlap=' + mres.hudZoom);
    check('mobile: legenda não sobrepõe HUD/zoom', mres.legZoom === false && mres.hudLeg === false);
    check('mobile: alvos de toque >= 44px (zbtn)', mres.zbtnW >= 44 && mres.zbtnH >= 44, `${mres.zbtnW}x${mres.zbtnH}`);
    check('mobile: botões do resultado >= 44px de altura', mres.btnH >= 44, String(mres.btnH));
    check('mobile: sem scroll horizontal (resultado)', mres.scrollW <= mres.innerW + 1, `scrollW=${mres.scrollW}`);
    check('mobile: legenda dentro da largura', mres.legRight <= mres.winW, `right=${mres.legRight}`);
    await shot(mobile, 'm2_results');

    // 6) toque: pan (1 dedo) + pinch (2 dedos)
    const mvb = await evalJs(mobile, `document.querySelector('#map').getAttribute('viewBox')`);
    const [mx0, , mw0] = mvb.split(' ').map(Number);
    await evalJs(mobile, `(() => {
      const svg = document.querySelector('#map');
      const r = svg.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const P = (type, id, cx, cy, buttons) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: id === 11, button: 0, buttons: buttons || 0, clientX: cx, clientY: cy });
        (type === 'pointerdown' ? svg : window).dispatchEvent(ev);
      };
      P('pointerdown', 11, x, y, 1);
      for (let i = 1; i <= 5; i++) P('pointermove', 11, x - i * 20, y - i * 10, 1);
      P('pointerup', 11, x - 100, y - 50, 0);
      return true;
    })()`, true);
    await sleep(120);
    const [mx1] = (await evalJs(mobile, `document.querySelector('#map').getAttribute('viewBox')`)).split(' ').map(Number);
    check('toque: 1 dedo faz pan (viewBox.x muda)', Math.abs(mx1 - mx0) > 5, `x ${mx0} -> ${mx1}`);

    await evalJs(mobile, `(() => {
      const svg = document.querySelector('#map');
      const r = svg.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const x0 = r.left + r.width / 2 - 60, x1 = r.left + r.width / 2 + 60;
      const P = (type, id, cx, cy, buttons) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: id === 12, button: 0, buttons: buttons || 0, clientX: cx, clientY: cy });
        (type === 'pointerdown' ? svg : window).dispatchEvent(ev);
      };
      P('pointerdown', 12, x0, y, 1);
      P('pointerdown', 13, x1, y, 1);
      for (let i = 1; i <= 5; i++) { P('pointermove', 12, x0 - i * 14, y, 1); P('pointermove', 13, x1 + i * 14, y, 1); }
      P('pointerup', 12, x0 - 70, y, 0);
      P('pointerup', 13, x1 + 70, y, 0);
      return true;
    })()`, true);
    await sleep(120);
    const [, , mw1] = (await evalJs(mobile, `document.querySelector('#map').getAttribute('viewBox')`)).split(' ').map(Number);
    check('toque: pinch afasta = zoom in (w diminui)', mw1 < mw0 * 0.95, `w ${mw0} -> ${mw1}`);

    await evalJs(mobile, `(() => {
      const svg = document.querySelector('#map');
      const r = svg.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const x0 = r.left + r.width / 2 - 90, x1 = r.left + r.width / 2 + 90;
      const P = (type, id, cx, cy, buttons) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: id === 14, button: 0, buttons: buttons || 0, clientX: cx, clientY: cy });
        (type === 'pointerdown' ? svg : window).dispatchEvent(ev);
      };
      P('pointerdown', 14, x0, y, 1);
      P('pointerdown', 15, x1, y, 1);
      for (let i = 1; i <= 5; i++) { P('pointermove', 14, x0 + i * 14, y, 1); P('pointermove', 15, x1 - i * 14, y, 1); }
      P('pointerup', 14, x0 + 70, y, 0);
      P('pointerup', 15, x1 - 70, y, 0);
      return true;
    })()`, true);
    await sleep(120);
    const [, , mw2] = (await evalJs(mobile, `document.querySelector('#map').getAttribute('viewBox')`)).split(' ').map(Number);
    check('toque: pinch aproxima = zoom out (w aumenta)', mw2 > mw1 * 1.05, `w ${mw1} -> ${mw2}`);

    await evalJs(mobile, `(() => { document.getElementById('zoomIn').click(); return true; })()`, true);
    await sleep(120);
    const [, , mw3] = (await evalJs(mobile, `document.querySelector('#map').getAttribute('viewBox')`)).split(' ').map(Number);
    check('mobile: botão + faz zoom', mw3 < mw2 * 0.95, `w ${mw2} -> ${mw3}`);
    await evalJs(mobile, `(() => { document.getElementById('zoomReset').click(); return true; })()`, true);
    await sleep(80);
    const mzr = await evalJs(mobile, `document.querySelector('#map').getAttribute('viewBox')`);
    check('mobile: botão ⟲ restaura visão completa', mzr === mvb, mzr);

    // tap em um dot -> tooltip; tap fora -> fecha
    // (aguarda a janela de supressão de click pós-gesto, 400 ms, expirar)
    await sleep(450);
    const mtap = await evalJs(mobile, `(() => {
      const dot = document.querySelector('#map circle.dot');
      const T = (type, cx, cy) => {
        const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 21, pointerType: 'touch', isPrimary: true, button: 0, clientX: cx, clientY: cy });
        document.querySelector('#map').dispatchEvent(ev);
      };
      T('pointerdown', 100, 100);
      T('pointerup', 100, 100);
      dot.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
      const tip = document.getElementById('tip');
      const shown = tip.style.display === 'block' && tip.textContent.length > 0;
      const full = tip.textContent.replace(/\\s+/g, ' ');
      const txt = full.slice(0, 90);
      document.querySelector('#map').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
      return { shown, full, txt, closed: tip.style.display !== 'block' };
    })()`, true);
    check('mobile: tap no marcador abre tooltip (coordenada verificada)', mtap.shown && mtap.full.includes('coordenada verificada'), mtap.txt);
    check('mobile: tap fora fecha o tooltip', mtap.closed);
    check('mobile: sem erros de console/exceção', mobile.consoleErrors.length === 0, mobile.consoleErrors.slice(0, 3).join(' | '));

    // 9b) listagem sem sucesso (sem snapshot nem CDN): controles seguem invisíveis
    const mfail = await blockedListTab(browser, 390, 844, true);
    check('lista falha (mobile): erro amigável no painel TSE',
      (await evalJs(mfail, `document.getElementById('tseStatus').classList.contains('error')`, true)) === true);
    assertVis('lista falha (mobile)', await visState(mfail), false);
    mfail.close();

    // 10) estados: catálogo indisponível -> ilustrativo por escolha explícita
    const mob2 = await newTab(browser, 'about:blank');
    await metrics(mob2, 390, 844, true);
    await mob2.send('Fetch.enable', { patterns: [{ urlPattern: '*/data/geo_loc/*', requestStage: 'Response' }] });
    mob2.on('Fetch.requestPaused', async p => {
      try { await mob2.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 404, responseHeaders: [], body: Buffer.from('não encontrado').toString('base64') }); } catch (e) { /* noop */ }
    });
    await goto(mob2, BASE + '/');
    await evalJs(mob2, `(() => { document.getElementById('btnSample2').click(); return true; })()`, true);
    await waitFor(mob2, `!document.getElementById('results').hidden`, 15000, 'exemplo (geo bloqueado)');
    const noGeo = await evalJs(mob2, `(() => {
      const svg = document.querySelector('#map');
      return {
        dots: document.querySelectorAll('#map circle.dot').length,
        ill: document.querySelectorAll('#map circle.dot-ill').length,
        aria: svg.getAttribute('aria-label'),
        warnHidden: document.getElementById('warnBox').hidden,
        warn: document.getElementById('warnBox').textContent.slice(0, 90),
        illusBtn: document.getElementById('btnIllus').hidden ? '' : document.getElementById('btnIllus').textContent,
        leg: document.getElementById('hudLegend').textContent.replace(/\\s+/g, ' ')
      };
    })()`, true);
    check('sem catálogo: 0 marcadores (estado indisponível)', noGeo.dots === 0 && noGeo.ill === 0, `${noGeo.dots}/${noGeo.ill}`);
    check('sem catálogo: aria + aviso declaram indisponível', /indisponível/.test(noGeo.aria) && noGeo.warnHidden === false && /indisponível/.test(noGeo.warn));
    check('sem catálogo: legenda declara sem marcadores', /sem marcadores/.test(noGeo.leg), noGeo.leg.slice(0, 80));
    check('sem catálogo: botão "Modo ilustrativo (sem catálogo)" visível', /Modo ilustrativo \(sem catálogo\)/.test(noGeo.illusBtn), noGeo.illusBtn);
    await evalJs(mob2, `(() => { document.getElementById('btnIllus').click(); return true; })()`, true);
    await sleep(300);
    const illOn = await evalJs(mob2, `(() => ({
      ill: document.querySelectorAll('#map circle.dot-ill').length,
      dots: document.querySelectorAll('#map circle.dot:not(.dot-ill)').length,
      aria: document.querySelector('#map').getAttribute('aria-label').slice(-110),
      leg: document.getElementById('hudLegend').textContent.replace(/\\s+/g, ' ').slice(0, 130),
      btn: document.getElementById('btnIllus').textContent
    }))()`, true);
    check('sem catálogo + ilustrativo: 3397 círculos ocos (sem cheios)', illOn.ill === 3397 && illOn.dots === 0, `${illOn.ill}/${illOn.dots}`);
    check('sem catálogo + ilustrativo: aria declara ILUSTRATIVAS', /ILUSTRATIVAS/.test(illOn.aria));
    check('sem catálogo + ilustrativo: legenda "ILUSTRATIVA (não geográfica)"', /ILUSTRATIVA/.test(illOn.leg) && /não geográfica/.test(illOn.leg), illOn.leg);
    check('sem catálogo + ilustrativo: botão ATIVO', illOn.btn.includes('ATIVO'), illOn.btn);
    await shot(mob2, 'm4_illust');
    mob2.close();

    // 10b) erro de rede (CDN, sem snapshot) -> mensagem amigável + retry
    const mob3 = await newTab(browser, 'about:blank');
    await metrics(mob3, 390, 844, true);
    await mob3.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*/tse_2026/index.json', requestStage: 'Response' },
        { urlPattern: 'https://cdn.tse.jus.br/*', requestStage: 'Request' }
      ]
    });
    mob3.on('Fetch.requestPaused', async p => {
      try {
        if (p.request.url.includes('cdn.tse.jus.br')) await mob3.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'NameNotResolved' });
        else await mob3.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 404, responseHeaders: [], body: Buffer.from('não encontrado').toString('base64') });
      } catch (e) { /* noop */ }
    });
    await goto(mob3, BASE + '/');
    await evalJs(mob3, `(() => {
      document.querySelector('input[name="tseCargo"][value="GOVERNADOR"]').click();
      document.getElementById('tseNum').value = '9999';
      document.getElementById('btnTseMap').click();
      return true;
    })()`, true);
    await waitFor(mob3, `!document.getElementById('tseRetry').hidden`, 15000, 'erro de rede');
    const neterr = await evalJs(mob3, `(() => ({
      text: document.getElementById('tseStatusText').textContent,
      isErr: document.getElementById('tseStatus').classList.contains('error'),
      retry: !document.getElementById('tseRetry').hidden,
      panelHidden: document.getElementById('tsePanel').hidden
    }))()`, true);
    check('erro de rede: mensagem amigável (Falha de rede…)', /Falha de rede/.test(neterr.text), neterr.text.slice(0, 70));
    check('erro de rede: modo de erro + "Tentar novamente"', neterr.isErr && neterr.retry);
    check('erro de rede: painel TSE permanece aberto (sem resultados)', neterr.panelHidden === false);
    await shot(mob3, 'm3_neterror');
    mob3.close();

    // 10c) loading: malha municipal atrasada -> estado visível
    const mob4 = await newTab(browser, 'about:blank');
    await metrics(mob4, 1440, 882, false);
    await mob4.send('Fetch.enable', { patterns: [{ urlPattern: '*/geo_sc_municipios.json', requestStage: 'Response' }] });
    mob4.on('Fetch.requestPaused', async p => {
      await sleep(2500);
      try {
        const r = await fetch(BASE + '/data/geo_sc_municipios.json');
        const body = Buffer.from(await r.arrayBuffer()).toString('base64');
        await mob4.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }], body
        });
      } catch (e) { /* noop */ }
    });
    await goto(mob4, BASE + '/');
    await sleep(700);
    const loading = await evalJs(mob4, `document.getElementById('dzStatus').textContent`);
    check('loading: malha municipal em carga (estado visível no dropzone)', /Preparando a malha municipal/.test(loading), loading);
    await waitFor(mob4, `document.getElementById('dzStatus').textContent === ''`, 15000, 'malha pronta');
    check('loading: estado limpo após a malha carregar', true);
    mob4.close();
  } finally {
    desktop.close(); mobile.close();
    browser.close();
    try { chrome.kill(); } catch (e) { /* noop */ }
    srv.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (failed.length ? 'BROWSER UI FALHOU: ' + failed.length + ' verificação(ões)' : 'BROWSER UI OK') + ' (' + results.length + ' verificações)');
  if (failed.length) failed.forEach(f => console.log('  ✗ ' + f.name + (f.extra ? ' (' + f.extra + ')' : '')));
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('EXCEÇÃO:', e); process.exit(1); });
