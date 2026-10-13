/* Smoke test do app no Node com DOM shim mínimo. */
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
const IDS = ['dropZone','results','fileActions','errBox','btnLoad','fileInput','btnSample','btnSample2','btnSvg','btnJson','chips','warnBox','mapBox','hudTitle','hudLegend','tip'];
const els = {};
IDS.forEach(id => els[id] = makeEl(id));
const doc = {
  getElementById: id => els[id] || (els[id] = makeEl(id)),
  createElement: t => makeEl(t),
  addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = fn; },
  body: makeEl('body')
};
const win = { addEventListener() {}, innerWidth: 1400, innerHeight: 900, scrollTo() {} };
global.window = win;
global.document = doc;
global.self = win;
global.fetch = url => {
  const p = path.join(ROOT, url);
  return Promise.resolve({ json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) });
};
global.URL = global.URL || {};
global.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
global.URL.createObjectURL = () => 'blob:fake';
global.URL.revokeObjectURL = () => {};

require('../js/core.js'); // registra global.ResumoCore? não — core usa module.exports no Node
// core.js exporta via module.exports quando module existe; app.js espera window.ResumoCore
win.ResumoCore = require('../js/core.js');

require('../js/app.js');
const init = doc.listeners['DOMContentLoaded'];
if (!init) { console.error('FAIL: DOMContentLoaded não registrado'); process.exit(1); }

(async () => {
  await init();
  await els.btnSample.listeners.click[0]();   // carrega o exemplo 1333
  const svgHtml = els.mapBox.innerHTML;
  const nDots = (svgHtml.match(/class="dot"/g) || []).length;
  const checks = [
    ['mapa renderizado (3397 dots)', nDots === 3397, `achou ${nDots}`],
    ['título HUD', els.hudTitle.innerHTML.includes('Ju Andózio (1333)') && els.hudTitle.innerHTML.includes('Deputada Federal'), ''],
    ['subtítulo com totais', els.hudTitle.innerHTML.includes('4.876 votos em 3.397 seções'), ''],
    ['chips', els.chips.innerHTML.includes('4.876') && els.chips.innerHTML.includes('224 de 295'), ''],
    ['legenda', els.hudLegend.innerHTML.includes('1.745 (Florianópolis)'), ''],
    ['sem avisos', els.warnBox.hidden === true, ''],
    ['dropzone oculta', els.dropZone.classList.contains('hidden') === true, ''],
    ['fileActions visível', els.fileActions.hidden === false, '']
  ];
  let ok = true;
  for (const [name, pass, extra] of checks) {
    console.log(pass ? '  ✓' : '  ✗', name, extra ? `(${extra})` : '');
    if (!pass) ok = false;
  }
  // teste de erro: JSON inválido
  els.fileInput.files = [{ name: 'x.json' }];
  const ReaderProxy = global.FileReader;
  global.FileReader = class {
    readAsText() { this.result = '{"mun": "erro"}'; setTimeout(() => this.onload(), 0); }
  };
  els.fileInput.listeners.change[0]({ target: els.fileInput, preventDefault() {} });
  await new Promise(r => setTimeout(r, 20));
  const errShown = !els.errBox.hidden && els.errBox.textContent.includes('"mun"');
  console.log(errShown ? '  ✓' : '  ✗', 'erro de validação exibido', errShown ? '' : `(${els.errBox.textContent})`);
  if (!errShown) ok = false;
  console.log(ok ? '\nSMOKE OK' : '\nSMOKE FALHOU');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('EXCEÇÃO:', e); process.exit(1); });
