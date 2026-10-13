/* E2E: zip oficial TSE -> parser JS -> comparação com 1333_sc_2026.json publicado. */
const fs = require('fs');
const fflate = require('../js/fflate.js');
const Tse = require('../js/tse.js');
const zip = fs.readFileSync('/tmp/tse_sc.zip');

(async () => {
  const t0 = Date.now();
  const entries = fflate.unzipSync(new Uint8Array(zip));
  const name = Object.keys(entries).find(n => n.endsWith('.csv'));
  const csv = entries[name];
  console.log('unzip:', (csv.length / 1e6).toFixed(1) + 'MB em', Date.now() - t0, 'ms');

  const t1 = Date.now();
  const list = await Tse.listCandidates(Tse.csvChunks(csv), 'DEPUTADO FEDERAL');
  const c1333 = list.find(c => c.numero === '1333');
  console.log('listCandidates: ' + list.length + ' candidatos em', Date.now() - t1, 'ms');
  console.log('  1333 ->', JSON.stringify(c1333));
  console.log('  top 5:', list.slice(0, 5).map(c => c.numero + ' ' + c.nome + ' (' + c.votos + ')').join(' | '));

  const t2 = Date.now();
  const ds = await Tse.candidateDataset(Tse.csvChunks(csv), { cargo: 'DEPUTADO FEDERAL', numero: '1333' });
  console.log('candidateDataset(1333):', Date.now() - t2, 'ms | total =', ds.total, '| secoes =', ds.sections.length, '| mun =', Object.keys(ds.mun).length);

  // comparação com o arquivo publicado
  const pub = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'data', '1333_sc_2026.json'), 'utf8'));
  let ok = true;
  const eq = (a, b) => a === b;
  if (ds.total !== pub.total) { ok = false; console.log('DIFF total', ds.total, pub.total); }
  if (ds.sections.length !== pub.sections.length) { ok = false; console.log('DIFF secoes', ds.sections.length, pub.sections.length); }
  if (Object.keys(ds.mun).length !== Object.keys(pub.mun).length) { ok = false; console.log('DIFF mun count'); }
  for (const k of Object.keys(pub.mun)) {
    const a = ds.mun[k], b = pub.mun[k];
    if (!a || a.votos !== b.votos || a.secoes !== b.secoes || a.nome !== b.nome) {
      ok = false; console.log('DIFF mun', k, JSON.stringify(a), JSON.stringify(b)); break;
    }
  }
  const key = s => s.muni + '/' + s.zona + '/' + s.secao;
  const pubMap = new Map(pub.sections.map(s => [key(s), s]));
  for (const s of ds.sections) {
    const p = pubMap.get(key(s));
    if (!p) { ok = false; console.log('seção não publicada:', key(s)); break; }
    if (p.votos !== s.votos || p.local !== s.local || p.end !== s.end || p.muni_nome !== s.muni_nome) {
      ok = false; console.log('DIFF seção', key(s), JSON.stringify(s), JSON.stringify(p)); break;
    }
  }
  console.log(ok ? '✓ TSE -> app: dataset 1333 idêntico ao publicado' : '✗ DIVERGÊNCIA');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('EXCEÇÃO:', e); process.exit(1); });
