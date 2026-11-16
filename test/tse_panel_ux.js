/* Teste de regressão do painel TSE (UX), Node + DOM shim (sem dependências):
 * - parágrafo intro simplificado (sem termos técnicos) no index.html;
 * - #tseFilterRow e #tseSel ocultos no início (HTML e runtime);
 * - visíveis somente após "Listar candidatos" com lista carregada;
 * - falha na listagem mantém ambos ocultos;
 * - troca de cargo reseta e oculta ambos até nova lista;
 * - lookup direto por número ("Mostrar mapa") e o filtro, preservados. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

let ok = true;
function check(name, pass, extra) {
  console.log((pass ? '  ✓' : '  ✗') + ' ' + name + (extra ? ' (' + extra + ')' : ''));
  if (!pass) ok = false;
}

// ---------- 1) index.html: parágrafo intro + estado inicial (HTML) ----------
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INTRO = 'Consulte um candidato pelo número, utilizando os dados oficiais do TSE (Eleições 2026, 1º turno).';
const panelHtml = (html.match(/<section id="tsePanel"[\s\S]*?<\/section>/) || [''])[0];
const introRaw = (panelHtml.match(/<p class="dim">([\s\S]*?)<\/p>/) || [])[1] || '';
const introTxt = introRaw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
check('intro: parágrafo exato no painel TSE', introTxt === INTRO, introTxt.slice(0, 90));
check('intro: sem termos técnicos (snapshot/Actions/CDN/cache)',
  introTxt.length > 0 && !/snapshot|github actions|cdn|cache/i.test(introRaw), '');
check('HTML: #tseFilterRow oculto no início', /id="tseFilterRow"\s+hidden/.test(panelHtml), '');
check('HTML: #tseSel oculto no início', /<select id="tseSel"[^>]*\s+hidden/.test(panelHtml), '');

// ---------- 2) app no Node com DOM shim ----------
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
    getScreenCTM() { return null; },
    scrollIntoView() {}, focus() {}, blur() {}
  };
}
const IDS = ['dropZone','results','fileActions','errBox','btnLoad','fileInput','btnSample','btnSample2',
  'btnSvg','btnJson','chips','warnBox','mapBox','hudTitle','hudLegend','tip','btnTse','tsePanel',
  'tseGoDrop','tseNum','btnTseList','btnTseMap','tseSel','tseStatus','tseStatusText','tseBar',
  'tseRetry','tseCancel','tseFilterRow','tseFilter','tseFilterCount','tseSize','tseBig','tseInfo'];
const els = {};
IDS.forEach(id => els[id] = makeEl(id));
// estado inicial real (index.html): filtro e select nascem ocultos (os
// atributos `hidden` acima já foram verificados estaticamente no passo 1)
els.tseFilterRow.hidden = true;
els.tseSel.hidden = true;
// rádios de cargo: o app lê o "checked" via document.querySelector(...:checked);
// querySelectorAll devolve os cinco para o init registrar o listener de mudança.
const CARGOS = ['DEPUTADO FEDERAL','DEPUTADO ESTADUAL','GOVERNADOR','SENADOR','PRESIDENTE'];
const radios = CARGOS.map(v => { const r = makeEl('input'); r.value = v; r.checked = false; return r; });
radios[0].checked = true;
let checkedRadio = radios[0];
function switchCargo(cargoId) {
  checkedRadio = radios.find(r => r.value === cargoId);
  checkedRadio.checked = true;
  (checkedRadio.listeners.change || []).forEach(fn => fn());
}
const doc = {
  getElementById: id => els[id] || (els[id] = makeEl(id)),
  querySelector: sel => (sel || '').includes('tseCargo') ? checkedRadio : null,
  querySelectorAll: sel => (sel || '').includes('tseCargo') ? radios : [],
  createElement: t => makeEl(t),
  addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = fn; },
  body: makeEl('body')
};
const win = { addEventListener() {}, innerWidth: 1400, innerHeight: 900, scrollTo() {} };
global.window = win;
global.document = doc;
global.self = win;
// fetch: arquivos do repo (mesma origem do Pages); CDN do TSE = falha de rede.
let blockSnapIndex = false; // simula servidor sem o snapshot (index.json 404)
global.fetch = url => {
  if (String(url).startsWith('https://')) return Promise.reject(new TypeError('Failed to fetch'));
  if (blockSnapIndex && String(url).endsWith('index.json')) {
    return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('HTTP 404')) });
  }
  const p = path.join(ROOT, url);
  const found = fs.existsSync(p);
  return Promise.resolve({
    ok: found,
    json: () => found ? Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) : Promise.reject(new Error('HTTP 404'))
  });
};
global.URL = global.URL || {};
global.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
let downloads = 0;
global.URL.createObjectURL = () => { downloads++; return 'blob:fake'; };
global.URL.revokeObjectURL = () => {};

win.ResumoCore = require('../js/core.js');
win.TseCore = require('../js/tse.js');
window.Snapshots = require('../js/snapshots.js');
window.Ea20 = require('../js/ea20.js');
let electoralService;
const Electoral = require('../js/electoral.js');
window.Electoral = { createService(...args) { electoralService = Electoral.createService(...args); return electoralService; } };
require('../js/app.js');
const init = doc.listeners['DOMContentLoaded'];
if (!init) { console.error('FAIL: DOMContentLoaded não registrado'); process.exit(1); }

// esperado: nº de LOCAIS verificados com >= 1 seção do 1333 (mesma lógica de
// snapshot_app.js) — o app usa o catálogo data/geo_loc quando presente.
const locais = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_loc/locais.json'), 'utf8')).locais;
const sec2loc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geo_loc/secoes.json'), 'utf8')).secao2local;
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/1333_sc_2026.json'), 'utf8'));
const idxOf = new Map(sec2loc.map(r => [r[0] + '/' + r[1] + '/' + r[2], r[3]]));
const expLoc = new Set();
for (const s of sample.sections) {
  const i = idxOf.get(s.muni + '/' + s.zona + '/' + s.secao);
  if (i !== undefined && i >= 0) expLoc.add(i);
}
const snapIdx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tse_2026/index.json'), 'utf8'));
const nDF = 229; // cadastro nominal oficial EA20 capturado
const nSEN = Object.keys(snapIdx.cargos['SENADOR'].candidatos).length;
const dots = () => (els.mapBox.innerHTML.match(/class="dot"/g) || []).length;
const nOptions = () => (els.tseSel.innerHTML.match(/<option/g) || []).length;

(async () => {
  await init();

  // 3) estado inicial (nenhuma ação TSE ainda)
  check('início: #tseFilterRow oculto', els.tseFilterRow.hidden === true, '');
  check('início: #tseSel oculto', els.tseSel.hidden === true, '');
  check('início: #tseSel sem opções', nOptions() === 0, '');

  // 4) falha na listagem (sem snapshot + CDN fora do ar) mantém ambos ocultos
  blockSnapIndex = true;
  await els.btnTseList.listeners.click[0]();
  await new Promise(r => setTimeout(r, 50));
  check('falha na lista: erro amigável de rede', /Dados por seção indisponíveis/.test(els.tseStatusText.textContent),
    els.tseStatusText.textContent.slice(0, 60));
  check('falha na lista: "Tentar novamente" visível', els.tseRetry.hidden === false, '');
  check('falha na lista: #tseFilterRow segue oculto', els.tseFilterRow.hidden === true, '');
  check('falha na lista: #tseSel segue oculto (sem opções)', els.tseSel.hidden === true && nOptions() === 0, '');
  blockSnapIndex = false;

  // 5) lookup direto por número ("Mostrar mapa") — preservado, sem lista prévia
  els.tseNum.value = '1333';
  await els.btnTseMap.listeners.click[0]();
  await new Promise(r => setTimeout(r, 80));
  check('mapa direto 1333 (sem lista prévia)', dots() === expLoc.size, `${dots()} vs ${expLoc.size}`);
  check('mapa direto: filtro e select seguem ocultos',
    els.tseFilterRow.hidden === true && els.tseSel.hidden === true, '');

  // 6) "Listar candidatos" -> filtro e select visíveis
  await els.btnTse.listeners.click[0](); // reabre o painel (colapsou após o mapa)
  await els.btnTseList.listeners.click[0]();
  await new Promise(r => setTimeout(r, 50));
  check('lista: #tseFilterRow visível', els.tseFilterRow.hidden === false, '');
  check('lista: #tseSel visível', els.tseSel.hidden === false, '');
  check('lista: 229 candidatos (Deputado Federal)', nOptions() === 229 && nDF === 229,
    `${nOptions()} (índice: ${nDF})`);
  check('lista: contagem "229 candidatos"', els.tseFilterCount.textContent === '229 candidatos',
    els.tseFilterCount.textContent);

  // 7) "Mostrar mapa" via select (campo número vazio) — preservado
  els.tseNum.value = '1333';
  els.tseSel.value = '2233'; // shim: simula a escolha do top-1 na lista
  els.tseSel.listeners.change[0]();
  check('seleção após digitação sincroniza número', els.tseNum.value === '2233', els.tseNum.value);
  await els.btnTseMap.listeners.click[0]();
  await new Promise(r => setTimeout(r, 80));
  check('mapa via select (top-1 2233)', els.hudTitle.innerHTML.includes('(2233)'),
    els.hudTitle.innerHTML.slice(0, 90));

  // 8) filtro de candidatos — preservado
  els.tseFilter.value = 'andoz';
  await els.tseFilter.listeners.input[0]();
  check('filtro "andoz": 1333 presente',
    els.tseSel.innerHTML.includes('JULIANA ANDOZIO') && els.tseSel.innerHTML.includes('(1333)'), '');
  check('filtro: contagem "1 de 229 candidatos"',
    els.tseFilterCount.textContent === '1 de 229 candidatos', els.tseFilterCount.textContent);
  els.tseFilter.value = '';
  await els.tseFilter.listeners.input[0]();
  check('filtro limpo: volta a "229 candidatos"',
    els.tseFilterCount.textContent === '229 candidatos', els.tseFilterCount.textContent);

  // 9) troca de cargo -> reset + ocultar até nova lista
  switchCargo('SENADOR');
  check('troca p/ Senador: #tseFilterRow oculto', els.tseFilterRow.hidden === true, '');
  check('troca p/ Senador: #tseSel oculto', els.tseSel.hidden === true, '');
  check('troca p/ Senador: select sem opções (reset)', nOptions() === 0, '');
  check('troca p/ Senador: número/filtro/contagem limpos',
    els.tseNum.value === '' && els.tseFilter.value === '' && els.tseFilterCount.textContent === '', '');

  // 10) nova lista para o novo cargo -> ambos visíveis de novo
  await els.btnTseList.listeners.click[0]();
  await new Promise(r => setTimeout(r, 50));
  check('novo cargo: #tseFilterRow visível de novo', els.tseFilterRow.hidden === false, '');
  check('novo cargo: #tseSel visível de novo', els.tseSel.hidden === false, '');
  check('novo cargo: lista de Senador (n = índice)', nOptions() === nSEN && nSEN > 0,
    `${nOptions()} (índice: ${nSEN})`);

  // R02: históricos visíveis com EA20 funcionando, separados e filtráveis.
  const eaManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ea20/index.json')));
  let historicalCount = 0, annulledCount = 0;
  for (const cargo of CARGOS) {
    switchCargo(cargo);
    await els.btnTseList.listeners.click[0]();
    const meta = snapIdx.cargos[cargo];
    const historical = meta.sem_cadastro_ea20 || [];
    historicalCount += historical.length;
    check(cargo + ': históricos em grupo separado', !historical.length || els.tseSel.innerHTML.includes('Histórico por seção — sem cadastro atual no EA20'));
    for (const numero of historical) {
      els.tseFilter.value = '';
      els.tseFilter.listeners.input[0]();
      check(cargo + ': histórico ' + numero + ' encontrável', els.tseSel.innerHTML.includes('value="' + numero + '"'));
      els.tseFilter.value = numero;
      els.tseFilter.listeners.input[0]();
      check('histórico filtrável ' + numero, els.tseSel.innerHTML.includes('value="' + numero + '"'));
    }
    els.tseFilter.value = '';
    els.tseFilter.listeners.input[0]();
    const e = eaManifest.resultados.find(x => x.cargo === cargo && x.t === '1');
    const result = window.Ea20.normalize(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ea20', e.arquivo))), {cargo: e.cargoId});
    for (const c of result.candidatos.filter(x => /Anulado/.test(x.classificacao))) {
      annulledCount++;
      check('classificação na opção ' + c.numero, els.tseSel.innerHTML.includes('(' + c.numero + ') — ' + c.votos.toLocaleString('pt-BR') + ' votos apurados · ' + c.classificacao));
    }
  }
  check('12 históricos preservados na listagem normal', historicalCount === 12, historicalCount);
  check('10 classificações Anulado/sub judice explícitas', annulledCount === 10, annulledCount);

  switchCargo('SENADOR');
  els.tseNum.value = '290';
  await els.btnTseMap.listeners.click[0]();
  check('mapa indica classificação atual Anulado sem classificar votos históricos', els.chips.innerHTML.includes('EA20 atual: Anulado') && els.chips.innerHTML.includes('snapshot sem classificação jurídica por voto'));
  switchCargo('DEPUTADO FEDERAL');
  els.tseNum.value = '1550';
  await els.btnTseMap.listeners.click[0]();
  check('mapa histórico declara ausência atual sem inferir motivo jurídico', els.chips.innerHTML.includes('histórico por seção — sem cadastro atual no EA20'));

  const originalAggregate = electoralService.aggregate;
  const e = eaManifest.resultados.find(x => x.cargo === 'DEPUTADO FEDERAL');
  const result = window.Ea20.normalize(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ea20', e.arquivo))), {cargo: e.cargoId});
  electoralService.aggregate = async () => result;
  const emit = (id, event) => els[id].listeners[event][0]();
  const emptyAggregate = tag => {
    const before = downloads;
    emit('btnAggregateJson', 'click'); // Mesmo um clique programático não exporta estado velho.
    check(tag + ': painel/metadados/exportação limpos', els.aggregateResult.hidden && els.aggregateResult.innerHTML === '' && els.btnAggregateJson.hidden && downloads === before);
  };
  for (const change of ['cargo', 'tseTurno', 'tseMunicipio', 'tseZona']) {
    switchCargo('DEPUTADO FEDERAL');
    els.tseTurno.value = '1';
    await emit('btnAggregate', 'click');
    check(change + ': agregado exportável antes da troca', !els.btnAggregateJson.hidden);
    if (change === 'cargo') switchCargo('SENADOR');
    else { els[change].value = change === 'tseTurno' ? '2' : change === 'tseMunicipio' ? '81051' : '12'; emit(change, change === 'tseZona' ? 'input' : 'change'); }
    emptyAggregate(change);
    check(change + ': metadados da lista expiram', els.tseInfo.hidden && els.tseSel.hidden && els.tseFilterCount.textContent === '');
  }
  await emit('btnAggregate', 'click');
  electoralService.aggregate = async () => { throw new TypeError('Failed to fetch'); };
  await emit('btnAggregate', 'click');
  emptyAggregate('erro de rede');
  check('erro de rede permite repetir', !els.tseRetry.hidden);

  // Resposta tardia não repõe lista/exportação e não libera busy da nova consulta.
  for (const operation of ['btnTseList', 'btnAggregate']) {
    switchCargo('DEPUTADO FEDERAL');
    els.tseTurno.value = '1';
    let resolveOld, resolveNew;
    electoralService.aggregate = () => new Promise(resolve => { resolveOld = resolve; });
    const oldQuery = emit(operation, 'click');
    switchCargo('SENADOR');
    electoralService.aggregate = () => new Promise(resolve => { resolveNew = resolve; });
    const newQuery = emit('btnAggregate', 'click');
    resolveOld(result);
    await oldQuery;
    emptyAggregate(operation + ': resposta antiga ignorada');
    let extraCalls = 0;
    electoralService.aggregate = async () => { extraCalls++; return result; };
    await emit('btnAggregate', 'click');
    check(operation + ': finally antigo não libera nova consulta', extraCalls === 0);
    resolveNew({...result, cargo: 'SENADOR'});
    await newQuery;
    check(operation + ': nova consulta prevalece', els.aggregateResult.innerHTML.includes('SENADOR'));
  }
  // Erro tardio também não sobrepõe o estado atual.
  switchCargo('DEPUTADO FEDERAL');
  let rejectOld;
  electoralService.aggregate = () => new Promise((resolve, reject) => { rejectOld = reject; });
  const oldError = emit('btnAggregate', 'click');
  switchCargo('SENADOR');
  electoralService.aggregate = async () => ({...result, cargo: 'SENADOR'});
  await emit('btnAggregate', 'click');
  rejectOld(new TypeError('Failed to fetch'));
  await oldError;
  check('erro antigo ignorado', els.aggregateResult.innerHTML.includes('SENADOR') && els.tseRetry.hidden);
  electoralService.aggregate = originalAggregate;

  console.log(ok ? '\nPAINEL TSE UX OK' : '\nPAINEL TSE UX FALHOU');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('EXCEÇÃO:', e); process.exit(1); });
