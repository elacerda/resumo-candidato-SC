"""Decisão de promoção eleitoral, independente da geração de arquivos candidatos."""
import argparse
import hashlib
import json
from pathlib import Path

KEYS = ('eleicaoId', 'turno', 'cargoId', 'uf', 'municipio', 'zona',
        'categoria', 'classificacao', 'andamento', 'totalizacaoFinal', 'atualizado')


def compare(a, b):
    """Compara contagens nominais apenas sob contexto eleitoral equivalente.

    Parameters
    ----------
    a, b : dict
        Contextos documentados nas chaves ``KEYS`` e ``total`` inteiro de votos.
        Município/zona vazios significam abrangência estadual; None é desconhecido.

    Returns
    -------
    dict
        Estado, comparabilidade, diferença e autorização automática de promoção.

    Raises
    ------
    ValueError
        Total presente que não seja inteiro não negativo.
    """
    for source in (a, b):
        if source.get('total') is not None and (type(source['total']) is not int or not 0 <= source['total'] <= 9007199254740991):
            raise ValueError('Total inválido na comparação')
    missing = [k for k in KEYS if a.get(k) is None or b.get(k) is None]
    different = [k for k in KEYS if a.get(k) != b.get(k)]
    delta = a['total'] - b['total'] if a.get('total') is not None and b.get('total') is not None else None
    comparable = not missing and not different and delta is not None
    state = ('coincidente' if delta == 0 else 'divergencia_bloqueante') if comparable else 'revisao_obrigatoria'
    return {'comparavel': comparable, 'diferenca': delta, 'estado': state,
            'publicar': state == 'coincidente',
            'motivo': {'ausentes': missing, 'diferentes': different}}


def promotion_allowed(report_bytes, approval=None):
    """Autoriza relatório íntegro ou revisão humana vinculada aos seus bytes.

    Parameters
    ----------
    report_bytes : bytes
        Relatório completo de comparação gerado, usado no vínculo SHA-256.
    approval : dict, optional
        Parecer com relatorio_sha256, revisor, revisado_em, justificativa e
        decisao='aprovar_fontes_independentes'. Não supera divergência comparável.

    Returns
    -------
    bool
        True apenas para conjunto sem bloqueio ou revisão explícita válida.

    Raises
    ------
    ValueError, KeyError
        Relatório inválido, incompleto ou com contagens incompatíveis.
    """
    report = json.loads(report_bytes)
    rows = report.get('comparacoes', [])
    if not rows or any(r.get('estado') not in ('coincidente', 'revisao_obrigatoria') for r in rows):
        return False
    for row in rows:
        decision = compare(row['contexto_snapshot'], row['contexto_ea20'])
        if (any(row.get(k) != v for k, v in decision.items())
                or row.get('snapshot') != row['contexto_snapshot'].get('total')
                or row.get('ea20') != row['contexto_ea20'].get('total')):
            return False
    if all(r.get('estado') == 'coincidente' and r.get('comparavel') and r.get('diferenca') == 0 and r.get('publicar') for r in rows):
        return True
    approval = approval or {}
    return (approval.get('relatorio_sha256') == hashlib.sha256(report_bytes).hexdigest()
            and approval.get('decisao') == 'aprovar_fontes_independentes'
            and all(isinstance(approval.get(k), str) and approval[k].strip()
                    for k in ('revisor', 'revisado_em', 'justificativa')))


def verify_bundle(report, snapshot, ea20):
    """Confere o vínculo entre relatório e todos os arquivos a promover.

    Parameters
    ----------
    report : dict
        Relatório schema 2 produzido pelo gerador.
    snapshot, ea20 : pathlib.Path
        Diretórios de seções e de capturas agregadas, respectivamente.

    Raises
    ------
    ValueError
        Arquivo do conjunto mudou desde a comparação.
    OSError
        Arquivo do conjunto ausente ou ilegível.
    """
    def verify(path, expected):
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Conjunto diferente do relatório: ' + str(path))

    verify(snapshot / 'index.json', report['indice_sha256'])
    verify(ea20 / 'index.json', report['manifesto_ea20_sha256'])
    index = json.loads((snapshot / 'index.json').read_text())
    verify(snapshot / index['secoes'], report['secoes_sha256'])
    for cargo in index['cargos'].values():
        verify(snapshot / cargo['arquivo'], cargo['proveniencia']['arquivo_legado_sha256'])
        for number, digest in cargo['arquivos_sha256'].items():
            verify(snapshot / cargo['diretorio'] / (number + '.json'), digest)
    for entry in json.loads((ea20 / 'index.json').read_text())['resultados']:
        verify(ea20 / entry['arquivo'], entry['sha256'])


def main():
    """Verifica promoção; retorna código 2 se faltar revisão ou houver divergência."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=Path('reports/eleitoral_comparacao.json'))
    parser.add_argument('--approval', type=Path)
    parser.add_argument('--snapshot', type=Path, default=Path('data/tse_2026'))
    parser.add_argument('--ea20', type=Path, default=Path('data/ea20'))
    args = parser.parse_args()
    verify_bundle(json.loads(args.report.read_bytes()), args.snapshot, args.ea20)
    approval = json.loads(args.approval.read_text()) if args.approval and args.approval.exists() else None
    allowed = promotion_allowed(args.report.read_bytes(), approval)
    print('Promoção autorizada' if allowed else 'Promoção bloqueada: divergência comprovada ou revisão obrigatória pendente')
    return 0 if allowed else 2


if __name__ == '__main__':
    raise SystemExit(main())
