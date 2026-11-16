#!/usr/bin/env python3
"""Teste opcional de rede real, separado da suíte reproduzível.

Valida resposta, CORS e requisição condicional na origem oficial. Não escreve
artefatos publicados nem presume que cabeçalhos de rate limit sejam contrato.
"""
import json
import sys
from pathlib import Path
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sync'))


def main():
    """Consulta uma URL já verificada e registra cabeçalhos e identidade eleitoral."""
    manifest = json.loads((ROOT / 'data/ea20/index.json').read_text())
    e = next(e for e in manifest['resultados'] if e['cargo'] == 'DEPUTADO FEDERAL' and e['t'] == '1')
    headers = {'Origin': 'https://elacerda.github.io'}
    with urllib.request.urlopen(urllib.request.Request(e['url'], headers=headers), timeout=60) as r:
        raw = json.load(r)
        if (raw['ele'], raw['t'], raw['cdabr']) != (e['ele'], e['t'], 'sc'):
            raise ValueError('Identidade inesperada')
        cors = r.headers.get('Access-Control-Allow-Origin')
        if cors not in ('*', headers['Origin']):
            raise ValueError('CORS não confirmado; os espelhos estaduais continuam disponíveis')
        print('HTTP', r.status, 'CORS', cors, 'ETag', r.headers.get('ETag'), 'Last-Modified', r.headers.get('Last-Modified'))
        if r.headers.get('ETag'):
            headers['If-None-Match'] = r.headers['ETag']
        elif r.headers.get('Last-Modified'):
            headers['If-Modified-Since'] = r.headers['Last-Modified']
        else:
            print('Sem validador condicional; não presumir suporte nesta resposta')
            return
    try:
        with urllib.request.urlopen(urllib.request.Request(e['url'], headers=headers), timeout=60) as r:
            print('HTTP condicional', r.status, '(fonte pode ter mudado)')
    except urllib.error.HTTPError as exc:
        if exc.code != 304:
            raise
        print('HTTP condicional 304 confirmado')


if __name__ == '__main__':
    main()
