/* Testes reproduzíveis: somente capturas oficiais versionadas e dados locais. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ea20 = require('../js/ea20.js');
const Snapshots = require('../js/snapshots.js');
const Electoral = require('../js/electoral.js');
const { compare } = require('../js/source-compare.js');
const root = path.join(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const fixture = n => read('test/fixtures/ea20/' + n + '.json');
const expected = { ele: '6259', t: '1', cargo: '6', tpabr: 'uf', cdabr: 'sc' };

(async () => {
  const raw = fixture('dep_federal');
  const model = Ea20.normalize(raw, expected);
  assert.equal(model.candidatos.length, 224);
  assert.equal(model.candidatos.find(c => c.numero === '1333').votos, 4876);
  assert.equal(model.partidos.find(p => p.numero === '13').legenda, 28778);
  assert(!model.candidatos.some(c => c.numero === '13'));
  assert(model.candidatos.some(c => c.classificacao === 'Anulado sub judice'));
  const state = Ea20.normalize(fixture('dep_estadual'), { ...expected, cargo: '7' });
  assert(state.candidatos.some(c => c.classificacao === 'Anulado'));
  for (const [key, value] of Object.entries({ ele: '6257', t: '2', cargo: '3', tpabr: 'mu', cdabr: 'rs' })) {
    assert.throws(() => Ea20.normalize(raw, { ...expected, [key]: value }));
  }
  for (const bad of ['-1', '3.1', null, '', 'NaN', '9007199254740992']) assert.throws(() => Ea20.integer(bad));
  const partial = structuredClone(raw); partial.and = 'p'; partial.tf = 'n';
  assert.equal(Ea20.normalize(partial, expected).andamento, 'p'); // perturbação explícita, não captura oficial
  assert.equal(Ea20.normalize(fixture('municipio'), { ...expected, tpabr: 'mu', cdabr: '81051' }).abrangencia.codigo, '81051');
  assert.equal(Ea20.normalize(fixture('zona'), { ...expected, tpabr: 'zona', cdabr: '0012' }).abrangencia.tipo, 'zona');
  assert.equal(Ea20.normalize(fixture('presidente-2'), { ele: '6258', t: '2', cargo: '1', tpabr: 'uf', cdabr: 'sc' }).turno, '2');
  const elections = Ea20.elections(fixture('ele-c'), 'ele2026');
  assert(elections.some(x => x.ele === '6259' && x.cargo === '6' && x.t === '1'));
  assert(!elections.some(x => x.t === '2' && x.cargo === '3' && ['br', 'sc'].includes(x.uf)));
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    assert(!/\.zip(?:$|\?)/i.test(url), 'ZIP não pode ser consultado');
    const p = path.join(root, url);
    return { ok: fs.existsSync(p), status: fs.existsSync(p) ? 200 : 404, json: async () => read(url) };
  };
  const snap = Snapshots.createClient(fetcher);
  const service = Electoral.createService(fetcher, snap, Ea20.createClient(fetcher));
  const ds = await snap.candidate('DEPUTADO FEDERAL', '1333');
  const sample = read('data/1333_sc_2026.json');
  assert.equal(ds.total, sample.total);
  const identity = s => s.muni + '/' + s.zona + '/' + s.secao;
  const ordered = rows => rows.slice().sort((a, b) => identity(a).localeCompare(identity(b)));
  assert.deepEqual(ordered(ds.sections), ordered(sample.sections));
  assert.deepEqual(ds.mun, sample.mun);
  assert(requests.includes('data/tse_2026/candidatos/dep_federal/1333.json'));
  assert(!requests.includes('data/tse_2026/dep_federal.json'));
  const size = requests.length;
  await snap.candidate('DEPUTADO FEDERAL', '1333');
  assert.equal(requests.length, size);
  assert.equal(await snap.candidate('DEPUTADO FEDERAL', '13'), null);
  assert.equal(await snap.candidate('DEPUTADO FEDERAL', '1333', '2'), null);
  const aggregate = await service.aggregate('DEPUTADO FEDERAL');
  assert.equal(aggregate.candidatos.find(x => x.numero === '1333').votos, ds.total);
  assert(aggregate.candidatos.some(x => x.nome.includes('ANDOZIO')));
  await assert.rejects(service.aggregate('GOVERNADOR', '2'), /indisponível/);
  await assert.rejects(service.aggregate('DEPUTADO FEDERAL', '1', '../x'), /inválidos/);
  const noCors = async url => {
    if (url.startsWith('https:')) throw new TypeError('Failed to fetch');
    return fetcher(url);
  };
  const offline = Electoral.createService(noCors, snap, Ea20.createClient(noCors));
  assert.equal((await offline.aggregate('DEPUTADO FEDERAL')).candidatos.length, 224);
  await assert.rejects(offline.aggregate('DEPUTADO FEDERAL', '1', '81051'), /Failed to fetch/);
  const failing = Ea20.createClient(async () => { throw new Error('HTTP 503'); });
  await assert.rejects(failing.get('data/test.json', expected), /503/);
  let calls = 0;
  const retry = Ea20.createClient(async () => { if (++calls === 1) throw new Error('temporário'); return { ok: true, json: async () => raw }; });
  await assert.rejects(retry.get('x', expected));
  assert.equal((await retry.get('x', expected)).candidatos.length, 224);
  const context = { eleicaoId: '6259', turno: '1', cargoId: '6', uf: 'SC', municipio: '', zona: '', categoria: 'nominal', classificacao: 'Válido', andamento: 'f', totalizacaoFinal: 's', atualizado: model.atualizado, total: 4876 };
  assert.deepEqual(compare(context, context), { comparavel: true, diferenca: 0, publicar: true, estado: 'coincidente', motivo: { ausentes: [], diferentes: [] } });
  assert.equal(compare(context, { ...context, total: 4877 }).publicar, false);
  assert.equal(compare(context, { ...context, atualizado: 'outra data', total: 4877 }).comparavel, false);
  assert.equal(compare(context, { ...context, categoria: 'legenda' }).comparavel, false);
  assert.equal(compare(context, { ...context, atualizado: null }).publicar, false);
  assert.equal(compare(context, { ...context, classificacao: 'Anulado sub judice' }).publicar, false);
  assert.equal(compare(context, { ...context, totalizacaoFinal: 'n' }).publicar, false);
  assert.throws(() => compare({ ...context, total: -1 }, { ...context, total: -1 }));
  const idx = read('data/tse_2026/index.json'), table = read('data/tse_2026/secoes.json');
  const votes = read('data/tse_2026/candidatos/dep_federal/1333.json');
  for (const bad of [ [[-1, 1]], [[0, -1]], [[0, 1], [0, 1]], [[999999, 1]] ]) {
    assert.throws(() => Snapshots.dataset(idx, 'DEPUTADO FEDERAL', '1333', { ...votes, votos: bad }, table));
  }
  for (const target of ['candidatos/dep_federal/1333.json', 'secoes.json']) {
    const tampered = Snapshots.createClient(async url => {
      const value = read(url);
      if (url.endsWith(target)) {
        if (value.votos) [value.votos[0][0], value.votos[1][0]] = [value.votos[1][0], value.votos[0][0]];
        else [value.secoes[0], value.secoes[1]] = [value.secoes[1], value.secoes[0]];
      }
      return { ok: true, json: async () => value };
    });
    await assert.rejects(tampered.candidate('DEPUTADO FEDERAL', '1333'), /hash SHA-256 diferente/);
  }
  // Valida o conjunto inteiro e a equivalência exata com cada arquivo legado.
  let count = 0;
  for (const [cargo, c] of Object.entries(idx.cargos)) {
    const legacy = read('data/tse_2026/' + c.arquivo);
    assert.equal(Object.keys(c.candidatos).length + Object.keys(c.partidos).length, Object.keys(legacy.cand).length);
    for (const numero of Object.keys(c.candidatos)) {
      const v = read('data/tse_2026/' + c.diretorio + '/' + numero + '.json');
      assert.deepEqual(v.votos, legacy.cand[numero]);
      const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'data/tse_2026/' + c.diretorio + '/' + numero + '.json'))).digest('hex');
      assert.equal(sha, c.arquivos_sha256[numero]);
      const rebuilt = Snapshots.dataset(idx, cargo, numero, v, table);
      assert.equal(rebuilt.categoria, 'nominal');
      assert.equal(rebuilt.historico, (c.sem_cadastro_ea20 || []).includes(numero));
      assert.equal(rebuilt.classificacao, null);
      count++;
    }
  }
  assert(!/unzipSync|cdn\.tse\.jus\.br|\.zip/.test(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8')));
  console.log('ELECTORAL DATA OK: EA11/EA20, categorias, turnos, CORS, falhas, cache, comparabilidade e ' + count + ' snapshots equivalentes');
})().catch(e => { console.error(e); process.exitCode = 1; });
