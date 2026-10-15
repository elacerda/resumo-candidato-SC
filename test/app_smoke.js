/* Smoke test do app no Node com DOM shim mínimo. */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

function makeEl(tag) {
  return {
    tagName: tag, innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
    value: '', files: [], children: [], listeners: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, force) { const has = this._s.has(c); const want = force === undefined ? !has : force; if (want) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
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
const IDS = ['dropZone','results','fileActions','errBox','btnLoad','fileInput','btnSample','btnSample2','btnSvg','btnJson','chips','warnBox','mapBox','hudTitle','hudLegend','tip','btnTse','tsePanel','tseGoDrop','tseNum','btnTseList','btnTseMap','tseSel','tseStatus','tseStatusText','tseBar','tseSize','tseBig'];
const els = {};
IDS.forEach(id => els[id] = makeEl(id));
const doc = {
  getElementById: id => els[id] || (els[id] = makeEl(id)),
  querySelector: () => null,
  querySelectorAll: () => [],
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
  const nIll = (svgHtml.match(/class="dot dot-ill"/g) || []).length;
  const checks = [
    ['sem catálogo: sem marcadores por padrão (estado indisponível)', nDots === 0 && nIll === 0, `achou ${nDots}/${nIll}`],
    ['aria declara georreferenciamento indisponível', /aria-label="[^"]*indisponível/.test(svgHtml), ''],
    ['título HUD', els.hudTitle.innerHTML.includes('Ju Andózio (1333)') && els.hudTitle.innerHTML.includes('Deputada Federal'), ''],
    ['subtítulo com totais', els.hudTitle.innerHTML.includes('4.876 votos em 3.397 seções'), ''],
    ['HUD declara indisponível (sem marcadores)', els.hudTitle.innerHTML.includes('georreferenciamento indisponível'), ''],
    ['chips', els.chips.innerHTML.includes('4.876') && els.chips.innerHTML.includes('224 de 295'), ''],
    ['legenda', els.hudLegend.innerHTML.includes('1.745 (Florianópolis)'), ''],
    ['aviso: catálogo indisponível (sem ponto sintético)', !els.warnBox.hidden && /indisponível/.test(els.warnBox.innerHTML), els.warnBox.innerHTML.slice(0, 80)],
    ['botão modo ilustrativo visível (escolha explícita)', els.btnIllus.hidden === false && els.btnIllus.textContent.includes('Modo ilustrativo (sem catálogo)'), els.btnIllus.textContent],
    ['dropzone oculta', els.dropZone.classList.contains('hidden') === true, ''],
    ['fileActions visível', els.fileActions.hidden === false, '']
  ];
  let ok = true;
  for (const [name, pass, extra] of checks) {
    console.log(pass ? '  ✓' : '  ✗', name, extra ? `(${extra})` : '');
    if (!pass) ok = false;
  }
  // modo ilustrativo por escolha explícita: 3397 círculos ocos, modo declarado
  await els.btnIllus.listeners.click[0]();
  const svgIll = els.mapBox.innerHTML;
  const nIll2 = (svgIll.match(/class="dot dot-ill"/g) || []).length;
  const c2 = [
    ['modo ilustrativo: 3397 pontos (círculos ocos)', nIll2 === 3397, `achou ${nIll2}`],
    ['modo ilustrativo: aria declara ILUSTRATIVAS', /aria-label="[^"]*ILUSTRATIVAS/.test(svgIll), ''],
    ['modo ilustrativo: HUD declara posições ilustrativas', els.hudTitle.innerHTML.includes('posições ilustrativas'), ''],
    ['modo ilustrativo: botão ATIVO', els.btnIllus.hidden === false && els.btnIllus.textContent.includes('ATIVO'), els.btnIllus.textContent]
  ];
  for (const [name, pass, extra] of c2) {
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
