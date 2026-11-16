#!/usr/bin/env python3
"""Regressões do gate real: versões distintas, divergência e revisão vinculada."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sync'))
from source_compare import compare, promotion_allowed, verify_bundle


class PromotionChecks(unittest.TestCase):
    """Exercita decisão pura e gerador real em diretórios temporários isolados."""

    def test_context_and_approval(self):
        """Divergência comparável é irrecorrível; revisão vale só para bytes exatos."""
        a = dict(eleicaoId='6259', turno='1', cargoId='6', uf='SC', municipio='',
                 zona='', categoria='nominal', classificacao='Válido', andamento='f',
                 totalizacaoFinal='s', atualizado='24/10/2026 11:25:57', total=4876)
        for delta in (0, 1):
            b = {**a, 'total': a['total'] + delta}
            decision = compare(a, b)
            self.assertEqual(decision['estado'], 'divergencia_bloqueante' if delta else 'coincidente')
            row = dict(snapshot=a['total'], ea20=b['total'], contexto_snapshot=a, contexto_ea20=b, **decision)
            body = json.dumps({'comparacoes': [row]}).encode()
            approval = dict(relatorio_sha256=hashlib.sha256(body).hexdigest(), decisao='aprovar_fontes_independentes',
                            revisor='Revisor de teste', revisado_em='2026-11-16', justificativa='Teste isolado')
            self.assertEqual(promotion_allowed(body, approval), not delta)
        for key in ('atualizado', 'classificacao', 'turno', 'cargoId', 'uf', 'municipio', 'zona'):
            b = {**a, key: None}
            decision = compare(a, b)
            self.assertEqual(decision['estado'], 'revisao_obrigatoria')
            row = dict(snapshot=a['total'], ea20=b['total'], contexto_snapshot=a, contexto_ea20=b, **decision)
            body = json.dumps({'comparacoes': [row]}).encode()
            self.assertFalse(promotion_allowed(body))
            approval['relatorio_sha256'] = hashlib.sha256(body).hexdigest()
            self.assertTrue(promotion_allowed(body, approval))
            self.assertFalse(promotion_allowed(body + b' ', approval))
        self.assertFalse(promotion_allowed(b'{"comparacoes":[]}'))
        with self.assertRaises(ValueError):
            compare({**a, 'total': True}, a)

    def test_js_python_parity(self):
        """Os consumidores JS e Python tomam a mesma decisão nos mesmos contextos."""
        context = dict(eleicaoId='6259', turno='1', cargoId='6', uf='SC', municipio='',
                       zona='', categoria='nominal', classificacao='Válido', andamento='f',
                       totalizacaoFinal='s', atualizado='24/10/2026 11:25:57', total=4876)
        pairs = [(context, context), (context, {**context, 'total': 4877})]
        pairs += [(context, {**context, key: value}) for key, value in
                  [('atualizado', None), ('classificacao', 'Anulado'), ('total', None), ('municipio', '81051')]]
        result = subprocess.check_output(['node', '-e',
            "const fs=require('fs'),{compare}=require('./js/source-compare.js');process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(([a,b])=>compare(a,b))));"],
            input=json.dumps(pairs).encode(), cwd=ROOT)
        self.assertEqual(json.loads(result), [compare(a, b) for a, b in pairs])

    def test_workflow_promotion_contract(self):
        """O workflow valida navegador e gate antes de disponibilizar promoção."""
        workflow = (ROOT / '.github/workflows/tse-sync.yml').read_text()
        self.assertIn('contents: read', workflow)
        self.assertNotIn('contents: write', workflow)
        self.assertNotIn('git push', workflow)
        self.assertNotIn('git commit', workflow)
        self.assertIn('sync/tse_sync.py --review-only', workflow)
        self.assertLess(workflow.index('node test/ui_browser.js'), workflow.index('sync/source_compare.py --approval'))
        self.assertLess(workflow.index('node test/labels_browser.js'), workflow.index('sync/source_compare.py --approval'))
        self.assertLess(workflow.index('sync/source_compare.py --approval'), workflow.index('name: tse-elegivel-'))
        self.assertIn('if: always()', workflow)

    def test_injected_divergence_generator_and_cli(self):
        """Reproduz o experimento da auditoria e comprova bloqueio por saída/estado."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            out, ea = tmp / 'snapshot', tmp / 'ea20'
            shutil.copytree(ROOT / 'data/tse_2026', out)
            shutil.copytree(ROOT / 'data/ea20', ea)
            manifest = json.loads((ea / 'index.json').read_text())
            entry = next(e for e in manifest['resultados'] if e['cargo'] == 'DEPUTADO FEDERAL')
            raw = json.loads((ea / entry['arquivo']).read_text())
            candidate = next(c for a in raw['carg'][0]['agr'] for p in a['par'] for c in p['cand'] if c['n'] == '1333')
            candidate['vap'] = str(int(candidate['vap']) + 1)
            source = ea / entry['arquivo']
            source.write_text(json.dumps(raw))
            entry['sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
            (ea / 'index.json').write_text(json.dumps(manifest))
            command = [sys.executable, str(ROOT / 'sync/snapshot_format.py'), '--out', str(out), '--ea20', str(ea)]
            result = subprocess.run(command, cwd=tmp, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            report_path = tmp / 'reports/eleitoral_comparacao.json'
            report = json.loads(report_path.read_bytes())
            row = next(r for r in report['comparacoes'] if r['cargo'] == entry['cargo'] and r['numero'] == '1333')
            self.assertEqual((row['snapshot'], row['ea20'], row['diferenca'], row['estado']),
                             (4876, 4877, -1, 'revisao_obrigatoria'))
            gate = [sys.executable, str(ROOT / 'sync/source_compare.py'), '--report', str(report_path),
                    '--snapshot', str(out), '--ea20', str(ea)]
            self.assertEqual(subprocess.run(gate, cwd=tmp, capture_output=True).returncode, 2)
            self.assertEqual(subprocess.run(command + ['--review-only'], cwd=tmp, capture_output=True).returncode, 0)
            context = row['contexto_ea20']
            proof = {'DEPUTADO FEDERAL': {'1333': dict(snapshot_sha256=row['snapshot_sha256'],
                     ea20_sha256=entry['sha256'], revisor='Teste sintético — não usar em produção',
                     revisado_em='2026-11-16', evidencias=['https://example.invalid/teste'],
                     contexto_snapshot={k: context[k] for k in ('classificacao', 'andamento', 'totalizacaoFinal', 'atualizado')})}}
            evidence = tmp / 'evidence.json'
            evidence.write_text(json.dumps(proof))
            result = subprocess.run(command + ['--evidence', str(evidence)], cwd=tmp, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            report = json.loads(report_path.read_bytes())
            row = next(r for r in report['comparacoes'] if r['cargo'] == entry['cargo'] and r['numero'] == '1333')
            self.assertEqual(row['estado'], 'divergencia_bloqueante')
            self.assertTrue(row['comparavel'])
            self.assertEqual(subprocess.run(gate, cwd=tmp, capture_output=True).returncode, 2)
            verify_bundle(report, out, ea)
            individual = out / 'candidatos/dep_federal/1333.json'
            individual.write_bytes(individual.read_bytes() + b' ')
            with self.assertRaises(ValueError):
                verify_bundle(report, out, ea)
            # Mudança de versão invalida também o parecer de equivalência.
            proof['DEPUTADO FEDERAL']['1333']['ea20_sha256'] = '0' * 64
            evidence.write_text(json.dumps(proof))
            self.assertNotEqual(subprocess.run(command + ['--evidence', str(evidence)], cwd=tmp, capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
