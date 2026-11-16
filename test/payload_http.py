#!/usr/bin/env python3
"""Mede corpos eleitorais por HTTP estático local sem compressão ou cache."""
import functools
import http.server
import json
from pathlib import Path
import subprocess
import threading
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serve o projeto e o índice legado somente para comparação de payloads."""

    def do_GET(self):
        """Responde GET; o índice anterior vem do HEAD sem alterar o checkout."""
        if self.path == '/indice-anterior.json':
            body = subprocess.check_output(['git', 'show', 'HEAD:data/tse_2026/index.json'], cwd=ROOT)
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def log_message(self, format, *args):
        """Suprime logs de acesso rotineiros da medição local."""


def main():
    """Transfere cada corpo por HTTP e confere o tamanho previamente medido em disco."""
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    url = 'http://127.0.0.1:' + str(server.server_port) + '/'
    measured = {}
    try:
        report = json.loads((ROOT / 'reports/desempenho_eleitoral.json').read_text())
        idx = json.loads((ROOT / 'data/tse_2026/index.json').read_text())
        files = {'indice-anterior.json', 'data/tse_2026/index.json', 'data/tse_2026/secoes.json', 'data/tse_2026/municipios.json'}
        for row in report['consultas']:
            c = idx['cargos'][row['cargo']]
            files.add('data/tse_2026/' + c['arquivo'])
            files.add('data/tse_2026/' + c['diretorio'] + '/' + row['numero'] + '.json')
        for name in sorted(files):
            with urllib.request.urlopen(url + name) as r:
                measured[name] = len(r.read())
        for row in report['consultas']:
            c = idx['cargos'][row['cargo']]
            before = sum(measured[n] for n in ['indice-anterior.json', 'data/tse_2026/secoes.json', 'data/tse_2026/' + c['arquivo']])
            after = sum(measured[n] for n in ['data/tse_2026/index.json', 'data/tse_2026/secoes.json', 'data/tse_2026/municipios.json', 'data/tse_2026/' + c['diretorio'] + '/' + row['numero'] + '.json'])
            if (before, after) != (row['primeira_consulta_antes_bytes'], row['primeira_consulta_depois_bytes']):
                raise ValueError('Medição HTTP difere dos arquivos')
        target = ROOT / 'reports/desempenho_http.json'
        target.write_text(json.dumps({'metodo': 'Corpos realmente transferidos via HTTP local sem compressão; exclui cabeçalhos, geografia e recursos comuns. Não mede GitHub Pages.', 'corpos_bytes': measured}, ensure_ascii=False, indent=2) + '\n')
        print('HTTP PAYLOAD OK:', len(measured), 'corpos transferidos e conferidos')
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


if __name__ == '__main__':
    main()
