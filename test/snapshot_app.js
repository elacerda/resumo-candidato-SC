/* Testa o modo snapshot do app (data/tse_2026): mapa/lista por número sem
 * download do CDN, e o fallback CDN com falha de rede ("Failed to fetch"). */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

function makeEl(tag) {
  return {
    tagName: tag, innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
    value: '', files: [], children: [], listeners: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs && this.attrs[k]; },
    querySelector() { return makeEl('child'); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 1000, height: 700, left: 0, top: 0 }; },
    click() {}, appendChild(c) { this.children.push(c); }, remove() {},
    createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return this; } }; },
    getScreenCTM() { return null; }
  };
}
const IDS = ['dropZone','results','fileActions','errBox','btnLoad','fileInput','btnSample','btnSample2',
  'btnSvg','btnJson','chips','warnBox','mapBox','hudTitle','hudLegend','tip','btnTse','tsePanel',
  'tseGoDrop','tseNum','btnTseList','btnTseMap','tseSel','tseStatus','tseStatusText','tseBar',
  'tseSize','tseBig','tseInfo','tseRetry'];
const els = {};
IDS.forEach(id => els[id] = makeEl(id));
const radioCargo = makeEl('input');
radioCargo.value = 'DEPUTADO FEDERAL';
const doc = {
  getElementById: id => els[id] || (els[id] = makeEl(id)),
  querySelector: sel => (sel || '').includes('tseCargo') ? radioCargo : null,
  querySelectorAll: () => [],
  createElement: t => makeEl(t),
  addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = fn; },
  body: makeEl('body')
};
const win = { addEventListener() {}, innerWidth: 1400, innerHeight: 900, scrollTo() {} };
global.window = win;
global.document = doc;
global.self = win;
// fetch: serve arquivos do repo (mesma origem do Pages); CDN do TSE simula
// falha de rede, como no navegador do usuário ("Failed to fetch").
let blockIndex = false; // simula servidor sem o snapshot (index.json 404)
global.fetch = url => {
  if (String(url).startsWith('https://')) return Promise.reject(new TypeError('Failed to fetch'));
  if (blockIndex && String(url).endsWith('index.json')) {
    return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('HTTP 404')) });
  }
  const p = path.join(ROOT, url);
  const ok = fs.existsSync(p);
  return Promise.resolve({
    ok,
    json: () => ok ? Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) : Promise.reject(new Error('HTTP 404'))
  });
};
global.URL = global.URL || {};
global.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
global.URL.createObjectURL = () => 'blob:fake';
global.URL.revokeObjectURL = () => {};

win.ResumoCore = require('../js/core.js');
win.TseCore = require('../js/tse.js');
require('../js/app.js');
const init = doc.listeners['DOMContentLoaded'];
if (!init) { console.error('FAIL: DOMContentLoaded não registrado'); process.exit(1); }

const dots = () => (els.mapBox.innerHTML.match(/class="dot"/g) || []).length;
let ok = true;
function check(name, pass, extra) {
  console.log(pass ? '  ✓' : '  ✗', name, extra ? `(${extra})` : '');
  if (!pass) ok = false;
}

(async () => {
  await init();

  // 1) exemplo (sanity: geo + pipeline)
  await els.btnSample.listeners.click[0]();
  check('exemplo 1333 renderizado', dots() === 3397, String(dots()));

  // 2) fallback CDN (sem snapshot) + falha de rede -> erro amigável + retry
  blockIndex = true; // sem snapshot, o app vai ao CDN do TSE
  radioCargo.value = 'GOVERNADOR';
  els.tseNum.value = '0000';
  await els.btnTseMap.listeners.click[0]();
  await new Promise(r => setTimeout(r, 50));
  const errText = els.tseStatusText.textContent;
  check('erro de rede amigável', /Falha de rede/.test(errText), errText.slice(0, 60));
  check('menção a adblocker/proxy', /adblocker|proxy/.test(errText), '');
  check('botão "Tentar novamente" visível', els.tseRetry.hidden === false, '');
  check('status em modo erro', els.tseStatus.classList.contains('error'), '');

  // 3) retry reexecuta a ação
  await els.tseRetry.listeners.click[0]();
  await new Promise(r => setTimeout(r, 50));
  check('retry reexecuta (erro reaparece)', !els.tseStatus.hidden && /Falha de rede/.test(els.tseStatusText.textContent), '');
  blockIndex = false; // o snapshot "aparece" de volta (CI re-publicou)

  // 4) TSE snapshot: mapa por número, sem download
  radioCargo.value = 'DEPUTADO FEDERAL';
  els.tseNum.value = '1333';
  await els.btnTseMap.listeners.click[0]();
  await new Promise(r => setTimeout(r, 50));
  check('mapa via snapshot (3397 dots)', dots() === 3397, String(dots()));
  check('HUD candidato 1333', els.hudTitle.innerHTML.includes('Andozio (1333)'), els.hudTitle.innerHTML.slice(0, 80));
  check('chip de fonte cita snapshot', els.chips.innerHTML.includes('snapshot'), '');
  check('info do snapshot visível', els.tseInfo.hidden === false && els.tseInfo.textContent.includes('Snapshot'), '');
  check('status oculto após sucesso', els.tseStatus.hidden === true, '');

  // 5) TSE snapshot: lista de candidatos
  await els.btnTseList.listeners.click[0]();
  await new Promise(r => setTimeout(r, 50));
  const selHtml = els.tseSel.innerHTML;
  check('lista via snapshot (JULIANA ANDOZIO 1333)', selHtml.includes('JULIANA ANDOZIO') && selHtml.includes('(1333)'), '');
  check('lista em ordem de votos (top 1 primeiro)', selHtml.indexOf('2233') < selHtml.indexOf('1333'), '');

  // 6) número ausente do snapshot -> rejeição instantânea (sem download)
  radioCargo.value = 'GOVERNADOR';
  els.tseNum.value = '0000';
  await els.btnTseMap.listeners.click[0]();
  await new Promise(r => setTimeout(r, 50));
  const nfText = els.tseStatusText.textContent;
  check('número ausente: rejeitado sem download', /não encontrado/.test(nfText), nfText.slice(0, 70));
  check('número ausente: sem modo de erro', !els.tseStatus.classList.contains('error'), '');
  check('número ausente: retry oculto', els.tseRetry.hidden === true, '');

  console.log(ok ? '\nSNAPSHOT OK' : '\nSNAPSHOT FALHOU');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('EXCEÇÃO:', e); process.exit(1); });
