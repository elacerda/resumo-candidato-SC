#!/usr/bin/env python3
"""Gera o snapshot TSE 2026 (Santa Catarina) para o app resumo-candidato-SC.

Baixa (ou usa, via --zip-sc/--zip-br) os zips oficiais
  votacao_secao_2026_SC.zip  (Dep. Federal, Dep. Estadual, Governador, Senador)
  votacao_secao_2026_BR.zip  (Presidente)
do CDN do TSE (https://cdn.tse.jus.br), filtra UF=SC e 1o turno, e escreve:

  <out>/index.json        -> indice: por cargo, cada candidato com
                             [nome, total de votos, n secoes, n municipios]
  <out>/secoes.json       -> tabela unica de secoes (dedup por
                             municipio+zona+secao) + municipios
  <out>/<cargo>.json      -> cand: { numero: [[idxSecao, votos], ...] }

O app (GitHub Pages) consulta por numero direto nesses arquivos, na mesma
origem: sem baixar o CSV completo (600 MB+). O workflow tse-sync.yml
re-executa este script e commita as mudancas; sem snapshot, o app cai no
fallback de download direto do CDN.

Somente stdlib. Uso:
  python3 sync/tse_sync.py --out data/tse_2026 [--zip-sc A.zip --zip-br B.zip]
"""
from collections import defaultdict
from datetime import datetime, timezone
import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile

#!/usr/bin/env python3
"""Gera o snapshot TSE 2026 (Santa Catarina) para o app resumo-candidato-SC.

Baixa (ou usa, via --zip-sc/--zip-br) os zips oficiais
  votacao_secao_2026_SC.zip  (Dep. Federal, Dep. Estadual, Governador, Senador)
  votacao_secao_2026_BR.zip  (Presidente)
do CDN do TSE (https://cdn.tse.jus.br), filtra UF=SC e 1o turno, e escreve:

  <out>/index.json        -> indice: por cargo, cada candidato com
                             [nome, total de votos, n secoes, n municipios]
  <out>/secoes.json       -> tabela unica de secoes (dedup por
                             municipio+zona+secao) + municipios
  <out>/<cargo>.json      -> cand: { numero: [[idxSecao, votos], ...] }

O app (GitHub Pages) consulta por numero direto nesses arquivos, na mesma
origem: sem baixar o CSV completo (600 MB+). O workflow tse-sync.yml
re-executa este script e commita as mudancas; sem snapshot, o app cai no
fallback de download direto do CDN.

Somente stdlib. Uso:
  python3 sync/tse_sync.py --out data/tse_2026 [--zip-sc A.zip --zip-br B.zip]
"""

CDN = 'https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/'
CARGOS = {
    'DEPUTADO FEDERAL': 'dep_federal',
    'DEPUTADO ESTADUAL': 'dep_estadual',
    'GOVERNADOR': 'governador',
    'SENADOR': 'senador',
}
BR_CARGOS = {'PRESIDENTE': 'presidente'}
BLANK = {'0', '1', '95', '96', '99'}
BLANK_NOME = re.compile(r'VOTO\s+(BRANCO|NULO)', re.I)
ELEICAO = '2026'
UF = 'SC'


def parse_gen(gen):
    # '06/10/2026 14:03:43' -> '2026-10-06T14:03:43' (timestamp do arquivo TSE)
    try:
        d, h = gen.split()
        dd, mm, yy = d.split('/')
        return '%s-%s-%sT%s' % (yy, mm, dd, h)
    except Exception:
        return ''


def http_get(url, dest, desc):
    print(f'[{desc}] baixando {url}', flush=True)
    tmp = dest + '.part'
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)
    print(f'[{desc}] {os.path.getsize(dest) / 1e6:.1f} MB', flush=True)


def pick_csv(zf):
    names = [n for n in zf.namelist() if n.lower().endswith('.csv')]
    if not names:
        raise SystemExit('zip sem CSV: ' + str(zf.namelist()))
    return max(names, key=lambda n: zf.getinfo(n).file_size)


class Acc:
    def __init__(self):
        self.mun_idx = {}        # code TSE -> idx
        self.mun_list = []       # idx -> [code, nome]
        self.secs = {}           # (mun, zona, secao) -> idx
        self.sec_list = []       # [munIdx, zona, secao, local, end]
        # slug -> numero -> [nome, total, nSec, {mun}, [(sIdx, v)]]
        self.cand = defaultdict(lambda: defaultdict(
            lambda: ['', 0, 0, set(), []]))
        self.gen = ''             # DT_GERACAO/HH_GERACAO do arquivo TSE

    def mun(self, code, nome):
        i = self.mun_idx.get(code)
        if i is None:
            i = len(self.mun_list)
            self.mun_idx[code] = i
            self.mun_list.append([code, nome])
        return i

    def sec_idx(self, mi, zona, secao, local, end):
        key = (mi, zona, secao)
        i = self.secs.get(key)
        if i is None:
            i = len(self.sec_list)
            self.secs[key] = i
            self.sec_list.append([mi, zona, secao, local, end])
        return i


def process(zippath, cargos, acc, label):
    t0 = datetime.now()
    nrow = 0
    with zipfile.ZipFile(zippath) as zf:
        name = pick_csv(zf)
        with zf.open(name) as raw:
            text = io.TextIOWrapper(raw, encoding='latin-1', newline='')
            rdr = csv.reader(text, delimiter=';', quotechar='"')
            header = next(rdr)
            col = {}
            for i, h in enumerate(header):
                col[h.strip().strip('"')] = i
            for need in ('SG_UF', 'NR_TURNO', 'DS_CARGO', 'NR_VOTAVEL',
                         'NM_VOTAVEL', 'CD_MUNICIPIO', 'NM_MUNICIPIO',
                         'NR_ZONA', 'NR_SECAO', 'QT_VOTOS',
                         'NM_LOCAL_VOTACAO', 'DS_LOCAL_VOTACAO_ENDERECO'):
                if need not in col:
                    raise SystemExit(f'{zippath}: coluna ausente: {need}')
            for row in rdr:
                if not acc.gen:
                    acc.gen = (row[col['DT_GERACAO']].strip() + ' '
                               + row[col['HH_GERACAO']].strip())
                if row[col['SG_UF']] != UF:
                    continue
                if row[col['NR_TURNO']] != '1':
                    continue
                slug = cargos.get(row[col['DS_CARGO']].strip().upper())
                if not slug:
                    continue
                num = row[col['NR_VOTAVEL']].strip()
                if num in BLANK:
                    continue
                nome0 = row[col['NM_VOTAVEL']].strip()
                if BLANK_NOME.search(nome0):
                    continue
                try:
                    v = int(row[col['QT_VOTOS']] or '0')
                except ValueError:
                    continue
                if v <= 0:
                    continue
                e = acc.cand[slug][num]
                if nome0 and not e[0]:
                    e[0] = nome0
                mun = row[col['CD_MUNICIPIO']].strip()
                mname = row[col['NM_MUNICIPIO']].strip()
                mi = acc.mun(mun, mname)
                s = acc.sec_idx(mi, row[col['NR_ZONA']].strip(),
                                row[col['NR_SECAO']].strip(),
                                row[col['NM_LOCAL_VOTACAO']].strip(),
                                row[col['DS_LOCAL_VOTACAO_ENDERECO']].strip())
                e[1] += v
                e[2] += 1
                e[3].add(mun)
                e[4].append((s, v))
                nrow += 1
    dt = (datetime.now() - t0).total_seconds()
    print(f'[{label}] {nrow} linhas SC/1T em {dt:.1f}s '
          f'({len(acc.sec_list)} secoes unicas, '
          f'{len(acc.mun_list)} municipios)', flush=True)


def dump_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data/tse_2026')
    ap.add_argument('--zip-sc', default=None,
                    help='caminho local (padrao: baixar %sSC.zip)' % CDN)
    ap.add_argument('--zip-br', default=None,
                    help='caminho local (padrao: baixar %sBR.zip)' % CDN)
    ap.add_argument('--workdir', default='/tmp')
    args = ap.parse_args()

    sc = args.zip_sc or os.path.join(args.workdir, 'votacao_secao_%s_SC.zip' % ELEICAO)
    br = args.zip_br or os.path.join(args.workdir, 'votacao_secao_%s_BR.zip' % ELEICAO)
    if not args.zip_sc and not os.path.exists(sc):
        http_get(CDN + 'votacao_secao_%s_SC.zip' % ELEICAO, sc, 'SC')
    if not args.zip_br and not os.path.exists(br):
        http_get(CDN + 'votacao_secao_%s_BR.zip' % ELEICAO, br, 'BR')

    acc = Acc()
    process(sc, CARGOS, acc, 'SC')
    process(br, BR_CARGOS, acc, 'BR/PRESIDENTE')

    os.makedirs(args.out, exist_ok=True)
    now = parse_gen(acc.gen) or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    dump_json(os.path.join(args.out, 'secoes.json'), {
        'mun': acc.mun_list,
        'secoes': acc.sec_list,
    })

    cargos = {}
    for ds_cargo, slug in {**CARGOS, **BR_CARGOS}.items():
        if slug not in acc.cand:
            continue
        cands = acc.cand[slug]
        ordered = sorted(cands.items(), key=lambda kv: (-kv[1][1], kv[0]))
        cand_out = {}
        idx_out = {}
        for num, (nome, total, nsec, muns, rows) in ordered:
            cand_out[num] = [[s, v] for s, v in rows]
            idx_out[num] = [nome, total, nsec, len(muns)]
        dump_json(os.path.join(args.out, slug + '.json'),
                  {'cargo': ds_cargo, 'eleicao': ELEICAO, 'uf': UF,
                   'gerado_em': now, 'cand': cand_out})
        cargos[ds_cargo] = {'arquivo': slug + '.json', 'candidatos': idx_out}
        print(f'  {ds_cargo}: {len(cands)} candidatos, '
              f'{sum(e[2] for e in cands.values())} linhas', flush=True)

    dump_json(os.path.join(args.out, 'index.json'), {
        'eleicao': ELEICAO, 'uf': UF, 'gerado_em': now,
        'secoes': 'secoes.json',
        'fontes': {
            'SC': 'votacao_secao_%s_SC.zip' % ELEICAO,
            'PRESIDENTE': 'votacao_secao_%s_BR.zip' % ELEICAO,
        },
        'cargos': cargos,
    })
    print('snapshot em', args.out, flush=True)
    total_bytes = sum(os.path.getsize(os.path.join(args.out, f))
                      for f in os.listdir(args.out))
    print(f'total: {total_bytes / 1e6:.1f} MB em {len(os.listdir(args.out))} arquivos',
          flush=True)


if __name__ == '__main__':
    main()
