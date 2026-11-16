#!/usr/bin/env python3
"""Migração determinística para arquivos individuais, sem alterar votos ou seções."""
import argparse
import hashlib
import json
from pathlib import Path
from ea20_sync import dump
from source_compare import compare, promotion_allowed


def optimize(out, ea20, review_only=False, evidence=None):
    """Separa candidatos e partidos pelo cadastro oficial e verifica todas as somas.

    Parameters
    ----------
    out : pathlib.Path
        Snapshot legado completo. Mantém arquivos de cargo para diagnóstico offline.
    ea20 : pathlib.Path
        Capturas oficiais validadas por ``ea20_sync.py``.

    review_only : bool, optional
        Gera arquivos e relatório para revisão sem autorizar promoção automática.
    evidence : dict, optional
        Pareceres por cargo/número com contexto do snapshot e evidências de
        equivalência, vinculados aos hashes das duas fontes. Nenhum contexto
        ausente no CSV é inferido a partir de coincidência de votos.

    Raises
    ------
    ValueError
        Referências repetidas ou somas inconsistentes. Identidades históricas
        sem correspondência atual são preservadas e sinalizadas explicitamente.
        Sem review_only, decisão pendente/bloqueante também causa falha após
        escrita do relatório em reports/eleitoral_comparacao.json.
    """
    idx = json.loads((out / 'index.json').read_text())
    table = json.loads((out / idx['secoes']).read_text())
    manifest = json.loads((ea20 / 'index.json').read_text())
    report = []
    zones = {}
    for row in table['secoes']:
        zones.setdefault(row[0], set()).add(row[1])
    dump(out / 'municipios.json', {'schema': 1, 'uf': 'SC', 'municipios':
         [[code, name, sorted(zones.get(i, []), key=int)] for i, (code, name) in enumerate(table['mun'])]})
    for cargo, c in idx['cargos'].items():
        entry = next(e for e in manifest['resultados'] if e['cargo'] == cargo and e['t'] == '1')
        source_bytes = (ea20 / entry['arquivo']).read_bytes()
        if hashlib.sha256(source_bytes).hexdigest() != entry['sha256']:
            raise ValueError('Hash EA20 incompatível')
        raw = json.loads(source_bytes)
        official = next(x for x in raw['carg'] if x['cd'] == entry['cargoId'])
        if c.get('eleicao_id') and c['eleicao_id'] != entry['ele']:
            raise ValueError('Eleição CSV diferente do EA20')
        parties = {p['n']: p for a in official['agr'] for p in a['par']}
        nominal = {x['n']: x for p in parties.values() for x in p['cand']}
        legacy_bytes = (out / c['arquivo']).read_bytes()
        legacy = json.loads(legacy_bytes)
        if set(c['candidatos']) | set(c.get('partidos', {})) != set(legacy['cand']):
            raise ValueError('Índice e arquivo legado possuem votáveis diferentes')
        c['diretorio'] = 'candidatos/' + Path(c['arquivo']).stem
        original = {**c.get('partidos', {}), **c['candidatos']}
        c['partidos'] = {}
        c['sem_cadastro_ea20'] = []
        c['arquivos_sha256'] = {}
        c['classificacoes_ea20'] = {n: x['dvt'] for n, x in nominal.items()}
        for num, rows in legacy['cand'].items():
            meta = original.get(num)
            if meta is None:
                raise ValueError('Votável sem metadados no índice: ' + num)
            seen, muns, total = set(), set(), 0
            for s, v in rows:
                if not isinstance(s, int) or s < 0 or s >= len(table['secoes']) or s in seen or not isinstance(v, int) or v <= 0:
                    raise ValueError('Seção/voto inválido: ' + num)
                seen.add(s)
                muns.add(table['secoes'][s][0])
                total += v
            if [total, len(rows), len(muns)] != meta[1:]:
                raise ValueError('Somas inválidas: ' + num)
            identity = c.get('identidades', {}).get(num)
            if identity and num in nominal and identity['id'] != nominal[num]['sqcand']:
                raise ValueError('SQ_CANDIDATO diferente entre fontes: ' + num)
            is_party = identity['categoria'] == 'legenda' if identity else num not in nominal and num in parties
            if is_party:
                if num not in parties:
                    raise ValueError('Legenda não identificada no cadastro oficial: ' + num)
                if num in parties:
                    c['partidos'][num] = meta
                    c['candidatos'].pop(num, None)
                    continue
            if num not in nominal:
                c['sem_cadastro_ea20'].append(num)
            dump(out / c['diretorio'] / (num + '.json'), {
                'schema': 2, 'eleicao': idx['eleicao'], 'turno': '1', 'uf': idx['uf'],
                'cargo': cargo, 'numero': num, 'votos': rows,
                'eleicao_id': c.get('eleicao_id'), 'identidade': identity})
            c['arquivos_sha256'][num] = hashlib.sha256((out / c['diretorio'] / (num + '.json')).read_bytes()).hexdigest()
            context = {'eleicaoId': c.get('eleicao_id'), 'turno': '1',
                       'cargoId': entry['cargoId'], 'uf': idx['uf'], 'municipio': '',
                       'zona': '', 'categoria': 'nominal', 'total': total}
            other = {'eleicaoId': raw['ele'], 'turno': raw['t'], 'cargoId': official['cd'],
                     'uf': raw['cdabr'].upper() if raw['tpabr'] == 'uf' else None,
                     'municipio': '', 'zona': '', 'categoria': 'nominal',
                     'classificacao': nominal[num]['dvt'] if num in nominal else None,
                     'andamento': raw['and'], 'totalizacaoFinal': raw['tf'],
                     'atualizado': raw['dt'] + ' ' + raw['ht'],
                     'total': int(nominal[num]['vap']) if num in nominal else None}
            proof = (evidence or {}).get(cargo, {}).get(num)
            if proof:
                if (proof.get('snapshot_sha256') != hashlib.sha256(legacy_bytes).hexdigest()
                        or proof.get('ea20_sha256') != entry['sha256']
                        or not all(proof.get(k) for k in ('revisor', 'revisado_em', 'evidencias'))):
                    raise ValueError('Evidência de equivalência inválida ou defasada: ' + num)
                # Apenas eixos que o CSV não fornece podem vir do parecer auditável.
                for key in ('classificacao', 'andamento', 'totalizacaoFinal', 'atualizado'):
                    if key in proof.get('contexto_snapshot', {}):
                        context[key] = proof['contexto_snapshot'][key]
            decision = compare(context, other)
            report.append({'cargo': cargo, 'numero': num, 'snapshot': total,
                           'ea20': other['total'], **decision,
                           'contexto_snapshot': context, 'contexto_ea20': other,
                           'evidencia_equivalencia': proof,
                           'snapshot_sha256': hashlib.sha256(legacy_bytes).hexdigest(),
                           'ea20_sha256': entry['sha256']})
        c['proveniencia'] = {'arquivo_legado_sha256': hashlib.sha256(legacy_bytes).hexdigest(),
                             'cadastro_ea20_sha256': entry['sha256']}
    idx.update(schema=2, turno='1', categoria='nominal',
               rastreabilidade='Origem e geração preservadas; CD_ELEICAO/SQ_CANDIDATO verificados quando disponíveis; estado de totalização não presumido',
               secoes_sha256=hashlib.sha256((out / idx['secoes']).read_bytes()).hexdigest())
    dump(out / 'index.json', idx)
    report_path = Path('reports/eleitoral_comparacao.json')
    state = ('divergencia_bloqueante' if any(r['estado'] == 'divergencia_bloqueante' for r in report)
             else 'revisao_obrigatoria' if any(not r['publicar'] for r in report) else 'coincidente')
    dump(report_path, {'schema': 2, 'estado': state, 'comparacoes': report,
                       'secoes_sha256': idx['secoes_sha256'],
                       'indice_sha256': hashlib.sha256((out / 'index.json').read_bytes()).hexdigest(),
                       'manifesto_ea20_sha256': hashlib.sha256((ea20 / 'index.json').read_bytes()).hexdigest()})
    if not review_only and not promotion_allowed(report_path.read_bytes()):
        raise ValueError('Promoção bloqueada: ' + state + '; relatório gerado para revisão')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', type=Path, default=Path('data/tse_2026'))
    ap.add_argument('--ea20', type=Path, default=Path('data/ea20'))
    ap.add_argument('--review-only', action='store_true', help='Gerar diagnóstico; não autoriza promoção')
    ap.add_argument('--evidence', type=Path, help='Pareceres auditáveis de equivalência de versões')
    args = ap.parse_args()
    optimize(args.out, args.ea20, args.review_only, json.loads(args.evidence.read_text()) if args.evidence else None)
