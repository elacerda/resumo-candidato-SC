#!/usr/bin/env python3
"""Mede corpos JSON em bytes; compara também partições hipotéticas de 16 grupos."""
import json
from pathlib import Path
import subprocess
from ea20_sync import dump


def measure():
    """Escreve medições de payload; não estima tráfego comprimido do GitHub Pages.

    A primeira consulta inclui índice e tabela de seções. Dados geográficos,
    HTML, JavaScript e cabeçalhos HTTP não entram, pois são compartilhados.
    A alternativa de shards é serializada em memória e explicitamente rotulada.
    """
    base = Path('data/tse_2026')
    idx = json.loads((base / 'index.json').read_text())
    old_index = subprocess.check_output(['git', 'show', 'HEAD:data/tse_2026/index.json'])
    old_index_size = len(old_index)
    shared = (base / 'secoes.json').stat().st_size
    rows = []
    for cargo, c in idx['cargos'].items():
        legacy_bytes = (base / c['arquivo']).read_bytes()
        legacy = json.loads(legacy_bytes)['cand']
        nums = sorted(c['candidatos'], key=lambda n: (-c['candidatos'][n][1], n))
        samples = list(dict.fromkeys([nums[0], nums[-1]] + (['1333'] if '1333' in nums else [])))
        groups = {i: {} for i in range(16)}
        for n in nums:
            groups[int(n) % 16][n] = legacy[n]
        for n in samples:
            individual = (base / c['diretorio'] / (n + '.json')).stat().st_size
            shard = len(json.dumps({'cand': groups[int(n) % 16]}, separators=(',', ':')).encode())
            rows.append({'cargo': cargo, 'numero': n, 'votos': c['candidatos'][n][1],
                         'arquivo_cargo_bytes': len(legacy_bytes), 'arquivo_individual_bytes': individual,
                         'primeira_consulta_antes_bytes': old_index_size + shared + len(legacy_bytes),
                         'primeira_consulta_depois_bytes': (base / 'index.json').stat().st_size + shared + individual + (base / 'municipios.json').stat().st_size,
                         'catalogo_municipios_inicial_bytes': (base / 'municipios.json').stat().st_size,
                         'shard_16_serializado_bytes': shard})
    dump(Path('reports/desempenho_eleitoral.json'), {
        'metodo': 'Tamanho exato de corpos JSON UTF-8 em disco; não é medição de tráfego HTTP comprimido. Shards: alternativa serializada, não publicada.',
        'arquivos_individuais': sum(len(c['candidatos']) for c in idx['cargos'].values()),
        'tabela_compartilhada_bytes': shared, 'indice_anterior_bytes': old_index_size,
        'indice_atual_bytes': (base / 'index.json').stat().st_size, 'consultas': rows})


if __name__ == '__main__':
    measure()
