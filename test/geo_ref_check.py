"""Verificação de integridade do catálogo publicado (data/geo_loc).

Valida (somente stdlib):
  1. estrutura dos JSON publicados (schema de 16 colunas, tipos,
     status coerente com a presença de coordenada);
  2. seção -> local: sem duplicatas; cada seção do snapshot TSE 2026
     tem exatamente uma linha; índice >= 0 apenas para local verificado;
  3. coordenadas WGS84 plausíveis (bbox SC), sem lat/lon trocado;
  4. cobertura: os 295 municípios do estado presentes no catálogo;
  5. contenção: coordenadas verificadas dentro do polígono do
     município (PIP independente) ou flag 'edge' (<= 500 m);
  6. re-derivação independente contra o arquivo oficial TSE
     (eleitorado por local de votação 2026): para os spot-checks de
     test/geo_ref_locais.json, o catálogo deve reproduzir a coordenada
     oficial exata e o local deve estar dentro do município, a < 30 km
     do centro da cidade (referência Wikipedia);
  7. lacunas sem coordenada oficial no TSE (ex.: prisões): se
     resolvidas, a fonte deve ser OSM OU revisão manual auditável
     (sync/geo_overrides.json, veredito 'corrigir' — coordenada
     publicada == coordenada do manifesto, evidência em obs) e a
     contenção deve valer;
  8. manifesto de revisões manuais: sha256 em fontes do index bate com
     o arquivo versionado; 'corrigir' publicado com coord/fonte/ref do
     manifesto e coord anterior preservada; 'documentar' registrado em
     obs sem alterar coordenada;
  9. determinismo: re-executar sync/geo_ref.py com o mesmo cache
     produz bytes idênticos (offline, quando o cache está completo).

Uso: python3 test/geo_ref_check.py [--out DIR] [--no-rebuild]
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, 'sync'))
import geo_ref  # noqa: E402

ok = True


def check(name, cond, extra=''):
    global ok
    print(('  ✓ ' if cond else '  ✗ ') + name + (('  [' + extra + ']') if (not cond and extra) else ''))
    if not cond:
        ok = False


def dist_km(lon1, lat1, lon2, lat2):
    return geo_ref.haversine_m(lon1, lat1, lon2, lat2) / 1000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REPO, 'data', 'geo_loc'))
    ap.add_argument('--no-rebuild', action='store_true',
                    help='não re-executa o pipeline (assume saída estável)')
    args = ap.parse_args()

    out = args.out
    index = json.load(open(os.path.join(out, 'index.json'), encoding='utf-8'))
    locj = json.load(open(os.path.join(out, 'locais.json'), encoding='utf-8'))
    secj = json.load(open(os.path.join(out, 'secoes.json'), encoding='utf-8'))
    penj = json.load(open(os.path.join(out, 'pendentes.json'), encoding='utf-8'))
    locais = locj['locais']
    ref = json.load(open(os.path.join(REPO, 'test', 'geo_ref_locais.json'),
                         encoding='utf-8'))

    print('== 1) schema ==')
    check('index tem eleicao 2026', index['eleicao'] == '2026')
    check('index cobre 295 municípios', index['cobertura']['municipios'] == 295)
    n_ok = True
    for L in locais:
        if len(L) != 16:
            n_ok = False
            print('   linha com', len(L), 'cols:', L[:4])
            break
        if not (isinstance(L[1], str) and isinstance(L[8], (list, type(None)))):
            n_ok = False
            break
        if L[8] is not None and len(L[8]) != 2:
            n_ok = False
            break
        if (L[12] in ('verificado', 'edge')) != (L[8] is not None):
            n_ok = False
            print('   status/coord incoerente:', L[4], L[12], L[8])
            break
        if L[9] == '' and L[12] in ('verificado', 'edge'):
            n_ok = False
            print('   local verificado sem fonte:', L[4])
            break
    check('locais: 16 colunas + status/fonte coerentes', n_ok)

    print('== 2) seção -> local ==')
    secoes = secj['secao2local']
    keys = [tuple(r[:3]) for r in secoes]
    check('sem duplicata de seção', len(keys) == len(set(keys)),
          f'{len(keys)} vs {len(set(keys))}')
    snap = json.load(open(os.path.join(REPO, 'data', 'tse_2026', 'secoes.json'),
                          encoding='utf-8'))
    snap_keys = {(str(snap['mun'][r[0]][0]), int(r[1]), int(r[2]))
                 for r in snap['secoes']}
    check('todas as seções do snapshot presentes (e só elas)',
          set(keys) == snap_keys,
          f'{len(set(keys) - snap_keys)} faltando / {len(snap_keys - set(keys))} extras')
    bad_ref = [r for r in secoes if r[3] >= len(locais)]
    check('referências de local válidas', not bad_ref)
    loc_by_idx = {L[0]: L for L in locais}
    inconsistent = [r for r in secoes if r[3] >= 0
                    and loc_by_idx[r[3]][12] not in ('verificado', 'edge')]
    check('índice >= 0 apenas para locais verificados', not inconsistent)
    n_multi = sum(1 for L in locais if len(L[7]) > 1)
    max_multi = max((len(L[7]) for L in locais), default=0)
    print(f'   (locais com >1 seção: {n_multi}; máx: {max_multi})')
    check('há locais multi-seção (expectativa: > 1000)', n_multi > 1000, str(n_multi))

    print('== 3) coordenadas ==')
    withc = [L for L in locais if L[8] is not None]
    bbox = geo_ref.SC_BBOX
    in_bbox = all(bbox[0] <= L[8][0] <= bbox[2] and bbox[1] <= L[8][1] <= bbox[3]
                  for L in withc)
    check(f'coords dentro do bbox de SC ({len(withc)} locais)', in_bbox)
    swap = [L for L in withc if abs(L[8][1]) > 40]
    check('sem lat/lon trocado (|lat| <= 40)', not swap)

    print('== 4) cobertura ==')
    muns_cat = {L[1] for L in locais}
    muns_snap = {str(r[0]) for r in snap['mun']}
    check('295 municípios no catálogo', len(muns_cat) == 295, str(len(muns_cat)))
    check('catálogo cobre os municípios do snapshot', muns_snap <= muns_cat,
          str(len(muns_snap - muns_cat)))
    n_ver = sum(1 for L in locais if L[12] in ('verificado', 'edge'))
    n_sec = sum(len(L[7]) for L in locais)
    n_sec_ver = sum(len(L[7]) for L in locais if L[12] in ('verificado', 'edge'))
    print(f'   locais {n_ver}/{len(locais)} verificados; seções {n_sec_ver}/{n_sec} '
          f'({100.0 * n_sec_ver / n_sec:.2f} %)')
    check('cobertura por seção >= 99 %', n_sec_ver / n_sec >= 0.99)
    check('cobertura por local >= 99 %', n_ver / len(locais) >= 0.99)

    print('== 5) contenção no município ==')
    feats, _ = geo_ref.load_mesh(os.path.join(REPO, 'data', 'geo_sc_municipios.json'))
    rings_by_code = {c: r for c, _n, r in feats}
    out_mun, edge = [], 0
    for L in withc:
        rings = rings_by_code.get(L[2], [])
        lon, lat = L[8]
        if geo_ref.in_any_ring(rings, lon, lat):
            continue
        d = min((geo_ref.dist_to_ring_m(r, lon, lat) for r in rings),
                default=float('inf'))
        if L[12] == 'edge' and d <= geo_ref.EDGE_MUN_M:
            edge += 1
        else:
            out_mun.append((L[4], L[12], f'{d:.0f} m'))
    check('coords dentro do município (ou edge <= 500 m)',
          not out_mun, str(out_mun[:5]))
    print(f'   (edge: {edge})')

    print('== 6) re-derivação TSE + spot-checks geográficos ==')
    # (mun_tse, zona, local_code) -> linha; a zona de identidade do local
    # é a zona das seções que se associaram a ele (seções só associam à
    # identidade de mesmo município+zona+código).
    loc_by_key = {}
    for L in locais:
        for z in L[6]:
            loc_by_key.setdefault((L[1], z, L[14]), L)
    n_chk = 0
    city_by_name = {c['name']: c for c in ref['cities']}
    for c in ref['checks']:
        L = loc_by_key.get((c['muni'], c['zona'], c['local_code']))
        if L is None:
            check(f"spot {c['city']}: local ({c['muni']},{c['zona']},{c['local_code']}) no catálogo",
                  False, 'ausente')
            continue
        n_chk += 1
        check(f"spot {c['city']}: coordenada == oficial TSE",
              L[8] is not None and L[8][0] == round(c['lon'], 6)
              and L[8][1] == round(c['lat'], 6),
              f'{L[8]} vs ({round(c["lon"], 6)}, {round(c["lat"], 6)})')
        check(f"spot {c['city']}: nome do local",
              geo_ref.norm(L[4]) == geo_ref.norm(c['nome']),
              f'{L[4]} vs {c["nome"]}')
        lon, lat = L[8]
        rings = rings_by_code.get(L[2], [])
        inside = geo_ref.in_any_ring(rings, lon, lat)
        near_city = False
        cp = city_by_name.get(c['city'])
        if cp:
            near_city = dist_km(lon, lat, cp['lon'], cp['lat']) < 30
        check(f"spot {c['city']}: dentro do município + < 30 km do centro",
              (inside or L[12] == 'edge') and near_city,
              f'inside={inside} status={L[12]}')
    check('todos os spot-checks verificados', n_chk == len(ref['checks']),
          f'{n_chk}/{len(ref["checks"])}')

    print('== 7) prisões (lacunas do TSE resolvidas por OSM) ==')
    for p in ref['prisons']:
        L = loc_by_key.get((p['muni'], p['zona'], p['local_code']))
        if L is None:
            check(f"prisão {p['city']}: local no catálogo", False, 'ausente')
            continue
        if L[8] is None:
            check(f"prisão {p['city']}: pendente (aceitável, reportada)",
                  L[12] in ('pendente', 'ambiguo'), str(L[12]))
            continue
        is_ovr = 'revisão manual' in L[9]
        check(f"prisão {p['city']}: fonte OSM ou revisão manual (TSE sem coord)",
              'OSM' in L[9] or is_ovr, str(L[9]))
        rings = rings_by_code.get(L[2], [])
        lon, lat = L[8]
        check(f"prisão {p['city']}: dentro do município",
              geo_ref.in_any_ring(rings, lon, lat) or L[12] == 'edge')

    print('== 8) manifesto de revisões manuais (sync/geo_overrides.json) ==')
    ovr_path = os.path.join(REPO, 'sync', 'geo_overrides.json')
    if not os.path.exists(ovr_path):
        check('manifesto presente no repositório', False, 'ausente')
    else:
        import hashlib as _hashlib
        ovr = json.load(open(ovr_path, encoding='utf-8'))
        sha = _hashlib.sha256(open(ovr_path, 'rb').read()).hexdigest()
        rm = index.get('fontes', {}).get('revisoes_manuais', {})
        check('fontes.revisoes_manuais presente', bool(rm))
        check('sha256 publicado == arquivo versionado', rm.get('sha256') == sha,
              f"{rm.get('sha256', '')[:12]} vs {sha[:12]}")
        check('contagens batem com o manifesto',
              rm.get('n') == len(ovr['overrides'])
              and rm.get('corrigir') == sum(1 for o in ovr['overrides'] if o['veredito'] == 'corrigir')
              and rm.get('documentar') == sum(1 for o in ovr['overrides'] if o['veredito'] == 'documentar'))
        for o in ovr['overrides']:
            L = loc_by_key.get((o['local']['mun_tse'], int(o['local']['zona']), o['local']['local_code']))
            if L is None:
                check(f"manifesto {o['local']}: local no catálogo", False, 'ausente')
                continue
            if o['veredito'] == 'corrigir':
                check(f"corrigir {L[4]}: coord publicada == manifesto",
                      L[8] is not None and abs(o['coord'][0] - L[8][0]) <= 1.5e-6
                      and abs(o['coord'][1] - L[8][1]) <= 1.5e-6, str(L[8]))
                check(f"corrigir {L[4]}: fonte/ref de revisão",
                      'revisão manual' in L[9] and str(L[13]).startswith('override:'),
                      f'{L[9]} / {L[13]}')
                check(f"corrigir {L[4]}: status coerente + dentro do município",
                      L[12] in ('verificado', 'edge')
                      and (geo_ref.in_any_ring(rings_by_code.get(L[2], []), L[8][0], L[8][1])
                           or L[12] == 'edge'), L[12])
                check(f"corrigir {L[4]}: coord anterior/sentinela preservada em obs",
                      any(str(x).startswith('coord oficial TSE anterior:') for x in L[15])
                      or any('sentinela -1,-1' in str(x) for x in L[15]), str(L[15])[:80])
                check(f"corrigir {L[4]}: evidências em obs",
                      sum(1 for x in L[15] if 'evidência:' in str(x)) >= 1, str(len(L[15])))
            else:
                check(f"documentar {L[4]}: parecer em obs",
                      any(str(x).startswith(f"revisão manual documentar ({o['revisado_em']})")
                          for x in L[15]), str(L[15])[:80])
                check(f"documentar {L[4]}: coord do pipeline automático (não do manifesto)",
                      L[9] != '' and 'revisão manual' not in L[9], str(L[9]))

    print('== 9) determinismo (rebuild offline do cache) ==')
    if args.no_rebuild:
        print('   (pulando: --no-rebuild)')
    else:
        cache = os.path.join(REPO, 'cache')
        with tempfile.TemporaryDirectory() as td1, tempfile.TemporaryDirectory() as td2:
            for td in (td1, td2):
                r = subprocess.run([sys.executable,
                                    os.path.join(REPO, 'sync', 'geo_ref.py'),
                                    '--out', td,
                                    '--report', os.path.join(td, 'r.json'),
                                    '--cache', cache],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    check('rebuild executa', False, r.stderr[-400:])
                    return 1
            f1 = [os.path.join(td1, f)
                  for f in ('index.json', 'locais.json', 'secoes.json')]
            f2 = [os.path.join(td2, f)
                  for f in ('index.json', 'locais.json', 'secoes.json')]
            identical = all(open(a, 'rb').read() == open(b, 'rb').read()
                            for a, b in zip(f1, f2))
            check('rebuild reproduz bytes idênticos', identical)
            pub_same = all(open(a, 'rb').read() ==
                           open(os.path.join(out, os.path.basename(a)), 'rb').read()
                           for a in f1)
            check('rebuild == publicado', pub_same)

    print('\nGEO-REF-CHECK ' + ('OK' if ok else 'FALHOU'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
