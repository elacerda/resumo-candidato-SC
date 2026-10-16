/* Regressão de browser (headless Chrome via CDP, sem imagens) para os
 * RÓTULOS ADAPTATIVOS de município:
 *
 *  - prioridade por votos do candidato, sem limiar absoluto (candidato de
 *    3M, de 4,8 mil e de 184 votos passam pelo mesmo algoritmo);
 *  - sem sobreposição entre caixas REAIS renderizadas (getBoundingClientRect
 *    dos <text> visíveis — não apenas contagem de array);
 *  - zoom de estado completo = só nomes; ao aproximar, a linha "N votos"
 *    aparece e MAIS rótulos são revelados (colisão recalculada por rAF);
 *  - densidade adaptada à viewport (1440px vs 390px) — mobile mais esparso;
 *  - nenhum rótulo sob os painéis flutuantes opacos (HUD/legenda/botões):
 *    desvio determinístico LIMITADO (máx. ~1 tamanho de rótulo + gap por
 *    eixo — sem teleporte que desligue o rótulo do município), medido só
 *    sobre os pixels visíveis do rótulo (área fora do viewport do SVG é
 *    clipada pelo browser e não conta);
 *  - no mobile o HUD cobre a parte de cima do mapa no zoom total: o 1º
 *    município por votos pode ficar oculto no estado completo e o rótulo
 *    é exigido APÓS o zoom na região dele (revelação por zoom);
 *  - hover no choropleth revela os votos por município (interação);
 *  - export SVG com rótulos sem sobreposição (arquivo renderizado e medido).
 *
 * Uso: node test/labels_browser.js
 * Requer: Node >= 22 (WebSocket global) e google-chrome/chromium no PATH
 * (override CHROME_BIN). Portas fixas 8125/9341. Saída: 0 = ok, 1 = falha.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8125;
const CDP_PORT = 9341;
const BASE = 'http://127.0.0.1:' + PORT;
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
let DL_DIR = '';
function startServer() {
  const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
                 '.json': 'application/json', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/dl/')) {
      const f = path.join(DL_DIR, path.basename(p));
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
      return;
    }
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
  const userDataDir = fs.mkdtempSync('/tmp/cdp-labels-');
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
  await sleep(200);
}
async function waitFor(c, expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try { if (await evalJs(c, expr)) return; } catch (e) { /* ainda carregando */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout esperando: ' + (label || expr));
    await sleep(120);
  }
}

// ---------- estado REAL dos rótulos: caixas renderizadas (px de tela) ----------
// Mede getBoundingClientRect de cada <text.lbl> visível e conta pares com
// sobreposição efetiva (tolerância 0,5 px). 'votes' = linhas "N votos".
const LABEL_STATE = `(() => {
  const ov = (a, b) => !(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 ||
                         a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5);
  const els = Array.from(document.querySelectorAll('#map text.lbl'))
    .filter(t => t.style.display !== 'none' && t.getClientRects().length > 0);
  const items = els.map(t => ({ r: t.getBoundingClientRect(), txt: t.textContent,
                                votes: (t.getAttribute('class') || '').includes('lbl-votes') }));
  let pairs = 0; const ex = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (ov(items[i].r, items[j].r)) { pairs++; if (ex.length < 3) ex.push(items[i].txt + ' | ' + items[j].txt); }
  }
  // painéis flutuantes opacos sobre o mapa: rótulo com >25 px² de pixels
  // VISÍVEIS embaixo deles está ilegível (o desvio determinístico deve
  // zerar esta lista). Áreas fora do viewport do SVG são clipadas pelo
  // browser (overflow:hidden) — o getBoundingClientRect do <text> ainda as
  // reporta, então o retângulo é clipado na caixa do SVG antes de medir.
  const svgr = document.querySelector('#map').getBoundingClientRect();
  const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
                         Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const clip = r => ({ left: Math.max(r.left, svgr.left), right: Math.min(r.right, svgr.right),
                       top: Math.max(r.top, svgr.top), bottom: Math.min(r.bottom, svgr.bottom) });
  const panels = [['hud', document.getElementById('hudTitle')],
                  ['legend', document.getElementById('hudLegend')],
                  ['zoom', document.querySelector('.mapzoom')]]
    .filter(x => x[1]).map(x => [x[0], x[1].getBoundingClientRect()]);
  const underPanels = items
    .filter(x => panels.some(p => area(clip(x.r), p[1]) > 25))
    .map(x => x.txt + ':' + panels.filter(p => area(clip(x.r), p[1]) > 25)
      .map(p => p[0] + Math.round(area(clip(x.r), p[1])) + 'px²').join('+'));
  return {
    n: items.length,
    names: items.filter(x => !x.votes).map(x => x.txt),
    nVotes: items.filter(x => x.votes).length,
    votesTxt: items.filter(x => x.votes).map(x => x.txt),
    pairs, ex, underPanels,
    vb: document.querySelector('#map').getAttribute('viewBox')
  };
})()`;

// candidatos: presidencial (3M), votação média (4,8 mil) e baixa (184 votos)
const CANDS = [
  { id: 'pres-22', cargo: 'PRESIDENTE', numero: '22', top: 'Joinville', topVotes: '246.309', topIbge: '4209102', low: false },
  { id: 'fed-1333', cargo: 'DEPUTADO FEDERAL', numero: '1333', top: 'Florianópolis', topVotes: '1.745', topIbge: '4205407', low: false },
  { id: 'pres-28', cargo: 'PRESIDENTE', numero: '28', top: 'Joinville', topVotes: '19', topIbge: '4209102', low: true }
];
// IBGE -> nome exibido (titleCase da malha) para o hover do choropleth
const MUN_NAMES = { '4209102': 'Joinville', '4205407': 'Florianópolis', '4202404': 'Blumenau' };

async function loadMap(t, c) {
  await evalJs(t, `(() => {
    document.querySelector('input[name="tseCargo"][value="${c.cargo}"]').click();
    document.getElementById('tseNum').value = '${c.numero}';
    document.getElementById('btnTseMap').click(); return true;
  })()`, true);
  await waitFor(t, `!document.getElementById('results').hidden && document.querySelectorAll('#map circle.dot').length > 0`, 25000, 'mapa ' + c.id);
}
async function resetView(t) {
  await evalJs(t, `(() => { document.getElementById('zoomReset').click(); return true; })()`, true);
  await sleep(300); // rAF: apply() + layout dos rótulos
}
// zoom ~2,3x na região do 1º município por votos: ancora no CENTRO DO
// POLÍGONO do município (não no rótulo, que pode estar oculto no estado
// completo — ex.: mobile, HUD cobrindo a região) e verifica o rótulo
// APÓS o zoom (revelação por zoom + prioridade por votos)
async function zoomAtTopMuni(t, ibge, topName) {
  const found = await evalJs(t, `(() => {
    const p = document.querySelector('#map path.mun[data-g="${ibge}"]');
    if (!p) return false;
    const r = p.getBoundingClientRect();
    const svg = document.querySelector('#map');
    svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -560 }));
    return true;
  })()`, true);
  if (!found) throw new Error('polígono do 1º município não encontrado: ' + topName);
  await sleep(300);
  return evalJs(t, LABEL_STATE, true);
}
// pan com pointer drag (o layout deve recalcular sem sobreposição)
async function panMap(t, dx, dy) {
  await evalJs(t, `(() => {
    const svg = document.querySelector('#map');
    const r = svg.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const P = (type, cx, cy, buttons) => {
      const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7,
        pointerType: 'mouse', isPrimary: true, button: 0, buttons: buttons || 0, clientX: cx, clientY: cy });
      (type === 'pointerdown' ? svg : window).dispatchEvent(ev);
    };
    P('pointerdown', x, y, 1);
    for (let i = 1; i <= 4; i++) P('pointermove', x + ${dx} * i / 4, y + ${dy} * i / 4, 1);
    P('pointerup', x + ${dx}, y + ${dy}, 0);
    return true;
  })()`, true);
  await sleep(300);
  return evalJs(t, LABEL_STATE, true);
}
// hover no polígono do município (data-g = IBGE): tooltip com votos
async function hoverMun(t, c, ibge, expectedNome, expectedVotes) {
  return evalJs(t, `(() => {
    const p = document.querySelector('#map path.mun[data-g="${ibge}"]');
    if (!p) return { found: false };
    p.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
    const tip = document.getElementById('tip');
    const shown = tip.style.display === 'block' && tip.textContent.length > 0;
    const txt = tip.textContent.replace(/\\s+/g, ' ');
    tip.style.display = 'none';
    return { found: true, shown, txt };
  })()`, true);
}

async function main() {
  if (!CHROME) { console.error('Chrome não encontrado — defina CHROME_BIN ou instale google-chrome.'); process.exit(2); }
  const srv = await startServer();
  const { chrome, browser } = await launchChrome();
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: (DL_DIR = fs.mkdtempSync('/tmp/labelsdl-')) });

  const fullCounts = {}; // 'cand@viewport' -> n (para comparar desktop vs mobile)
  const desktop = await newTab(browser, 'about:blank');
  const mobile = await newTab(browser, 'about:blank');

  try {
    const runViewport = async (tab, w, h, mobileFlag, tag, doExport) => {
      console.log('\n== ' + tag + ' ==');
      await metrics(tab, w, h, mobileFlag);
      await goto(tab, BASE + '/');
      for (const c of CANDS) {
        await loadMap(tab, c);
        await resetView(tab);
        const cap = mobileFlag ? 50 : 90;   // teto de "esparso" por viewport
        const floor = mobileFlag ? 8 : 15; // piso: rótulos existem p/ qualquer escala
        // no mobile os painéis opacos (HUD + coluna de zoom) cobrem boa parte do
        // mapa no zoom total — o desvio/rejeição por painel é o que mantém os
        // rótulos legíveis (antes do desvio, ~28 rótulos estavam 100% ocultos)
        const full = await evalJs(tab, LABEL_STATE, true);
        fullCounts[c.id + '@' + tag] = full.n;
        check(`${tag}/${c.id}: SEM sobreposição entre caixas renderizadas (zoom total)`,
          full.pairs === 0, full.pairs ? full.ex.join(' ;; ') : full.n + ' caixas');
        check(`${tag}/${c.id}: zoom de estado completo = só nomes (votos só ao aproximar)`,
          full.nVotes === 0, 'linhas de votos: ' + full.nVotes);
        // no mobile o HUD cobre a região do 1º município no zoom total —
        // aí a exigência é o rótulo aparecer APÓS o zoom (check abaixo)
        if (!mobileFlag) {
          check(`${tag}/${c.id}: 1º município por votos tem rótulo (prioridade por votos)`,
            full.names.includes(c.top), full.names.slice(0, 8).join(', '));
        }
        check(`${tag}/${c.id}: densidade esparra e legível (${floor}..${cap})`,
          full.n >= floor && full.n <= cap, 'n=' + full.n + ' (nomes: ' + full.names.length + ')');
        check(`${tag}/${c.id}: nenhum rótulo sob HUD/legenda/botões de zoom (zoom total)`,
          full.underPanels.length === 0, full.underPanels.join(', '));
        if (c.low) {
          check(`${tag}/${c.id}: candidato de ${c.topVotes} votos NO TOTAL tem rótulos (sem limiar fixo)`,
            full.n >= floor, 'n=' + full.n + ' — nenhum município chega a 60 votos');
        }
        // hover no choropleth: votos do município por interação
        const hov = await hoverMun(tab, c, c.topIbge, MUN_NAMES[c.topIbge], c.topVotes);
        check(`${tag}/${c.id}: hover no município mostra votos (${c.topVotes})`,
          hov.found && hov.shown && hov.txt.includes(MUN_NAMES[c.topIbge]) && hov.txt.includes(c.topVotes + ' votos'),
          hov.txt ? hov.txt.slice(0, 90) : 'path não encontrado');

        // zoom ~2,3x na região do 1º município: revela mais rótulos +
        // linha de votos + (mobile) o rótulo do 1º município em si
        const zoomed = await zoomAtTopMuni(tab, c.topIbge, c.top);
        const [,, zw] = zoomed.vb.split(' ').map(Number);
        const [, , fw] = full.vb.split(' ').map(Number);
        check(`${tag}/${c.id}: zoom aproximou a vista`, zw < fw * 0.5, `w ${fw} -> ${Math.round(zw)}`);
        check(`${tag}/${c.id}: zoom: SEM sobreposição entre caixas renderizadas`,
          zoomed.pairs === 0, zoomed.pairs ? zoomed.ex.join(' ;; ') : zoomed.n + ' caixas');
        check(`${tag}/${c.id}: zoom: nenhum rótulo sob HUD/legenda/botões de zoom`,
          zoomed.underPanels.length === 0, zoomed.underPanels.join(', '));
        check(`${tag}/${c.id}: zoom: linha "N votos" aparece (votos ao aproximar)`,
          zoomed.nVotes > 0 && zoomed.votesTxt.includes(c.topVotes + ' votos'),
          zoomed.votesTxt.slice(0, 5).join(', '));
        check(`${tag}/${c.id}: zoom revela rótulos adicionais (n_zoom >= n_full)`,
          zoomed.n >= full.n, `${full.n} -> ${zoomed.n}`);
        check(`${tag}/${c.id}: 1º município rotulado após o zoom (prioridade + revelação)`,
          zoomed.names.includes(c.top), zoomed.names.slice(0, 6).join(', '));

        // pan: recalcula visibilidade (rAF) mantendo sem colisão
        const panned = await panMap(tab, mobileFlag ? 60 : 140, mobileFlag ? 40 : 90);
        check(`${tag}/${c.id}: pan: recalcula rótulos SEM sobreposição`,
          panned.pairs === 0, panned.pairs ? panned.ex.join(' ;; ') : panned.n + ' caixas');
        check(`${tag}/${c.id}: pan: nenhum rótulo sob HUD/legenda/botões de zoom`,
          panned.underPanels.length === 0, panned.underPanels.join(', '));
        await resetView(tab);
      }
      // export SVG (desktop): arquivo renderizado num documento SVG e medido
      if (doExport) {
        await loadMap(tab, CANDS[0]);
        await resetView(tab);
        await evalJs(tab, `(() => { document.getElementById('btnSvg').click(); return true; })()`, true);
        const name = 'mapa_22_SC.svg';
        const t0 = Date.now();
        while (!fs.existsSync(path.join(DL_DIR, name)) && Date.now() - t0 < 10000) await sleep(200);
        const f = path.join(DL_DIR, name);
        check('export SVG: arquivo gerado', fs.existsSync(f), name);
        if (fs.existsSync(f)) {
          const et = await newTab(browser, BASE + '/dl/' + encodeURIComponent(name));
          try {
            for (let i = 0; i < 50; i++) {
              if (await evalJs(et, 'document.readyState') === 'complete') break;
              await sleep(100);
            }
            await sleep(200);
            const est = await evalJs(et, `(() => {
              const ov = (a, b) => !(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 ||
                                     a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5);
              const items = Array.from(document.querySelectorAll('text.lbl'))
                .map(t => ({ r: t.getBoundingClientRect(), txt: t.textContent }));
              let pairs = 0; const ex = [];
              for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++)
                if (ov(items[i].r, items[j].r)) { pairs++; if (ex.length < 3) ex.push(items[i].txt + ' | ' + items[j].txt); }
              return { n: items.length, pairs, ex, hasVotes: items.some(x => /votos/.test(x.txt)),
                       sample: items.slice(0, 4).map(x => x.txt) };
            })()`, true);
            check('export SVG: rótulos presentes (sem limiar de 60 votos no export)',
              est.n >= 5, 'n=' + est.n + ' ' + est.sample.join(', '));
            check('export SVG: densidade sensível (<= 80 rótulos)', est.n <= 80, 'n=' + est.n);
            check('export SVG: SEM sobreposição entre caixas renderizadas',
              est.pairs === 0, est.pairs ? est.ex.join(' ;; ') : est.n + ' caixas');
            check('export SVG: escala base = só nomes (linha de votos só em zoom)',
              est.hasVotes === false, String(est.hasVotes));
          } finally { et.close(); }
        }
      }
      check(tag + ': sem erros de console/exceção', tab.consoleErrors.length === 0,
        tab.consoleErrors.slice(0, 3).join(' | '));
      tab.close();
    };

    await runViewport(desktop, 1440, 882, false, 'desktop 1440', true);
    await runViewport(mobile, 390, 844, true, 'mobile 390', false);

    // viewport: mesma vista em telas maiores comporta mais rótulos (gap em px)
    for (const c of CANDS) {
      const d = fullCounts[c.id + '@desktop 1440'], m = fullCounts[c.id + '@mobile 390'];
      check(`viewport: ${c.id} tem mais rótulos em 1440px que em 390px (densidade adaptada)`,
        d > m, `1440:${d} vs 390:${m}`);
    }
  } finally {
    try { desktop.close(); } catch (e) { /* noop */ }
    try { mobile.close(); } catch (e) { /* noop */ }
    browser.close();
    try { chrome.kill(); } catch (e) { /* noop */ }
    srv.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (failed.length ? 'LABELS BROWSER FALHOU: ' + failed.length + ' verificação(ões)' : 'LABELS BROWSER OK') + ' (' + results.length + ' verificações)');
  if (failed.length) failed.forEach(f => console.log('  ✗ ' + f.name + (f.extra ? ' (' + f.extra + ')' : '')));
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('EXCEÇÃO:', e); process.exit(1); });
