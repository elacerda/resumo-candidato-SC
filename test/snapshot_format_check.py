#!/usr/bin/env python3
"""Valida idempotência, metadados das capturas e cache condicional sem rede."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sync'))
from ea20_sync import download


def hashes(directory):
    """Retorna caminho relativo e SHA-256 de cada JSON gerado."""
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob('*.json')}


class SnapshotChecks(unittest.TestCase):
    """Protege determinismo e reutilização somente após HTTP 304."""

    def test_determinism(self):
        """Entradas idênticas produzem os mesmos bytes duas vezes."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            out, ea = tmp / 'snapshot', tmp / 'ea20'
            shutil.copytree(ROOT / 'data/tse_2026', out)
            subprocess.run([sys.executable, str(ROOT / 'sync/ea20_sync.py'), '--out', str(ea),
                            '--fixtures', str(ROOT / 'test/fixtures/ea20')], cwd=tmp, check=True)
            command = [sys.executable, str(ROOT / 'sync/snapshot_format.py'), '--out', str(out), '--ea20', str(ROOT / 'data/ea20'), '--review-only']
            subprocess.run(command, cwd=tmp, check=True)
            first = hashes(tmp)
            subprocess.run(command, cwd=tmp, check=True)
            self.assertEqual(first, hashes(tmp))
            self.assertEqual(hashes(out), hashes(ROOT / 'data/tse_2026'))

    def test_fixture_origin(self):
        """Capturas correspondem ao hash e domínio oficial declarados."""
        base = ROOT / 'test/fixtures/ea20'
        for name, entry in json.loads((base / 'proveniencia.json').read_text()).items():
            self.assertTrue(entry['url'].startswith('https://resultados.tse.jus.br/oficial/'))
            self.assertEqual(hashlib.sha256((base / (name + '.json')).read_bytes()).hexdigest(), entry['sha256'])
            self.assertTrue(entry['obtido_em'])

    def test_http_cache(self):
        """304 requer arquivo íntegro; 403 não reutiliza cache antigo."""
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            url = 'https://resultados.tse.jus.br/oficial/teste'
            key = hashlib.sha256(url.encode()).hexdigest()
            body = b'{"oficial":true}'
            (cache / key).write_bytes(body)
            (cache / (key + '.json')).write_text(json.dumps({'etag': '"v1"', 'sha256': hashlib.sha256(body).hexdigest()}))
            error = urllib.error.HTTPError(url, 304, 'Not Modified', {}, None)
            with patch('urllib.request.urlopen', side_effect=error) as mocked:
                self.assertEqual(download(url, cache), body)
                self.assertEqual(mocked.call_args.args[0].get_header('If-none-match'), '"v1"')
            (cache / key).write_bytes(b'corrompido')
            with patch('urllib.request.urlopen', side_effect=error):
                with self.assertRaises(ValueError):
                    download(url, cache)
            with patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError(url, 403, 'Forbidden', {}, None)):
                with self.assertRaises(urllib.error.HTTPError):
                    download(url, cache)


if __name__ == '__main__':
    unittest.main()
