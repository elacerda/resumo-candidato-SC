#!/usr/bin/env python3
"""Captura EA11/EA20 oficiais com validação de identidade e cache condicional.

Publica bytes oficiais e manifesto determinístico; data de obtenção fica no
cache operacional (não provoca alterações artificiais no repositório).
"""
import argparse
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
import urllib.request
import urllib.error

BASE = 'https://resultados.tse.jus.br/oficial/'
CONFIG = BASE + 'comum/config/ele-c.json'
NAMES = {'Presidente': 'presidente', 'Governador': 'governador',
         'Senador': 'senador', 'Deputado Federal': 'dep_federal',
         'Deputado Estadual': 'dep_estadual'}


def dump(path, value):
    """Escreve JSON UTF-8 compacto e determinístico.

    Parameters
    ----------
    path : pathlib.Path
        Arquivo de destino; diretórios pais são criados quando necessário.
    value : object
        Valor serializável em JSON, sem timestamps artificiais.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def download(url, cache):
    """Obtém bytes oficiais com ETag/Last-Modified e conserva auditoria no cache.

    Parameters
    ----------
    url : str
        URL HTTPS oficial.
    cache : pathlib.Path
        Diretório operacional, fora dos artefatos publicados.

    Returns
    -------
    bytes
        Conteúdo recebido ou validado por HTTP 304.

    Raises
    ------
    urllib.error.URLError
        Falha de rede; não reutiliza silenciosamente uma resposta desatualizada.
    """
    cache.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()
    body, info = cache / key, cache / (key + '.json')
    meta = json.loads(info.read_text()) if info.exists() and body.exists() else {}
    headers = {}
    if meta.get('etag'):
        headers['If-None-Match'] = meta['etag']
    elif meta.get('last_modified'):
        headers['If-Modified-Since'] = meta['last_modified']
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as r:
            data = r.read()
            body.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            obtained = meta.get('obtido_em') if digest == meta.get('sha256') else None
            dump(info, {'url': url, 'etag': r.headers.get('ETag'),
                        'last_modified': r.headers.get('Last-Modified'),
                        'obtido_em': obtained or datetime.now(timezone.utc).isoformat(),
                        'sha256': hashlib.sha256(data).hexdigest()})
            return data
    except urllib.error.HTTPError as e:
        if e.code == 304 and body.exists():
            data = body.read_bytes()
            if hashlib.sha256(data).hexdigest() != meta['sha256']:
                raise ValueError('Cache corrompido') from e
            return data
        raise


def capture(out, cache, fixtures=None):
    """Valida todas as respostas antes de escrever o manifesto de publicação.

    Parameters
    ----------
    out, cache : pathlib.Path
        Destino publicado e cache operacional.
    fixtures : pathlib.Path, optional
        Capturas oficiais locais para reprodução sem rede.

    Raises
    ------
    ValueError
        Identidade, cadastro ou cobertura de cargos degradados.
    urllib.error.URLError
        Fonte oficial indisponível; arquivos publicados não são considerados atuais.
    """
    config_bytes = (fixtures / 'ele-c.json').read_bytes() if fixtures else download(CONFIG, cache)
    config = json.loads(config_bytes)
    capture_meta = json.loads((fixtures / 'proveniencia.json').read_text()) if fixtures else None
    entries, pending = [], {'ele-c.json': config_bytes}
    for p in config['pl']:
        if p['c'] != 'ele2026':
            continue
        for e in p['e']:
            for abr in e['abr']:
                for c in abr['cp']:
                    if c['ds'] not in NAMES or abr['cd'] not in ('br', 'sc'):
                        continue
                    slug = NAMES[c['ds']]
                    # Turnos e abrangências vêm do EA11, inclusive a ausência de SC.
                    for ele, turno in [(e['cd'], e['t'])]:
                        url = BASE + f"{p['c']}/{ele}/dados/sc/sc-c{int(c['cd']):04d}-e{int(ele):06d}-u.json"
                        data = (fixtures / (slug + ('-2' if turno == '2' else '') + '.json')).read_bytes() if fixtures else download(url, cache)
                        raw = json.loads(data)
                        if (raw['ele'], raw['t'], raw['f'], raw['tpabr'], raw['cdabr']) != (ele, turno, 'o', 'uf', 'sc'):
                            raise ValueError('Identidade EA20 incompatível: ' + url)
                        cargo = next(x for x in raw['carg'] if x['cd'] == c['cd'])
                        if not cargo['agr'] or not raw['dt'] or not raw['ht'] or raw['and'] not in ('p', 'f'):
                            raise ValueError('EA20 incompleto: ' + url)
                        candidates = [x for a in cargo['agr'] for p0 in a['par'] for x in p0['cand']]
                        if not candidates or len({x['n'] for x in candidates}) != len(candidates) or any(not str(x['vap']).isdigit() for x in candidates):
                            raise ValueError('Cadastro nominal inválido: ' + url)
                        if fixtures:
                            obtained = capture_meta[slug + ('-2' if turno == '2' else '')]['obtido_em']
                        else:
                            obtained = json.loads((cache / (hashlib.sha256(url.encode()).hexdigest() + '.json')).read_text())['obtido_em']
                        filename = f'{slug}-{turno}.json'
                        pending[filename] = data
                        entries.append({'cargo': c['ds'].upper(), 'cargoId': c['cd'], 'ele': ele,
                                        't': turno, 'arquivo': filename, 'url': url,
                                        'obtido_em': obtained, 'atualizado': raw['dt'] + ' ' + raw['ht'],
                                        'sha256': hashlib.sha256(data).hexdigest()})
    if len({e['cargo'] for e in entries if e['t'] == '1'}) != 5:
        raise ValueError('Configuração de primeiro turno incompleta')
    previous_path = out / 'index.json'
    if previous_path.exists():
        previous = json.loads(previous_path.read_text())
        before = {(e['cargo'], e['t']) for e in previous['resultados']}
        after = {(e['cargo'], e['t']) for e in entries}
        if before - after:
            raise ValueError('Fonte degradada: cargo/turno anteriormente publicado ausente')
    for name, data in pending.items():
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(data)
    dump(out / 'index.json', {'schema': 1, 'uf': 'SC', 'config': {'url': CONFIG,
         'sha256': hashlib.sha256(config_bytes).hexdigest()}, 'resultados': entries})


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', type=Path, default=Path('data/ea20'))
    ap.add_argument('--cache', type=Path, default=Path('cache/http'))
    ap.add_argument('--fixtures', type=Path)
    args = ap.parse_args()
    capture(args.out, args.cache, args.fixtures)
