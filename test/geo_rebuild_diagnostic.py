#!/usr/bin/env python3
"""Diagnóstico sem escrita geográfica: compara bytes e semântica do rebuild R02."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def diagnose(rebuilt):
    """Compara catálogo publicado e reconstruído preservando os arquivos de origem.

    Parameters
    ----------
    rebuilt : pathlib.Path
        Diretório gerado pelo pipeline com o cache original do Tufão.

    Returns
    -------
    dict
        Hashes, campos diferentes e contagem de reordenações de seções. Coordenadas
        são pares [longitude, latitude] WGS84 em graus; associações usam município
        TSE, zona e seção. Qualquer diferença semântica gera AssertionError.
    """
    published = ROOT / 'data/geo_loc'
    names = ('index.json', 'locais.json', 'secoes.json', 'pendentes.json')
    old = {n: json.loads((published / n).read_bytes()) for n in names}
    new = {n: json.loads((rebuilt / n).read_bytes()) for n in names}
    report = {'host': 'tufao', 'arquivos': {n: {
        'publicado_sha256': hashlib.sha256((published / n).read_bytes()).hexdigest(),
        'rebuild_sha256': hashlib.sha256((rebuilt / n).read_bytes()).hexdigest()} for n in names}}
    assert old['secoes.json'] == new['secoes.json'], 'Associações seção→local diferentes'
    a, b = copy.deepcopy(old['locais.json']), copy.deepcopy(new['locais.json'])
    reordered = sum(x[7] != y[7] for x, y in zip(a['locais'], b['locais']))
    for rows in (a['locais'], b['locais']):
        for row in rows:
            row[7].sort()
    assert a == b, 'Diferença em locais além da ordem das seções (inclui coordenadas/status/fontes)'
    a, b = copy.deepcopy(old['pendentes.json']), copy.deepcopy(new['pendentes.json'])
    pending_reordered = sum(x['secoes'] != y['secoes'] for x, y in zip(a['registros'], b['registros']))
    for data in (a, b):
        for row in data['registros']:
            row['secoes'].sort()
    assert a == b, 'Diferença em pendentes além da ordem das seções'
    a, b = copy.deepcopy(old['index.json']), copy.deepcopy(new['index.json'])
    report['geracao_snapshot'] = {label: x['fontes']['tse_2026']['dt_geracao_tse']
                                for label, x in [('publicado', a), ('rebuild', b)]}
    for data in (a, b):
        data.pop('gerado_em')
        data['fontes']['tse_2026'].pop('dt_geracao_tse')
    assert a == b, 'Metadados/fontes diferentes além da geração do snapshot'
    # A origem da ordem é rastreada até a tabela compartilhada atual.
    table = json.loads((ROOT / 'data/tse_2026/secoes.json').read_bytes())
    grouped = {}
    sec2loc = {tuple(r[:3]): r[3] for r in new['secoes.json']['secao2local']}
    for mi, zone, section, *_ in table['secoes']:
        key = (table['mun'][mi][0], int(zone), int(section))
        grouped.setdefault(sec2loc[key], []).append([int(zone), int(section)])
    for row in new['locais.json']['locais']:
        if row[8] is not None:
            assert row[7] == grouped.get(row[0], []), 'Ordem reconstruída não veio da tabela compartilhada'
    report.update(locais_com_secoes_reordenadas=reordered,
                  pendentes_com_secoes_reordenadas=pending_reordered,
                  coordenadas_alteradas=0, associacoes_alteradas=0,
                  demais_atributos_alterados=0,
                  causa='Catálogo publicado usa geração anterior do snapshot e ordem anterior das seções; build_catalog preserva a ordem de snap_rows e publish a serializa. _gerado_em incorpora a geração do snapshot.')
    return report


def main():
    """Reutiliza rebuild existente ou gera um temporário; escreve somente diagnóstico."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rebuild-dir', type=Path)
    parser.add_argument('--report', type=Path, default=Path('/tmp/geo-rebuild-diagnostic.json'))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        rebuilt = args.rebuild_dir or Path(tmp)
        if not args.rebuild_dir:
            subprocess.run([sys.executable, str(ROOT / 'sync/geo_ref.py'), '--out', str(rebuilt),
                            '--report', str(rebuilt / 'report.json')], cwd=ROOT, check=True,
                           stdout=subprocess.DEVNULL)
        report = diagnose(rebuilt)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
