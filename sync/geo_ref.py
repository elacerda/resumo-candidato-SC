#!/usr/bin/env python3
"""Georreferenciamento estadual dos locais de votação — SC, Eleições 2026.

Pipeline offline e reprodutível (somente stdlib) que:

  A. adquire/carrega fontes oficiais com cache + verificação de
     integridade:
       - TSE "Eleitorado por local de votação — 2026" (zip oficial com
         CSV por UF) — FONTE PRIMÁRIA: associação seção → local de
         votação (identificadores oficiais) e coordenadas oficiais
         WGS84 de cada local;
       - TSE 2026 snapshot do repositório (data/tse_2026) — dataset de
         seções do app (17.326) e cross-check de nomes/endereços;
       - INEP Censo Escolar 2025 (+ 2024, endereços) — validação
         institucional (a escola existe? no mesmo município? mesma rua?);
       - OSM (extrato geofabrik sul-latest.osm.pbf, região RS+SC+PR) —
         preenchimento de lacunas (locais sem coordenada oficial) e
         verificação independente das coordenadas oficiais;
       - TRE-SC (API lista-locais) — cross-check de zona/endereço/CEP;
  B. associa cada seção do snapshot 2026 ao seu local de votação por
     identificador oficial (código TSE do local); sem fuzzy na
     associação — o arquivo do TSE já contém a relação seção → local;
  C. obtém coordenadas WGS84 por local físico (não por seção):
     1) coordenada oficial do TSE (autoritativa);
     2) instalações OSM (apenas para locais sem coordenada oficial);
     INEP nunca fornece coordenada (Censo Escolar sem georreferência
     desde 2023) — apenas validação institucional;
  D. valida consistência geográfica (WGS84, contenção no município com
     PIP independente, detecção de lat/lon trocados, sentinelas
     -1,-1, duplicatas) e cruza INEP/OSM/TRE-SC sem alterar a
     coordenada oficial (flag em observações/relatório);
  E. publica catálogos JSON determinísticos em `data/geo_loc/` e
     relatório de cobertura em `reports/`.

Invariantes:
  - a posição de uma seção é a posição VERIFICADA do seu local de
    votação; nenhuma coordenada é inventada nem aproximada sem origem;
  - identidade do local físico = (código TSE do município, zona,
    código do local NR_LOCAL_VOTACAO) — o código do local é o
    identificador oficial; dois prédios distintos nunca compartilham
    código; variantes de grafia de nome/endereço do próprio TSE são
    resolvidas por maioria (determinístico) e registradas;
  - centroides de município/bairro/CEP nunca são promovidos a
    coordenada de local;
  - saída determinística para as mesmas entradas (ordem fixa,
    arredondamento fixo, sem timestamp de parede).

Uso:
    python3 sync/geo_ref.py                     # usa cache/ já populada
    python3 sync/geo_ref.py --fetch             # (re)baixa fontes faltantes
    python3 sync/geo_ref.py --out DIR --report R --cache C
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(REPO, 'cache')
OUT = os.path.join(REPO, 'data', 'geo_loc')
REPORT = os.path.join(REPO, 'reports', 'geo_cobertura.json')
USER_AGENT = 'resumo-candidato-sc/1.0 (pipeline de georeferenciamento offline; contato elacerda@github.com)'
ELEICAO = '2026'
# bbox de SC (graus WGS84) — folga pequena além do estado
SC_BBOX = (-54.6, -31.2, -47.9, -25.6)  # (min_lon, min_lat, max_lon, max_lat)
EDGE_MUN_M = 500.0   # fora do polígono, mas a <= 500 m -> 'edge' (manter c/ flag)
CROSS_OK_M = 150.0   # OSM/INEP: <= 150 m confirma a coordenada oficial
CROSS_OBS_M = 500.0  # 150–500 m -> observação; > 500 m -> conflito (flag)
COORD_SENTINELA = (-1.0, -1.0)  # TSE usa -1,-1 p/ "sem coordenada"
OVERRIDES_NAME = 'geo_overrides.json'  # manifesto de revisões manuais (sync/)

# --------------------------------------------------------------------------
# fontes (URLs oficiais — proveniência registrada no relatório)
# --------------------------------------------------------------------------
TSE_LOCALS_ZIP_URL = ('https://cdn.tse.jus.br/estatistica/sead/odsele/'
                      'eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip')
TSE_LOCALS_ZIP = 'eleitorado_local_votacao_2026.zip'
TSE_LOCALS_CSV = 'eleitorado_local_votacao_2026_SC.csv'
INEP_2025_ZIP_URL = 'http://download.inep.gov.br/dados_abertos/microdados_censo_escolar_2025_.zip'
INEP_2025_ZIP = 'microdados_censo_escolar_2025.zip'
INEP_2025_TBL = 'microdados_censo_escolar_2025_v2/dados/Tabela_Escola_2025_V2.csv'
INEP_2024_ZIP_URL = 'http://download.inep.gov.br/microdados/censos/microdados_ed_basica_2024.zip'
INEP_2024_ZIP = 'microdados_censo_escolar_2024.zip'
INEP_2024_TBL = 'microdados_ed_basica_2024.csv'
INEP_ESCOLAS_CSV = 'inep_escolas_sc.csv'        # subset SC (2025): nome/município/CO_ENTIDADE
INEP_ESCOLAS_END_CSV = 'inep_escolas_sc_end.csv'  # subset SC (2024): + endereço
OSM_PBF_URL = 'https://download.geofabrik.de/south-america/brazil/sul-latest.osm.pbf'
OSM_PBF_NAME = 'sul-latest.osm.pbf'
OSM_JSON_NAME = 'osm_sc_facilities.json'
TRE_SC_URL = 'https://apps.tre-sc.jus.br/dadosabertos-api/lista-locais/json'


class SourceError(RuntimeError):
    """Fonte ausente ou inválida."""


# --------------------------------------------------------------------------
# normalização de texto (documentada — espelha Core.norm do front-end)
# --------------------------------------------------------------------------

def norm(s) -> str:
    """Normaliza para comparação: NFKD, remove acentos, maiúsculas,
    mantém só A-Z0-9. (Idêntico ao `norm` de js/core.js.)

    :param s: texto de entrada.
    :returns: string normalizada (vazia se s é None).
    """
    if s is None:
        return ''
    s = unicodedata.normalize('NFKD', str(s))
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return re.sub(r'[^A-Z0-9]', '', s.upper())


# tokens genéricos de tipo de instituição removidos para o "core" do nome
_TYPE_TOKENS = (
    'EEM', 'EEF', 'EMEF', 'EMEFI', 'EME', 'EMF', 'EEMF', 'EEMEF',
    'COLLEGIO', 'COLEGIO', 'COL', 'ESCOLA', 'ESC',
    'CENTRODEEDUCACAO', 'CENTROEDUCACIONAL', 'CENTROEDUCACAO', 'CENTRO',
    'CIEP', 'CED', 'CMEI', 'CEMEI', 'CEI', 'CEM', 'CEJA', 'CRECHE',
    'UNIDADEESCOLAR', 'UNIDADE', 'MUNICIPAL', 'ESTADUAL', 'FEDERAL',
    'PUBLICA', 'PRIVADA', 'ESPECIAL', 'PROFESSORA', 'PROFESSOR', 'PROF',
    'DOUTORA', 'DOUTOR', 'IRMAO', 'IRMA', 'PADRE', 'FREI', 'FREIRA',
    'SANTA', 'SAO', 'SR', 'SRA', 'DR', 'DRA', 'APE', 'APAE',
    'FUNDACAO', 'FUND', 'INSTITUTO', 'UNIVERSIDADE', 'UNIVERSITARIO',
    'CENTROUNIVERSITARIO', 'CENTROUNIVERSITARIA',
)


def core(nome_norm: str) -> str:
    """Remove tokens genéricos de tipo de instituição (documentados) de um
    nome já normalizado, do início, e o token de honraria em qualquer
    posição. Ex.: 'EMEFJOAOXXIII' -> 'JOAOXXIII'.

    :param nome_norm: nome já passado por norm().
    :returns: núcleo do nome (pode ser vazio).
    """
    s = nome_norm
    changed = True
    while changed and s:
        changed = False
        for t in _TYPE_TOKENS:
            if s.startswith(t) and len(s) > len(t):
                s = s[len(t):]
                changed = True
                break
    for h in ('PROFESSORA', 'PROFESSOR', 'PROF'):
        s = s.replace(h, '')
    return s


_STREET_TYPES = (
    'RODOVIA', 'ESTRADA', 'CAMINHO', 'AVENIDA', 'ALAMEDA',
    'TRAVESSA', 'PRAÇA', 'PRACA', 'LARGO', 'RUA', 'VIA', 'FAZENDA',
    'CHÁCARA', 'CHACARA', 'LINHA', 'CONJUNTO', 'QUADRA', 'SETOR',
    'ROD', 'BR', 'SC',
)


def street_norm(street_raw: str) -> str | None:
    """Núcleo da rua: normaliza (norm) e remove prefixo de tipo de via.

    :param street_raw: rua crua (sem número), ex.: 'RUA FRANCISCO FAUSTO MARTINS'.
    :returns: núcleo normalizado (ex.: 'FRANCISCOFAUSTOMARTINS') ou None.
    """
    part = norm(street_raw)
    if not part:
        return None
    changed = True
    while changed and part:
        changed = False
        for t in _STREET_TYPES:
            if part.startswith(t) and len(part) > len(t) and part[len(t)].isdigit() is False:
                part = part[len(t):]
                changed = True
                break
    # remove numerais de rodovia no início (BR 101 / SC 408)
    part = re.sub(r'^(BR|SC)\d*', '', part)
    return part or None


def street_of(end_raw: str) -> str | None:
    """Núcleo da rua de um endereço completo: parte antes da vírgula
    (no formato TSE, a vírgula separa a rua do número).

    :param end_raw: endereço completo crú, ex.: 'RUA X, 123'.
    :returns: núcleo da rua normalizado ou None.
    """
    if not end_raw:
        return None
    part = str(end_raw).split(',', 1)[0].strip()
    return street_norm(part)


# --------------------------------------------------------------------------
# geometria (WGS84)
# --------------------------------------------------------------------------

def haversine_m(lon1, lat1, lon2, lat2) -> float:
    """Distância aproximada em metros (haversine, raio 6371000 m)."""
    kx = math.cos(math.radians((lat1 + lat2) / 2))
    dx = math.radians(lon2 - lon1) * 6371000.0 * kx
    dy = math.radians(lat2 - lat1) * 6371000.0
    return math.hypot(dx, dy)


def in_ring(ring, x, y) -> bool:
    """Point-in-ring (ray casting).

    :param ring: lista [(lon, lat), ...] (anel fechado ou não).
    :param x: longitude.
    :param y: latitude.
    :returns: True se o ponto está dentro do anel.
    """
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            xt = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xt:
                inside = not inside
        j = i
    return inside


def in_any_ring(rings, x, y) -> bool:
    """Contenção em qualquer anel (MultiPolygon = união de anéis)."""
    return any(in_ring(r, x, y) for r in rings)


def _dist_pt_seg_m(px, py, ax, ay, bx, by) -> float:
    """Distância (m) de um ponto ao segmento, em aproximação planar local
    (mesma convenção de escala de haversine_m: eixo-x escalado por
    cos(lat média), raio 6371000 m).

    :param px, py: longitude/latitude do ponto (graus).
    :param ax, ay: longitude/latitude da extremidade A do segmento (graus).
    :param bx, by: longitude/latitude da extremidade B do segmento (graus).
    :returns: distância mínima ponto-segmento em metros (0..infinito).
    """
    kx = math.cos(math.radians((py + ay + by) / 3.0)) * 6371000.0 * math.radians(1.0)
    ky = 6371000.0 * math.radians(1.0)
    axp, ayp = (ax - px) * kx, (ay - py) * ky
    bxp, byp = (bx - px) * kx, (by - py) * ky
    vx, vy = bxp - axp, byp - ayp
    wx, wy = -axp, -ayp
    v2 = vx * vx + vy * vy
    t = 0.0 if v2 == 0.0 else max(0.0, min(1.0, (wx * vx + wy * vy) / v2))
    return math.hypot(axp + t * vx, ayp + t * vy)


def _proj_pt_seg_deg(px, py, ax, ay, bx, by) -> tuple[float, float, float]:
    """Projeção de (px, py) no segmento A-B (mesma convenção planar de
    _dist_pt_seg_m).

    :returns: (distância_m, lon_proj, lat_proj) — a projeção é limitada
        ao segmento (extremidades inclusas).
    """
    kx = math.cos(math.radians((py + ay + by) / 3.0)) * 6371000.0 * math.radians(1.0)
    ky = 6371000.0 * math.radians(1.0)
    axp, ayp = (ax - px) * kx, (ay - py) * ky
    bxp, byp = (bx - px) * kx, (by - py) * ky
    vx, vy = bxp - axp, byp - ayp
    wx, wy = -axp, -ayp
    v2 = vx * vx + vy * vy
    t = 0.0 if v2 == 0.0 else max(0.0, min(1.0, (wx * vx + wy * vy) / v2))
    return math.hypot(axp + t * vx, ayp + t * vy), (axp + t * vx) / kx + px, (ayp + t * vy) / ky + py


def _dist_pt_seg_m(px, py, ax, ay, bx, by) -> float:
    """Distância (m) de um ponto ao segmento (aproximação planar local).

    :param px, py: longitude/latitude do ponto (graus).
    :param ax, ay: longitude/latitude da extremidade A (graus).
    :param bx, by: longitude/latitude da extremidade B (graus).
    :returns: distância mínima ponto-segmento em metros.
    """
    return _proj_pt_seg_deg(px, py, ax, ay, bx, by)[0]


def _closest_pt_ring(rings, x, y):
    """Ponto do anel mais próximo de (x, y) e distância correspondente
    (distância exata ponto-segmento sobre todos os segmentos).

    :param rings: lista de anéis [(lon, lat), ...] (MultiPolygon = união).
    :param x: longitude (graus).
    :param y: latitude (graus).
    :returns: (distância_m, (lon, lat) do ponto do anel mais próximo).
    """
    best = float('inf')
    best_pt = None
    for ring in rings:
        for i in range(len(ring) - 1):
            xi, yi = ring[i]
            xj, yj = ring[i + 1]
            d, qx, qy = _proj_pt_seg_deg(x, y, xi, yi, xj, yj)
            if d < best:
                best = d
                best_pt = (qx, qy)
    return best, best_pt


def dist_to_ring_m(ring, x, y) -> float:
    """Distância exata (m, aproximação planar local) do ponto ao anel:
    mínimo sobre TODOS os segmentos consecutivos (não apenas vértices
    amostrados — um ponto sobre segmento longo não depende da densidade
    de vértices do anel; correção 2026-10 do antigo amostramento stride-3
    que superestimava a distância na fronteira Indaial/Timbó, 3250 m vs
    5,6 m reais).

    :param ring: lista [(lon, lat), ...].
    :param x: longitude (graus).
    :param y: latitude (graus).
    :returns: distância mínima em metros (0..infinito).
    """
    return _closest_pt_ring([ring], x, y)[0]


def load_mesh(path: str):
    """Carrega a malha municipal (GeoJSON).

    :returns: (feats, name2code) onde feats = [(ibge, nome, rings), ...]
        e name2code = {norm(nome): [ibge, ...]}.
    """
    geo = json.load(open(path, encoding='utf-8'))

    def rings_of(g):
        if g['type'] == 'Polygon':
            return [g['coordinates'][0]]
        return [c[0] for c in g['coordinates']]

    feats = []
    name2code = collections.defaultdict(list)
    for f in geo['features']:
        p = f.get('properties') or {}
        code = str(p.get('id', ''))
        nome = p.get('name') or p.get('description') or ''
        feats.append((code, nome, rings_of(f['geometry'])))
        name2code[norm(nome)].append(code)
    return feats, dict(name2code)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def md5_file(path: str) -> str:
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest().upper()


# --------------------------------------------------------------------------
# aquisição e carga de fontes (cache + hash)
# --------------------------------------------------------------------------

def http_get(url: str, dest: str, timeout: int = 600) -> int:
    """Baixa url para dest (retorna tamanho em bytes).

    :raises urllib.error.URLError: em falha de rede/HTTP.
    """
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
        return f.tell()


def ensure_source(name: str, url: str, cache_dir: str, validator=None) -> str:
    """Garante que a fonte está em cache (baixa se faltar/for inválida).

    :param name: nome do arquivo de cache.
    :param url: URL de origem (proveniência registrada no relatório).
    :param cache_dir: diretório de cache.
    :param validator: opcional fn(path) -> bool (validação de esquema).
    :returns: caminho do arquivo em cache.
    """
    path = os.path.join(cache_dir, name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        if validator is None or validator(path):
            return path
    tmp = path + '.part'
    http_get(url, tmp, timeout=900)
    os.replace(tmp, path)
    return path


# ---------------- TSE: eleitorado por local de votação 2026 (primária) ----------------

def _parse_coord(v: str):
    """Decodifica coordenada do CSV do TSE (vírgula decimal; -1 = sem)."""
    v = (v or '').strip().replace(',', '.')
    if not v:
        return None
    try:
        x = float(v)
    except ValueError:
        return None
    if x == -1.0:
        return None
    return x


def _resolve_variant(counter: dict) -> str:
    """Maioria determinística de variantes (empate -> menor em ordem
    lexicográfica)."""
    return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


def load_tse_locais(cache_dir: str) -> dict | None:
    """Carrega o CSV oficial "Eleitorado por local de votação — 2026"
    (SC) do cache, com validação de integridade.

    Validações (falha = SourceError):
      - AA_ELEICAO == '2026', SG_UF == 'SC';
      - cada (mun, zona, secao) aparece exatamente 2x (duplicidade do
        export) e aponta para UM único local;
      - por (mun, zona, local): coordenadas idênticas em todas as
        linhas (sentinela -1,-1 = sem coordenada);
      - variantes de grafia de nome/endereço (o TSE publica ambas as
        grafias para o mesmo local): resolvidas por maioria.

    :param cache_dir: diretório de cache (com TSE_LOCALS_CSV).
    :returns: dict {'meta', 'locais', 'secoes'} ou None se ausente.
        locais = {(mun_tse, zona, local_code): {nome, end, cep, bairro,
        situ, telefone, lat, lon, n_var_nome, n_var_end}};
        secoes = {(mun_tse, zona, secao): local_key, 'agregada': bool}.
    :raises SourceError: esquema ou integridade inválidos.
    """
    path = os.path.join(cache_dir, TSE_LOCALS_CSV)
    if not os.path.exists(path):
        return None
    meta = {}
    locais: dict = {}
    secoes: dict = {}
    n_linhas = 0
    sec_local: dict = {}
    sec_count: dict = collections.Counter()
    import csv as _csv
    with open(path, encoding='latin-1', newline='') as f:
        rd = _csv.reader(f, delimiter=';')
        header = [h.strip() for h in next(rd)]
        idx = {h: i for i, h in enumerate(header)}
        need = ('DT_GERACAO', 'HH_GERACAO', 'AA_ELEICAO', 'SG_UF',
                'CD_MUNICIPIO', 'NM_MUNICIPIO', 'NR_ZONA', 'NR_SECAO',
                'CD_TIPO_SECAO_AGREGADA', 'NR_LOCAL_VOTACAO',
                'NM_LOCAL_VOTACAO', 'DS_ENDERECO', 'NM_BAIRRO', 'NR_CEP',
                'NR_LATITUDE', 'NR_LONGITUDE', 'CD_SITU_LOCAL_VOTACAO')
        missing = [c for c in need if c not in idx]
        if missing:
            raise SourceError(f'TSE locais: colunas ausentes: {missing}')
        for row in rd:
            if len(row) < len(header):
                continue
            n_linhas += 1
            mun = row[idx['CD_MUNICIPIO']].strip()
            zona = row[idx['NR_ZONA']].strip()
            secao = row[idx['NR_SECAO']].strip()
            lcode = row[idx['NR_LOCAL_VOTACAO']].strip()
            nome = row[idx['NM_LOCAL_VOTACAO']].strip()
            end = row[idx['DS_ENDERECO']].strip()
            lat = _parse_coord(row[idx['NR_LATITUDE']])
            lon = _parse_coord(row[idx['NR_LONGITUDE']])
            if not meta:
                meta = {
                    'dt_geracao': f"{row[idx['DT_GERACAO']].strip()} "
                                  f"{row[idx['HH_GERACAO']].strip()}",
                    'aa_eleicao': row[idx['AA_ELEICAO']].strip(),
                    'sg_uf': row[idx['SG_UF']].strip(),
                    'n_linhas': 0,
                }
            # validação por seção
            sec_count[(mun, zona, secao)] += 1
            if (mun, zona, secao) in sec_local and sec_local[(mun, zona, secao)] != (mun, zona, lcode):
                raise SourceError(f'seção {mun}/{zona}/{secao} aponta para 2 locais')
            sec_local[(mun, zona, secao)] = (mun, zona, lcode)
            # validação/acumulação por local
            k = (mun, zona, lcode)
            rec = locais.get(k)
            if rec is None:
                locais[k] = {
                    'mun_tse': mun, 'zona': zona, 'local_code': lcode,
                    'mun_nome': row[idx['NM_MUNICIPIO']].strip(),
                    '_nome': collections.Counter(), '_end': collections.Counter(),
                    'cep': (row[idx['NR_CEP']].strip() or None),
                    'bairro': (row[idx['NM_BAIRRO']].strip() or None),
                    'situ': row[idx['CD_SITU_LOCAL_VOTACAO']].strip(),
                    'coords': {(lat, lon)},
                }
                rec = locais[k]
            rec['_nome'][nome] += 1
            rec['_end'][end] += 1
            rec['coords'].add((lat, lon))
            rec['cep'] = rec['cep'] or (row[idx['NR_CEP']].strip() or None)
            rec['bairro'] = rec['bairro'] or (row[idx['NM_BAIRRO']].strip() or None)
    if not meta:
        raise SourceError('TSE locais: arquivo vazio')
    meta['n_linhas'] = n_linhas
    if meta['aa_eleicao'] != '2026':
        raise SourceError(f"TSE locais: AA_ELEICAO={meta['aa_eleicao']} (esperado 2026)")
    if meta['sg_uf'] != 'SC':
        raise SourceError(f"TSE locais: SG_UF={meta['sg_uf']} (esperado SC)")
    for k, c in sec_count.items():
        if c != 2:
            raise SourceError(f'seção {k} aparece {c}x (esperado 2 no export)')
    for k, rec in locais.items():
        if len(rec['coords']) > 1:
            raise SourceError(f"local {k} com coordenadas divergentes: {rec['coords']}")
        (lat, lon) = rec['coords'].pop()
        rec['lat'], rec['lon'] = lat, lon
        rec['nome'] = _resolve_variant(rec.pop('_nome'))
        rec['end'] = _resolve_variant(rec.pop('_end'))
    return {
        'meta': meta,
        'locais': locais,
        'secoes': {k: v for k, v in sec_local.items()},
    }


# ---------------- TRE-SC ----------------

def load_tre_sc(cache_dir: str) -> dict | None:
    """Carrega a lista de locais do TRE-SC (JSON).

    :returns: dict com 'locais' (lista) ou None se indisponível.
    """
    path = os.path.join(cache_dir, 'tre_sc_locais.json')
    if not os.path.exists(path):
        return None
    d = json.load(open(path, encoding='utf-8'))
    if not isinstance(d, dict) or not isinstance(d.get('locais'), list):
        raise ValueError('TRE-SC: esquema inesperado (esperado {"locais": [...]})')
    return d


# ---------------- INEP (Censo Escolar — validação institucional) ----------------

def load_inep(cache_dir: str) -> list | None:
    """Carrega escolas do INEP 2025 (subset SC) do cache.

    O Censo Escolar não publica mais coordenadas (verificado 2023–2025):
    o papel do INEP aqui é validação institucional (a unidade existe?
    no mesmo município? mesma rua? — via subset 2024, se presente).

    :param cache_dir: cache com INEP_ESCOLAS_CSV (e opcional
        INEP_ESCOLAS_END_CSV).
    :returns: lista de dicts {nome, mun_ibge, mun_nome, co_entidade,
        situ, end (None se 2024 ausente)} ou None.
    """
    path = os.path.join(cache_dir, INEP_ESCOLAS_CSV)
    if not os.path.exists(path):
        return None
    end_by_code: dict = {}
    p24 = os.path.join(cache_dir, INEP_ESCOLAS_END_CSV)
    if os.path.exists(p24):
        import csv as _csv
        with open(p24, encoding='utf-8', newline='') as f:
            for row in _csv.DictReader(f, delimiter=';'):
                if row.get('CO_ENTIDADE'):
                    end_by_code[row['CO_ENTIDADE'].strip()] = row.get('DS_ENDERECO', '')
    import csv as _csv
    out = []
    with open(path, encoding='utf-8', newline='') as f:
        for row in _csv.DictReader(f, delimiter=';'):
            out.append({
                'nome': row['NO_ENTIDADE'].strip(),
                'mun_ibge': (row.get('CO_MUNICIPIO') or '').strip(),
                'mun_nome': (row.get('NO_MUNICIPIO') or '').strip(),
                'co_entidade': (row.get('CO_ENTIDADE') or '').strip(),
                'situ': (row.get('TP_SITUACAO_FUNCIONAMENTO') or '').strip(),
                'end': end_by_code.get(row.get('CO_ENTIDADE', '').strip()),
            })
    return out


# ---------------- OSM (extrato geofabrik PBF) ----------------

OSM_FACILITY_TAGS = {
    'amenity': {'school', 'university', 'college', 'clinic', 'hospital',
                'community_centre', 'social_centre', 'social_facility',
                'library', 'theatre', 'sports_centre', 'kindergarten',
                'crematorium'},
    'building': {'school', 'university', 'college', 'hospital', 'kindergarten',
                 'childcare', 'community_centre', 'education', 'government',
                 'public', 'social', 'sports_hall', 'sports_centre',
                 'administration', 'prison'},
    'healthcare': {'clinic', 'hospital', 'centre', 'doctor', 'pharmacy'},
    'leisure': {'community_centre', 'activity_centre', 'sports_centre',
                'sports_hall', 'stadium', 'pitch', 'playground', 'track'},
    'man_made': {'public_building', 'prison', 'memorial'},
    'office': {'government', 'ngo', 'educational_institution', 'political_party'},
    'emergency': {'prison'},
}


def _is_osm_facility(tags: dict) -> bool:
    if not tags:
        return False
    for k, vals in OSM_FACILITY_TAGS.items():
        if k in tags and vals and tags[k] in vals:
            return True
    if 'addr:street' in tags:
        return True
    return False


def extract_osm(pbf_path: str):
    """Extrai instalações nomeadas do PBF (nós e ways), em 2 passadas
    (1: nomeados + ways de interesse; 2: centroides dos ways).

    :returns: lista de dicts {kind, id, lat, lon, tags} (ways com
        coordenada = média dos vértices; documentado como aproximação).
    """
    import geo_pbf

    named_nodes = {}   # id -> (lat, lon, tags)
    wanted_refs = set()
    ways = []          # (id, [refs], tags)
    for feat in geo_pbf.iter_features(pbf_path):
        if feat['kind'] == 'node':
            t = feat['tags']
            if t.get('name') and _is_osm_facility(t):
                named_nodes[feat['id']] = (feat['lat'], feat['lon'], t)
        else:
            t = feat['tags']
            if (t.get('name') and _is_osm_facility(t)) or 'addr:street' in t:
                ways.append((feat['id'], feat['refs'], t))
                wanted_refs.update(feat['refs'])

    ref_nodes = {}
    for feat in geo_pbf.iter_features(pbf_path):
        if feat['kind'] == 'node' and feat['id'] in wanted_refs:
            ref_nodes[feat['id']] = (feat['lat'], feat['lon'])

    out = []
    for nid, (lat, lon, t) in named_nodes.items():
        out.append({'kind': 'node', 'id': nid, 'lat': lat, 'lon': lon, 'tags': t})
    for wid, refs, t in ways:
        pts = [ref_nodes[r] for r in refs if r in ref_nodes]
        if not pts:
            continue
        lon = sum(p[1] for p in pts) / len(pts)
        lat = sum(p[0] for p in pts) / len(pts)
        out.append({'kind': 'way', 'id': wid, 'lat': lat, 'lon': lon, 'tags': t})
    return out


def load_osm(cache_dir: str):
    """Carrega instalações OSM do cache.

    Prioridade: JSON em cache (osm_sc_facilities.json — artefato
    determinístico gerado a partir do PBF); senão, extrai do extrato
    geofabrik sul (2 passadas no PBF) e escreve o JSON para os próximos
    runs.

    :returns: lista de features (ordenada) ou None se indisponível.
    """
    jpath = os.path.join(cache_dir, OSM_JSON_NAME)
    if os.path.exists(jpath):
        try:
            return json.load(open(jpath, encoding='utf-8'))
        except (OSError, ValueError) as e:
            print(f'aviso: OSM JSON inválido ({e}); reextraindo do PBF',
                  file=sys.stderr)
    path = os.path.join(cache_dir, OSM_PBF_NAME)
    if os.path.exists(path) and os.path.getsize(path) > (1 << 20):
        try:
            feats = extract_osm(path)
        except Exception as e:
            print(f'aviso: falha ao ler PBF ({e})', file=sys.stderr)
            return None
        feats.sort(key=lambda f: (f['kind'], f['id']))
        tmp = jpath + '.part'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(feats, f, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'))
        os.replace(tmp, jpath)
        return feats
    return None


# --------------------------------------------------------------------------
# dados do TSE 2026 (snapshot do repositório) — seções do app
# --------------------------------------------------------------------------

def load_tse_snapshot(repo: str):
    """Carrega data/tse_2026/{index.json, secoes.json}.

    :returns: (index, secoes) onde secoes = {mun: [[tse, nome]...],
        secoes: [[munIdx, zona, secao, local, end]...]}.
    """
    base = os.path.join(repo, 'data', 'tse_2026')
    index = json.load(open(os.path.join(base, 'index.json'), encoding='utf-8'))
    secoes = json.load(open(os.path.join(base, 'secoes.json'), encoding='utf-8'))
    return index, secoes


# --------------------------------------------------------------------------
# catálogo de locais físicos + associação seção -> local
# --------------------------------------------------------------------------

class Local:
    """Um local de votação físico (estabelecimento).

    Identidade: (código TSE do município, zona, código do local
    NR_LOCAL_VOTACAO) — identificador oficial do TSE; múltiplas seções
    podem compartilhar o mesmo local.
    """

    __slots__ = ('mun_tse', 'mun_ibge', 'mun_nome', 'local_code', 'zona',
                 'nome', 'end', 'cep', 'bairro', 'situ', 'zonas', 'secoes',
                 'tre', 'coord', 'fonte', 'match', 'conf', 'status', 'obs',
                 'ref', 'cross', 'inep')

    def __init__(self, mun_tse, mun_ibge, mun_nome, zona, local_code, nome, end):
        self.mun_tse = mun_tse
        self.mun_ibge = mun_ibge
        self.mun_nome = mun_nome
        self.local_code = local_code   # NR_LOCAL_VOTACAO (TSE)
        self.zona = int(zona)
        self.nome = nome               # nome crú do TSE (como publicado)
        self.end = end                 # endereço crú do TSE
        self.cep = None
        self.bairro = None
        self.situ = '1'                # CD_SITU_LOCAL_VOTACAO (1=ativo, 5=bloqueado)
        self.zonas = set()
        self.secoes = []               # [(zona, secao)] — apenas seções do snapshot
        self.tre = None                # registro TRE-SC correspondente
        self.coord = None              # (lon, lat) WGS84 verificada
        self.fonte = None              # identificador da fonte geográfica
        self.match = None              # 'official' | 'exact' | 'core' | 'contain-unique'
        self.conf = None               # 'alta' | 'media' | 'baixa'
        self.status = 'pendente'       # 'verificado' | 'edge' | 'pendente' | 'ambiguo' | 'rejeitado'
        self.obs = []                  # observações de proveniência/validação
        self.ref = None                # id do registro-fonte (OSM id / INEP CO_ENTIDADE)
        self.cross = None              # validação cruzada OSM (distância + classe)
        self.inep = None               # validação institucional INEP (CO_ENTIDADE)

    @property
    def key(self):
        return (self.mun_tse, self.zona, self.local_code)


def build_catalog(tse_locais: dict, tse2geo: dict,
                  snap_rows: list, mun_by_idx: list) -> dict:
    """Monta o catálogo de locais físicos a partir do arquivo TSE 2026.

    :param tse_locais: saída de load_tse_locais().
    :param tse2geo: mapa {código TSE -> código IBGE}.
    :param snap_rows: seções do snapshot [[munIdx, zona, secao, local, end]...]
        (apenas estas seções entram no catálogo; as 232 seções
        "agregadas" do arquivo TSE, fora do dataset de votações, são
        contabilizadas à parte no relatório).
    :param mun_by_idx: lista [(tse, nome)] — snapshot 'mun'.
    :returns: {(mun_tse, zona, local_code): Local}.
    :raises SourceError: seção do snapshot sem local no arquivo TSE.
    """
    cat = {}
    for k, rec in tse_locais['locais'].items():
        mun_tse, zona, lcode = k
        loc = Local(mun_tse, tse2geo.get(mun_tse), rec['mun_nome'], zona, lcode,
                    rec['nome'], rec['end'])
        loc.cep = rec['cep']
        loc.bairro = rec['bairro']
        loc.situ = rec['situ']
        cat[k] = loc
    n_nome_diff = 0
    for (mi, zona, secao, local_nome, end) in snap_rows:
        mun_tse = str(mun_by_idx[mi][0])
        skey = (mun_tse, str(zona), str(secao))
        lkey = tse_locais['secoes'].get(skey)
        if lkey is None:
            raise SourceError(f'seção do snapshot {skey} ausente no arquivo TSE 2026')
        loc = cat[lkey]
        loc.zonas.add(int(zona))
        loc.secoes.append((int(zona), int(secao)))
        if norm(local_nome) != norm(loc.nome):
            n_nome_diff += 1
            if n_nome_diff <= 10:
                loc.obs.append(f"grafia do snapshot difere: '{local_nome}'")
    return cat


def assign_coords_tse(cat: dict, tse_locais: dict) -> dict:
    """Atribui as coordenadas oficiais do TSE a todos os locais.

    A coordenada oficial (NR_LATITUDE/NR_LONGITUDE do eleitorado por
    local de votação) é a fonte primária — autoritativa tanto para a
    associação seção → local quanto para a posição geográfica.
    Sentinela -1,-1 (ou vazia) -> sem coordenada (status 'pendente',
    candidato a preenchimento OSM).

    :returns: stats {'com_coord', 'sem_coord'}.
    """
    stats = collections.Counter()
    for k, loc in cat.items():
        rec = tse_locais['locais'][k]
        lat, lon = rec['lat'], rec['lon']
        if lat is None or lon is None:
            loc.status = 'pendente'
            loc.obs.append('sem coordenada no TSE (sentinela -1,-1)')
            stats['sem_coord'] += 1
            continue
        loc.coord = (round(lon, 6), round(lat, 6))
        loc.fonte = 'TSE 2026 (eleitorado por local de votação)'
        loc.match = 'official'
        loc.conf = 'alta'
        loc.status = 'verificado'
        loc.ref = f"TSE local {k[2]}"
        stats['com_coord'] += 1
    return dict(stats)


# ---------------- correspondência de nomes (camadas) ----------------

def name_tiers(a_norm: str, b_norm: str) -> str | None:
    """Classe de match de dois nomes normalizados.

    :returns: 'exact' | 'core' | 'contain-unique' (requer unicidade no
        conjunto de candidatos) | None.
    """
    if not a_norm or not b_norm:
        return None
    if a_norm == b_norm:
        return 'exact'
    ca, cb = core(a_norm), core(b_norm)
    if len(ca) >= 6 and ca == cb:
        return 'core'
    if a_norm in b_norm or b_norm in a_norm:
        short = min(len(a_norm), len(b_norm))
        if short >= 8:
            return 'contain-unique'
    if ca and cb and (ca in cb or cb in ca):
        short = min(len(ca), len(cb))
        if short >= 6:
            return 'contain-unique'
    return None


TIER_RANK = {'exact': 3, 'core': 2, 'contain-unique': 1}


def best_match(query_norm: str, query_street: str | None,
               cand) -> tuple[str | None, list]:
    """Melhor correspondência de um nome local em um conjunto de
    candidatos (escolas INEP ou features OSM) do mesmo município.

    :param query_norm: nome do local (norm).
    :param query_street: núcleo da rua do endereço do local (ou None).
    :param cand: iterável de dicts com 'nome_norm', 'street', 'rec'.
    :returns: (tier, [candidatos_no_top_tier]) — (None, []) se nada.
    """
    best_tier = None
    best_cands = []
    for c in cand:
        t = name_tiers(query_norm, c['nome_norm'])
        if t is None:
            continue
        if best_tier is None or TIER_RANK[t] > TIER_RANK[best_tier]:
            best_tier = t
            best_cands = [c]
        elif TIER_RANK[t] == TIER_RANK[best_tier]:
            best_cands.append(c)
    if best_tier is None:
        return None, []
    # desempate por rua no tier 'contain-unique' (e confirmação nos demais)
    if query_street:
        with_street = [c for c in best_cands if c['street'] and c['street'] == query_street]
        if with_street and len(with_street) < len(best_cands):
            best_cands = with_street
    return best_tier, best_cands


def _osm_by_mun(osm_feats: list | None, feats, rings_by_code: dict) -> dict:
    """Indexa instalações OSM por município (IBGE) via PIP na malha.

    Features fora de todo polígono: município mais próximo, se a menos
    de 1,5 km (fronteira); senão descartadas.
    """
    by_mun: dict = collections.defaultdict(list)
    if not osm_feats:
        return by_mun
    bboxes = mun_bboxes(feats)
    # bbox da malha SC (união) + margem ~15 km: exclui RS/PR do extrato
    # sem custo; o que sobrar dentro da malha ou da margem é resolvido
    # por PIP / vizinhança.
    u_minx = min(b[0] for b in bboxes.values())
    u_miny = min(b[1] for b in bboxes.values())
    u_maxx = max(b[2] for b in bboxes.values())
    u_maxy = max(b[3] for b in bboxes.values())
    margin = 0.15
    for f in osm_feats:
        lat, lon = f['lat'], f['lon']
        if not (u_minx - margin <= lon <= u_maxx + margin
                and u_miny - margin <= lat <= u_maxy + margin):
            continue
        mun = point_municipality(feats, lat, lon, rings_by_code, bboxes)
        if mun is None:
            mun = nearest_municipality(feats, lat, lon, rings_by_code, bboxes)
            if mun is None or haversine_m(lon, lat, *mun[1]) > 1500:
                continue
            mun = mun[0]
        by_mun[mun].append({
            'nome_norm': norm(f['tags'].get('name', '')),
            'street': street_of(f['tags'].get('addr:street', '')),
            'housenum': norm(f['tags'].get('addr:housenumber', '')),
            'rec': f,
        })
    return by_mun


def gap_fill_osm(cat: dict, osm_feats: list | None, feats,
                 rings_by_code: dict) -> dict:
    """Preenche lacunas: locais SEM coordenada oficial do TSE.

    Estratégia: match de nome (mesmas camadas) contra instalações OSM
    do mesmo município; exige unicidade no top tier. Sem match único ->
    permanece 'pendente' (nunca inventa coordenada).

    :returns: stats {'preenchido', 'sem_match', 'ambiguo', 'sem_fonte'}.
    """
    stats = collections.Counter()
    pendentes = [l for l in cat.values() if l.coord is None]
    if not pendentes:
        return dict(stats)
    if not osm_feats:
        stats['sem_fonte'] = len(pendentes)
        return dict(stats)
    by_mun = _osm_by_mun(osm_feats, feats, rings_by_code)
    for loc in pendentes:
        cands = by_mun.get(loc.mun_ibge, [])
        if not cands:
            stats['sem_match'] += 1
            continue
        tier, hits = best_match(norm(loc.nome), street_of(loc.end), cands)
        if tier is None:
            stats['sem_match'] += 1
            continue
        if len(hits) > 1:
            stats['ambiguo'] += 1
            loc.status = 'ambiguo'
            loc.obs.append('ambiguo OSM: ' + ' | '.join(
                h['rec']['tags'].get('name', '?')[:40] for h in hits[:4]))
            continue
        f = hits[0]['rec']
        loc.coord = (round(f['lon'], 6), round(f['lat'], 6))
        loc.fonte = 'OSM (geofabrik)'
        loc.match = tier
        loc.conf = 'alta' if tier == 'exact' else 'media'
        loc.status = 'verificado'
        loc.ref = f"OSM:{f['kind']}/{f['id']}"
        loc.obs.append(f"coordenada por OSM (TSE sem coordenada): {f['tags'].get('name', '')}")
        stats['preenchido'] += 1
    return dict(stats)


def link_tre_sc(cat: dict, tre: dict | None) -> dict:
    """Cruza o catálogo com a API de locais do TRE-SC (validação de
    proveniência: zona, endereço, CEP, bairro, código do local).

    Casamento: mesmo município (norm) + mesmo nome local (norm). Quando
    há mais de um registro TRE-SC com o mesmo nome no município, o
    casamento exige igualdade de rua. Não altera coordenadas.

    :returns: stats {n_matched, n_unmatched, n_ambig, n_zona_diff}.
    """
    stats = {'n_matched': 0, 'n_unmatched': 0, 'n_ambig': 0, 'n_zona_diff': 0}
    if not tre:
        stats['n_unmatched'] = len(cat)
        return stats
    by_mun = collections.defaultdict(list)
    for l in tre['locais']:
        by_mun[norm(l['municipio'])].append(l)
    for loc in cat.values():
        cands = by_mun.get(norm(loc.mun_nome), [])
        if not cands:
            stats['n_unmatched'] += 1
            continue
        hits = [l for l in cands if norm(l['nome_local_votacao']) == norm(loc.nome)]
        if not hits:
            stats['n_unmatched'] += 1
            continue
        if len(hits) > 1:
            s_loc = street_of(loc.end)
            hits2 = [h for h in hits if s_loc and street_of(h.get('endereco')) == s_loc]
            if len(hits2) == 1:
                hits = hits2
            elif len(hits2) != len(hits) and hits2:
                hits = hits2
            if len(hits) != 1:
                stats['n_ambig'] += 1
                continue
        h = hits[0]
        loc.tre = h
        stats['n_matched'] += 1
        ztre = int(h['zona_eleitoral'])
        if ztre not in loc.zonas:
            stats['n_zona_diff'] += 1
            loc.obs.append(f"TRE-SC zona={ztre} (TSE 2026 zonas={sorted(loc.zonas)})")
        if h.get('bairro'):
            loc.obs.append(f"bairro={h['bairro']}")
        if h.get('cep'):
            loc.obs.append(f"cep={h['cep']}")
    return stats


def cross_validate_osm(cat: dict, osm_feats: list | None, feats,
                       rings_by_code: dict) -> dict:
    """Verificação INDEPENDENTE das coordenadas oficiais contra o OSM.

    Para cada local com coordenada: procura instalação OSM com o mesmo
    nome no mesmo município (mesmas camadas de match; exige unicidade
    no top tier). Distância entre a coordenada oficial e a feature OSM:
      - <= CROSS_OK_M (150 m)  -> 'confirma';
      - <= CROSS_OBS_M (500 m) -> 'observar';
      - acima                  -> 'conflito' (flag; NUNCA realoca).
    Tier 'contain-unique' só gera 'observar' (evidência fraca).
    Nunca altera a coordenada oficial.

    :returns: stats {confirma, observar, conflito, ambiguo, sem_osm}.
    """
    stats = collections.Counter()
    if not osm_feats:
        stats['sem_osm'] = sum(1 for l in cat.values() if l.coord)
        return dict(stats)
    by_mun = _osm_by_mun(osm_feats, feats, rings_by_code)
    for loc in cat.values():
        if loc.coord is None:
            continue
        cands = [c for c in by_mun.get(loc.mun_ibge, []) if c['nome_norm']]
        if not cands:
            stats['sem_osm'] += 1
            continue
        tier, hits = best_match(norm(loc.nome), street_of(loc.end), cands)
        if tier is None:
            stats['sem_osm'] += 1
            continue
        if len(hits) > 1:
            stats['ambiguo'] += 1
            continue
        f = hits[0]['rec']
        d = haversine_m(loc.coord[0], loc.coord[1], f['lon'], f['lat'])
        strong = tier in ('exact', 'core')
        if not strong and d > CROSS_OK_M:
            loc.cross = ('observar', round(d, 1), f"OSM:{f['kind']}/{f['id']} ({tier})")
            stats['observar'] += 1
        elif d <= CROSS_OK_M:
            loc.cross = ('confirma', round(d, 1), f"OSM:{f['kind']}/{f['id']}")
            stats['confirma'] += 1
        elif d <= CROSS_OBS_M:
            loc.cross = ('observar', round(d, 1), f"OSM:{f['kind']}/{f['id']} ({tier})")
            stats['observar'] += 1
        else:
            loc.cross = ('conflito', round(d, 1), f"OSM:{f['kind']}/{f['id']} ({tier})")
            loc.obs.append(f'conflito OSM: {d:.0f} m ({tier}) — coordenada oficial mantida')
            stats['conflito'] += 1
    return dict(stats)


def cross_check_inep(cat: dict, inep: list | None, feats) -> dict:
    """Validação INSTITUCIONAL contra o Censo Escolar INEP 2025.

    O INEP não publica coordenadas desde 2023 — aqui valida que a
    unidade existe no mesmo município (match de nome) e, quando o
    subset 2024 (endereços) está presente, a consistência de rua.
    Nunca altera coordenadas; registra CO_ENTIDADE em loc.inep.

    :returns: stats {confirma, parcial, ambiguo, sem_inep, sem_fonte}.
    """
    stats = collections.Counter()
    if not inep:
        stats['sem_fonte'] = len(cat)
        return dict(stats)
    inep_by_mun: dict = collections.defaultdict(list)
    for r in inep:
        ibge = r.get('mun_ibge', '')
        if ibge and len(ibge) >= 7 and ibge[:7].isdigit():
            inep_by_mun[ibge[:7]].append({
                'nome_norm': norm(r['nome']),
                'street': street_of(r.get('end')) if r.get('end') else None,
                'rec': r,
            })
    for loc in cat.values():
        cands = inep_by_mun.get(loc.mun_ibge)
        if not cands:
            stats['sem_inep'] += 1
            continue
        tier, hits = best_match(norm(loc.nome), street_of(loc.end), cands)
        if tier is None:
            stats['sem_inep'] += 1
            continue
        if len(hits) > 1:
            stats['ambiguo'] += 1
            continue
        r = hits[0]['rec']
        s_loc = street_of(loc.end)
        s_r = hits[0]['street']
        street_conflict = s_loc and s_r and s_loc != s_r
        code = r.get('co_entidade', '')
        if tier == 'exact' and not street_conflict:
            loc.inep = code
            stats['confirma'] += 1
        elif tier == 'core' and (not (s_loc and s_r) or s_loc == s_r):
            loc.inep = code
            stats['parcial'] += 1
        elif tier == 'contain-unique' and (not s_loc or not s_r or s_loc == s_r):
            loc.inep = code
            stats['parcial'] += 1
        else:
            loc.obs.append(f"INEP: match {tier} com ressalva"
                           + (f" (rua divergente: {r.get('end')})" if street_conflict else ''))
            stats['parcial'] += 1
    return dict(stats)


def mun_bboxes(feats) -> dict:
    """Bbox (min_lon, min_lat, max_lon, max_lat) por código IBGE.

    Pré-filtro de contenção: ponto dentro do polígono implica ponto
    dentro da bbox — rejeição por bbox nunca muda o resultado, só
    acelera o PIP (malha de 295 municípios x 10^5 pontos OSM)."""
    out = {}
    for code, _nome, rings in feats:
        x1 = y1 = float('inf')
        x2 = y2 = float('-inf')
        for ring in rings:
            for x, y in ring:
                if x < x1: x1 = x
                if x > x2: x2 = x
                if y < y1: y1 = y
                if y > y2: y2 = y
        out[code] = (x1, y1, x2, y2)
    return out


def point_municipality(feats, lat, lon, rings_by_code=None, bboxes=None):
    """Município (código IBGE) cujo polígono (união de anéis) contém o
    ponto, ou None. Itera as features na ordem da malha (ordem de
    desempate igual à malha; bbox só elimina candidatos impossíveis).

    :param bboxes: dict código -> bbox (opcional, acelera o PIP)."""
    for code, _nome, rings in feats:
        if bboxes is not None:
            x1, y1, x2, y2 = bboxes[code]
            if not (x1 <= lon <= x2 and y1 <= lat <= y2):
                continue
        if in_any_ring(rings, lon, lat):
            return code
    return None


def nearest_municipality(feats, lat, lon, rings_by_code=None, bboxes=None):
    """Município mais próximo do ponto (distância exata ponto-segmento).

    Correção 2026-10: a versão anterior nunca retornava nada (o loop
    interno comparava a distância amostrada contra o próprio mínimo já
    atribuído), o que quebrava a regra de fronteira de 1,5 km em
    _osm_by_mun. Implementação em 2 estágios: (1) cota inferior por
    bbox em todos os municípios (barata); (2) distância exata somente
    nos candidatos cuja cota por bbox fica até 1,5 km da melhor cota
    (a tolerância de fronteira é bem menor que essa margem, então a
    cota é suficiente para descarta sem perder o vencedor).

    :param feats: lista [(código IBGE, nome, anéis), ...].
    :param lat: latitude do ponto (graus).
    :param lon: longitude do ponto (graus).
    :param bboxes: dict código -> bbox (opcional; se ausente, calculada).
    :returns: (código IBGE, (lon, lat) do ponto do anel mais próximo)
        ou None se o ponto está longe de todos os anéis.
    """
    if bboxes is None:
        bboxes = mun_bboxes(feats)
    best_bbox = float('inf')
    for code, _nome, _rings in feats:
        x1, y1, x2, y2 = bboxes[code]
        cx = min(max(lon, x1), x2)
        cy = min(max(lat, y1), y2)
        d = haversine_m(lon, lat, cx, cy)
        if d < best_bbox:
            best_bbox = d
    best = None
    best_d = float('inf')
    for code, _nome, rings in feats:
        x1, y1, x2, y2 = bboxes[code]
        cx = min(max(lon, x1), x2)
        cy = min(max(lat, y1), y2)
        if haversine_m(lon, lat, cx, cy) > best_bbox + 1500.0:
            continue
        d, pt = _closest_pt_ring(rings, lon, lat)
        if d < best_d:
            best_d = d
            best = (code, pt)
    return best


# --------------------------------------------------------------------------
# validação geográfica
# --------------------------------------------------------------------------

def validate(cat: dict, feats, rings_by_code: dict) -> dict:
    """Valida as coordenadas atribuídas e o catálogo.

    Verifica (documentado no relatório):
      - WGS84 dentro do bbox de SC (detecta trocas lat/lon grosseiras);
      - contenção no polígono do município (PIP independente);
        <= EDGE_MUN_M fora -> status 'edge' (manter, com flag);
        senão 'pendente' (verificação manual — NUNCA realoca);
      - duplicidade de identidade de seção no mesmo local;
      - coordenada idêntica para locais distintos (informativo).

    :returns: stats {valid, edge, out_mun, swap, rejeitado, sem_coord,
        dup_secao, coord_compartilhada}.
    """
    # obs de classificação re-aplicáveis (validate() é re-executável
    # idempotentemente): remove a versão anterior antes de re-adicionar
    _CLASS_OBS = (re.compile(r'^a \d+ m do polígono \(fronteira/ilha\)$'),
                  re.compile(r'^fora do polígono do município \(\d+ m\) — verificar'),
                  re.compile(r'^seção duplicada no local$'))

    def _strip_class_obs(l):
        l.obs = [o for o in l.obs if not any(p.match(str(o)) for p in _CLASS_OBS)]

    stats = collections.Counter()
    seen_coord: dict = collections.defaultdict(list)
    for loc in cat.values():
        if len(loc.secoes) != len({(z, s) for z, s in loc.secoes}):
            stats['dup_secao'] += 1
            _strip_class_obs(loc)
            loc.status = 'pendente'
            loc.obs.append('seção duplicada no local')
            continue
        if loc.coord is None:
            stats['sem_coord'] += 1
            continue
        lon, lat = loc.coord
        if not (SC_BBOX[0] <= lon <= SC_BBOX[2] and SC_BBOX[1] <= lat <= SC_BBOX[3]):
            if (SC_BBOX[0] <= lat <= SC_BBOX[2] and SC_BBOX[1] <= lon <= SC_BBOX[3]):
                stats['swap'] += 1
                loc.obs.append('suspeita de lat/lon trocado (não corrigido automaticamente)')
            loc.coord = None
            loc.status = 'rejeitado'
            stats['rejeitado'] += 1
            continue
        stats['valid'] += 1
        if loc.mun_ibge:
            rings = rings_by_code.get(loc.mun_ibge, [])
            if not in_any_ring(rings, lon, lat):
                d = min((dist_to_ring_m(r, lon, lat) for r in rings), default=float('inf'))
                if d <= EDGE_MUN_M:
                    _strip_class_obs(loc)
                    loc.status = 'edge'
                    loc.obs.append(f'a {d:.0f} m do polígono (fronteira/ilha)')
                    stats['edge'] += 1
                else:
                    # NUNCA realoca: coordenada não verificável (fora do
                    # polígono além da tolerância) não é publicada; a
                    # coordenada oficial do TSE fica registrada para
                    # revisão manual (pendentes.json traz obs).
                    _strip_class_obs(loc)
                    loc.obs.append(f'fora do polígono do município ({d:.0f} m) '
                                   f'— verificar; coord oficial TSE: {lon},{lat}')
                    loc.status = 'pendente'
                    loc.coord = None
                    stats['out_mun'] += 1
        if loc.coord is not None:
            seen_coord[loc.coord].append(loc)
    stats['coord_compartilhada'] = sum(len(v) for v in seen_coord.values() if len(v) > 1)
    return dict(stats)


# --------------------------------------------------------------------------
# revisões manuais auditáveis (manifesto versionado sync/geo_overrides.json)
# --------------------------------------------------------------------------

def load_overrides(path: str) -> dict:
    """Carrega e valida em falha-dura o manifesto de revisões manuais.

    Esquema (versao "1"): {"versao", "descricao", "overrides": [
      {"local": {"mun_tse", "zona", "local_code"}, "nome_esperado",
       "veredito" ("corrigir" | "documentar"),
       "coord": [lon, lat] (obrigatória em "corrigir", ausente/None em
       "documentar"), "motivo", "revisado_em",
       "evidencia": [{"fonte", "url", "acesso_em", "detalhe"}, ...]}]}.

    :param path: caminho do manifesto JSON.
    :returns: dict do manifesto validado.
    :raises SourceError: arquivo ausente, versao diferente, local
        incompleto/duplicado, nome/motivo/revisado_em ausentes,
        evidência incompleta, veredito inválido, corrigir sem coord
        (ou coord fora do bbox de SC) ou documentar com coord.
    """
    if not os.path.exists(path):
        raise SourceError(f'manifesto de revisões ausente: {path}')
    d = json.load(open(path, encoding='utf-8'))
    if not isinstance(d, dict) or d.get('versao') != '1':
        raise SourceError('manifesto de revisões: versao != "1"')
    ovs = d.get('overrides')
    if not isinstance(ovs, list):
        raise SourceError('manifesto de revisões: "overrides" não é lista')
    seen: set = set()
    for i, o in enumerate(ovs):
        where = f'manifesto[overrides][{i}]'
        if not isinstance(o, dict):
            raise SourceError(f'{where}: não é objeto')
        loc = o.get('local')
        if not isinstance(loc, dict):
            raise SourceError(f'{where}: "local" ausente')
        key = tuple(str(loc.get(k, '') or '') for k in ('mun_tse', 'zona', 'local_code'))
        if any(not v for v in key):
            raise SourceError(f'{where}: local incompleto {key}')
        if key in seen:
            raise SourceError(f'{where}: local duplicado {key}')
        seen.add(key)
        if not str(o.get('nome_esperado') or '').strip():
            raise SourceError(f'{where}: nome_esperado ausente')
        if not str(o.get('motivo') or '').strip():
            raise SourceError(f'{where}: motivo ausente')
        if not str(o.get('revisado_em') or '').strip():
            raise SourceError(f'{where}: revisado_em ausente')
        v = o.get('veredito')
        if v not in ('corrigir', 'documentar'):
            raise SourceError(f'{where}: veredito inválido {v!r}')
        ev = o.get('evidencia')
        if not isinstance(ev, list) or not ev:
            raise SourceError(f'{where}: evidencia ausente/vazia')
        for j, e in enumerate(ev):
            if not isinstance(e, dict) or not str(e.get('fonte') or '').strip() \
                    or not str(e.get('detalhe') or '').strip() \
                    or not str(e.get('acesso_em') or '').strip():
                raise SourceError(f'{where}: evidencia[{j}] incompleta')
        c = o.get('coord')
        if v == 'corrigir':
            if not (isinstance(c, list) and len(c) == 2
                    and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in c)):
                raise SourceError(f'{where}: veredito corrigir exige coord [lon, lat]')
            lon, lat = float(c[0]), float(c[1])
            if not (SC_BBOX[0] <= lon <= SC_BBOX[2] and SC_BBOX[1] <= lat <= SC_BBOX[3]):
                raise SourceError(f'{where}: coord {c} fora do bbox de SC')
        elif c is not None:
            raise SourceError(f'{where}: veredito documentar não pode ter coord')
    return d


def apply_overrides(cat: dict, manifest: dict, lenient: bool = False) -> dict:
    """Aplica revisões manuais ao catálogo (DEPOIS do pipeline
    automático; a validação geográfica é re-executada em seguida para
    classificar as coordenadas revisadas pelo mesmo PIP/bbox).

    - veredito 'corrigir': substitui a coordenada pela revisada — a
      coordenada original, quando havia, fica preservada em obs;
    - veredito 'documentar': só registra o parecer em obs (ex.: pendente
      mantido por ausência de evidência, conflito OSM analisado e
      resolvido em favor da coordenada oficial) — nenhuma coordenada
      muda.

    :param cat: catálogo {(mun_tse, zona, local_code): Local}.
    :param manifest: saída de load_overrides().
    :param lenient: se True, ignora locais ausentes do catálogo
        (modo --only/debug); nome divergente SEMPRE falha.
    :returns: stats {'n', 'corrigir', 'documentar', 'aplicados'}.
    :raises SourceError: local inexistente (não lenient) ou
        nome_esperado divergente do nome publicado pelo TSE.
    """
    stats = {'n': len(manifest['overrides']), 'corrigir': 0,
             'documentar': 0, 'aplicados': []}
    for o in manifest['overrides']:
        key = (str(o['local']['mun_tse']), str(o['local']['zona']),
               str(o['local']['local_code']))
        loc = cat.get(key)
        if loc is None:
            if lenient:
                continue
            raise SourceError(f'override: local inexistente no catálogo {key}')
        if norm(o['nome_esperado']) != norm(loc.nome):
            raise SourceError(f'override {key}: nome_esperado '
                              f'{o["nome_esperado"]!r} != catálogo {loc.nome!r}')
        if o['veredito'] == 'corrigir':
            lon, lat = (float(v) for v in o['coord'])
            if loc.coord is not None:
                loc.obs.append(f'coord oficial TSE anterior: '
                               f'{loc.coord[0]},{loc.coord[1]} (preservada em obs)')
            loc.coord = (round(lon, 6), round(lat, 6))
            loc.fonte = 'revisão manual (sync/geo_overrides.json)'
            loc.match = 'override'
            loc.conf = 'alta'
            loc.status = 'verificado'  # re-classificado por validate() em seguida
            loc.ref = f'override:{key[0]}/{key[1]}/{key[2]}'
            stats['corrigir'] += 1
        else:
            stats['documentar'] += 1
        loc.obs.append(f'revisão manual {o["veredito"]} ({o["revisado_em"]}): {o["motivo"]}')
        for e in o['evidencia']:
            url = str(e.get('url') or '')
            loc.obs.append(f'evidência: {e["fonte"]}'
                           + (f' | {url}' if url else '')
                           + f' | acesso {e["acesso_em"]} | {e["detalhe"]}')
        stats['aplicados'].append(f'{key[0]}/{key[1]}/{key[2]}')
    stats['aplicados'].sort()
    return stats


# --------------------------------------------------------------------------
# publicação (JSON determinístico)
# --------------------------------------------------------------------------

def publish(cat: dict, out_dir: str, tse_index: dict,
            fontes: dict, stats: dict, report_path: str,
            n_sec_snap: int, n_sec_agregadas: int) -> dict:
    """Escreve data/geo_loc/{index,locais,secoes,pendentes}.json + relatório.

    Esquema de linhas de locais.json (o front lê índices 3..12):
      [0] idx, [1] mun_tse, [2] mun_ibge, [3] mun_nome, [4] nome,
      [5] end, [6] zonas[], [7] secoes[[z,s]], [8] [lon,lat]|null,
      [9] fonte, [10] match, [11] conf, [12] status, [13] ref,
      [14] local_code (NR_LOCAL_VOTACAO TSE), [15] obs[].

    :returns: resumo {n_locais, n_verified, n_sec, n_sec_verified}.
    """
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    items = sorted(cat.values(),
                   key=lambda l: (l.mun_tse, l.zona, l.local_code))
    for l in items:
        if l.status in ('pendente', 'ambiguo', 'rejeitado') and l.coord is not None:
            raise RuntimeError(
                f'publicação bloqueada: local {l.key} status={l.status} '
                f'com coordenada (invariante: sem coord publicada sem verificação)')
        if l.status in ('verificado', 'edge') and l.coord is None:
            raise RuntimeError(
                f'publicação bloqueada: local {l.key} status={l.status} sem coordenada')
    n_verified = sum(1 for l in items if l.status in ('verificado', 'edge'))
    n_sec_verified = sum(len(l.secoes) for l in items if l.status in ('verificado', 'edge'))
    n_sec_total = sum(len(l.secoes) for l in items)

    locais = []
    for i, l in enumerate(items):
        coord = list(l.coord) if l.coord else None
        locais.append([
            i, l.mun_tse, l.mun_ibge or '', l.mun_nome, l.nome, l.end,
            sorted(l.zonas), l.secoes, coord, l.fonte or '', l.match or '',
            l.conf or '', l.status, l.ref or '', l.local_code,
            [str(o) for o in l.obs],
        ])
    sec2loc = []
    for i, l in enumerate(items):
        for (z, s) in l.secoes:
            sec2loc.append([l.mun_tse, z, s,
                            i if l.status in ('verificado', 'edge') else -1])
    sec2loc.sort(key=lambda r: (r[0], r[1], r[2]))

    gerado_em = _gerado_em(tse_index, fontes)
    index = {
        'titulo': 'Catálogo de georreferenciamento dos locais de votação — SC 2026',
        'versao': '2',
        'eleicao': ELEICAO,
        'gerado_em': gerado_em,
        'secao2local': 'secoes.json',
        'locais': 'locais.json',
        'status_legenda': {
            'verificado': 'coordenada verificada do local (oficial TSE; OSM só em lacunas)',
            'edge': 'verificada; até 500 m do polígono do município (fronteira/ilha)',
            'pendente': 'sem coordenada verificada (revisão manual / fonte ausente)',
            'ambiguo': 'correspondência ambígua (múltiplos candidatos)',
            'rejeitado': 'coordenada rejeitada em validação (fora do estado/troca)',
        },
        'fontes': fontes,
        'cobertura': {
            'municipios': 295,
            'locais_totais': len(items),
            'locais_verificados': n_verified,
            'secoes_totais': n_sec_total,
            'secoes_verificadas': n_sec_verified,
            'secoes_agregadas_fora_dataset': n_sec_agregadas,
        },
    }
    _write_json(os.path.join(out_dir, 'index.json'), index)
    _write_json(os.path.join(out_dir, 'locais.json'),
                {'versao': '2', 'eleicao': ELEICAO, 'locais': locais})
    _write_json(os.path.join(out_dir, 'secoes.json'),
                {'versao': '2', 'eleicao': ELEICAO, 'secao2local': sec2loc})
    pend = [
        {'mun_tse': l.mun_tse, 'municipio': l.mun_nome, 'local_code': l.local_code,
         'nome': l.nome, 'end': l.end, 'zonas': sorted(l.zonas),
         'secoes': l.secoes, 'status': l.status, 'obs': l.obs}
        for l in items if l.status in ('pendente', 'ambiguo', 'rejeitado')
    ]
    _write_json(os.path.join(out_dir, 'pendentes.json'),
                {'total': len(pend), 'registros': pend})

    report = _build_report(items, stats, fontes, gerado_em,
                           n_sec_snap, n_sec_agregadas)
    _write_json(report_path, report)
    return {
        'n_locais': len(items),
        'n_verified': n_verified,
        'n_sec': n_sec_total,
        'n_sec_verified': n_sec_verified,
    }


def _gerado_em(tse_index: dict, fontes: dict) -> str:
    """Timestamp determinístico: DT_GERACAO do TSE + hashes das fontes."""
    tse_g = (tse_index or {}).get('gerado_em', '')
    parts = [ELEICAO, tse_g]
    for k in sorted(fontes):
        f = fontes[k] or {}
        parts.append(f.get('sha256') or f.get('md5') or f.get('versao') or f.get('dt_geracao', '') or '')
    return '|'.join(str(p) for p in parts if p)


def _build_report(items, stats: dict, fontes: dict, gerado_em: str,
                  n_sec_snap: int, n_sec_agregadas: int) -> dict:
    """Relatório de cobertura (machine-readable) — distingue:
    associação oficial, geocodificação oficial TSE, verificação
    independente (OSM/INEP/TRE-SC) e não resolvidos."""
    n_sec_total = sum(len(l.secoes) for l in items)
    n_sec_verified = sum(len(l.secoes) for l in items if l.status in ('verificado', 'edge'))
    n_verified = sum(1 for l in items if l.status in ('verificado', 'edge'))
    n_mun = len({l.mun_tse for l in items})
    osm = stats.get('osm_cross', {})
    inep = stats.get('inep', {})
    tre = stats.get('tre_sc', {})
    mun_cov: dict = collections.defaultdict(lambda: {'sec': 0, 'sec_v': 0, 'loc': 0, 'loc_v': 0, 'nome': ''})
    for l in items:
        m = mun_cov[l.mun_tse]
        m['sec'] += len(l.secoes)
        m['loc'] += 1
        m['nome'] = l.mun_nome
        if l.status in ('verificado', 'edge'):
            m['sec_v'] += len(l.secoes)
            m['loc_v'] += 1
    por_municipio = {
        k: {'municipio': v['nome'], 'secoes': v['sec'], 'secoes_verificadas': v['sec_v'],
            'locais': v['loc'], 'locais_verificados': v['loc_v']}
        for k, v in sorted(mun_cov.items())
    }
    return {
        'gerado_em': gerado_em,
        'eleicao': ELEICAO,
        'fontes': fontes,
        'resumo': {
            'municipios_total': 295,
            'municipios_com_locais': n_mun,
            'secoes_dataset_app': n_sec_snap,
            'secoes_associadas_local_oficial': n_sec_total,
            'secoes_verificadas': n_sec_verified,
            'secoes_sem_coordenada': n_sec_total - n_sec_verified,
            'secoes_agregadas_fora_dataset': n_sec_agregadas,
            'locais_distintos': len(items),
            'locais_verificados': n_verified,
            'locais_por_match': _count_by(items, lambda l: l.match),
            'locais_por_status': _count_by(items, lambda l: l.status),
            'cobertura_por_local_pct': round(100.0 * n_verified / len(items), 2) if items else 0,
            'cobertura_por_secao_pct': round(100.0 * n_sec_verified / n_sec_total, 2) if n_sec_total else 0,
            'categorias': {
                'associacao_oficial_tse': n_sec_total,
                'geocodificado_oficial_tse': sum(1 for l in items
                                                 if l.match == 'official'),
                'geocodificado_osm': sum(1 for l in items
                                         if l.match and l.match != 'official'),
                'verificacao_independente_osm': osm,
                'verificacao_institucional_inep': inep,
                'crosscheck_tre_sc': tre,
                'revisoes_manuais': stats.get('overrides', {}),
                'nao_resolvidos': sum(1 for l in items
                                      if l.status in ('pendente', 'ambiguo', 'rejeitado')),
            },
            'validacao': stats.get('validacao', {}),
            'tse_locais': stats.get('tse_locais', {}),
        },
        'por_municipio': por_municipio,
    }


def _count_by(items, keyfn) -> dict:
    c = collections.Counter((keyfn(l) or 'nenhuma') for l in items)
    return dict(sorted(c.items()))


def _write_json(path: str, obj) -> None:
    """Escreve JSON determinístico (sorteia chaves, sem espaços extras)."""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        f.write('\n')


# --------------------------------------------------------------------------
# aquisição das fontes ausentes
# --------------------------------------------------------------------------

def _extract_tse_locals_csv(zip_path: str, cache_dir: str) -> str:
    """Extrai o CSV do SC do zip oficial TSE para o cache (determinístico)."""
    out = os.path.join(cache_dir, TSE_LOCALS_CSV)
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if n.endswith(TSE_LOCALS_CSV)]
        if not names:
            raise SourceError(f'{TSE_LOCALS_CSV} não encontrado no zip')
        with z.open(names[0]) as src, open(out + '.part', 'wb') as dst:
            dst.write(src.read())
    os.replace(out + '.part', out)
    return out


def _extract_inep_subset(zip_path: str, tbl: str, out_path: str,
                         cols: list, sep: str = ';') -> int:
    """Extrai o subset SC de uma tabela do Censo Escolar (determinístico)."""
    import csv as _csv
    n = 0
    tmp = out_path + '.part'
    with zipfile.ZipFile(zip_path) as z, open(tmp, 'w', encoding='utf-8', newline='') as o:
        w = _csv.writer(o, delimiter=sep)
        w.writerow(cols)
        with z.open(tbl) as src:
            for line in src:
                line = line.decode('latin-1')
                parts = line.rstrip('\r\n').split(sep)
                # SG_UF é sempre a 5ª coluna (índice 4) nas tabelas 2024/2025
                if len(parts) <= 4 or parts[4].strip() != 'SC':
                    continue
                w.writerow([parts[i].strip() for i in cols_idx(tbl, cols, len(parts))])
                n += 1
    os.replace(tmp, out_path)
    return n


def cols_idx(tbl: str, cols: list, n_parts: int) -> list:
    """Índices das colunas (layout fixo das tabelas do Censo Escolar).

    2025 (Tabela_Escola): SG_UF=4, CO_MUNICIPIO=7, NO_MUNICIPIO=6,
        NO_ENTIDADE=16, CO_ENTIDADE=17, TP_SITUACAO_FUNCIONAMENTO=23.
    2024 (microdados_ed_basica): SG_UF=4, CO_MUNICIPIO=7,
        NO_MUNICIPIO=6, NO_ENTIDADE=18, CO_ENTIDADE=19,
        DS_ENDERECO=24, NU_ENDERECO=25, NO_BAIRRO=27.
    """
    layout25 = {'SG_UF': 4, 'CO_MUNICIPIO': 7, 'NO_MUNICIPIO': 6,
                'NO_ENTIDADE': 16, 'CO_ENTIDADE': 17,
                'TP_SITUACAO_FUNCIONAMENTO': 23}
    layout24 = {'SG_UF': 4, 'CO_MUNICIPIO': 7, 'NO_MUNICIPIO': 6,
                'NO_ENTIDADE': 18, 'CO_ENTIDADE': 19,
                'DS_ENDERECO': 24, 'NU_ENDERECO': 25, 'NO_BAIRRO': 27}
    layout = layout25 if '2025' in tbl else layout24
    return [layout[c] for c in cols]


def _valid_zip_tse_locais(path: str) -> bool:
    """Zip válido contendo o CSV do SC."""
    if not zipfile.is_zipfile(path):
        return False
    with zipfile.ZipFile(path) as z:
        return any(n.endswith(TSE_LOCALS_CSV) for n in z.namelist())


def _fetch_missing(cache_dir: str) -> None:
    """Baixa apenas as fontes ausentes/inválidas do cache.

    INEP usa http (sem TLS) e é instável em transferências grandes —
    se falhar, o operador pode retomar com `curl -C -` (arquivos .part
    são substituídos atomicamente).
    """
    # TSE: eleitorado por local de votação 2026 (primária)
    try:
        z = ensure_source(TSE_LOCALS_ZIP, TSE_LOCALS_ZIP_URL, cache_dir,
                          validator=_valid_zip_tse_locais)
        _extract_tse_locals_csv(z, cache_dir)
        print('TSE locais: ok')
    except Exception as e:
        print(f'aviso: TSE locais não disponível ({e})', file=sys.stderr)
    # INEP 2025 (validação institucional)
    try:
        z = ensure_source(INEP_2025_ZIP, INEP_2025_ZIP_URL, cache_dir,
                          validator=zipfile.is_zipfile)
        if not os.path.exists(os.path.join(cache_dir, INEP_ESCOLAS_CSV)):
            _extract_inep_subset(z, INEP_2025_TBL,
                                 os.path.join(cache_dir, INEP_ESCOLAS_CSV),
                                 ['SG_UF', 'CO_MUNICIPIO', 'NO_MUNICIPIO',
                                  'NO_ENTIDADE', 'CO_ENTIDADE',
                                  'TP_SITUACAO_FUNCIONAMENTO'])
        print('INEP 2025: ok')
    except Exception as e:
        print(f'aviso: INEP 2025 não disponível ({e})', file=sys.stderr)
    # INEP 2024 (endereços — consistência de rua)
    try:
        z = ensure_source(INEP_2024_ZIP, INEP_2024_ZIP_URL, cache_dir,
                          validator=zipfile.is_zipfile)
        if not os.path.exists(os.path.join(cache_dir, INEP_ESCOLAS_END_CSV)):
            _extract_inep_subset(z, INEP_2024_TBL,
                                 os.path.join(cache_dir, INEP_ESCOLAS_END_CSV),
                                 ['SG_UF', 'CO_MUNICIPIO', 'NO_MUNICIPIO',
                                  'NO_ENTIDADE', 'CO_ENTIDADE',
                                  'DS_ENDERECO', 'NU_ENDERECO', 'NO_BAIRRO'])
        print('INEP 2024: ok')
    except Exception as e:
        print(f'aviso: INEP 2024 não disponível ({e})', file=sys.stderr)
    # OSM (geofabrik sul)
    try:
        p = ensure_source(OSM_PBF_NAME, OSM_PBF_URL, cache_dir)
        print(f'OSM PBF: ok ({os.path.getsize(p) / 1e6:.1f} MB)')
    except Exception as e:
        print(f'aviso: OSM PBF não disponível ({e})', file=sys.stderr)
    # TRE-SC
    try:
        ensure_source('tre_sc_locais.json', TRE_SC_URL, cache_dir,
                      validator=lambda p: bool(json.load(open(p)).get('locais')))
        print('TRE-SC: ok')
    except Exception as e:
        print(f'aviso: TRE-SC não disponível ({e})', file=sys.stderr)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--cache', default=CACHE)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--report', default=REPORT)
    ap.add_argument('--fetch', action='store_true',
                    help='baixa fontes ausentes do cache (TSE/INEP/OSM/TRE-SC)')
    ap.add_argument('--only', default='', help='filtra por município/nome (norm) p/ debug')
    args = ap.parse_args(argv)

    os.makedirs(args.cache, exist_ok=True)
    if args.fetch:
        _fetch_missing(args.cache)

    feats, name2code = load_mesh(os.path.join(REPO, 'data', 'geo_sc_municipios.json'))
    rings_by_code = {c: r for c, _n, r in feats}
    tse_index, secoes = load_tse_snapshot(REPO)
    mun_by_idx = secoes['mun']
    snap_rows = secoes['secoes']

    tse2geo = {}
    for tse, nome in mun_by_idx:
        cands = name2code.get(norm(nome), [])
        if len(cands) == 1:
            tse2geo[str(tse)] = cands[0]
        elif cands:
            tse2geo[str(tse)] = sorted(cands)[0]

    tse_locais = load_tse_locais(args.cache)
    if tse_locais is None:
        print(f'erro: {TSE_LOCALS_CSV} ausente em {args.cache} '
              f'(use --fetch ou extraia de {TSE_LOCALS_ZIP})', file=sys.stderr)
        return 1

    snap_keys = {(str(mun_by_idx[mi][0]), str(z2), str(s2))
                 for (mi, z2, s2, _l, _e) in snap_rows}
    n_sec_agregadas = sum(1 for (m, z, s) in tse_locais['secoes']
                          if (m, z, s) not in snap_keys)

    cat = build_catalog(tse_locais, tse2geo, snap_rows, mun_by_idx)
    if args.only:
        keep = {k for k, l in cat.items()
                if norm(l.mun_nome) == norm(args.only) or norm(l.nome) == norm(args.only)}
        cat = {k: l for k, l in cat.items() if k in keep}

    fontes: dict = {}
    meta = tse_locais['meta']
    p_csv = os.path.join(args.cache, TSE_LOCALS_CSV)
    fontes['tse_locais'] = {
        'url': TSE_LOCALS_ZIP_URL, 'arquivo_zip': TSE_LOCALS_ZIP,
        'arquivo_csv': TSE_LOCALS_CSV,
        'sha256_csv': sha256_file(p_csv),
        'dt_geracao': meta['dt_geracao'],
        'aa_eleicao': meta['aa_eleicao'],
        'n_linhas': meta['n_linhas'],
        'n_locais': len(tse_locais['locais']),
        'n_secoes': len(tse_locais['secoes']),
    }
    tse_g = tse_index.get('gerado_em', '')
    fontes['tse_2026'] = {'arquivo': 'data/tse_2026/secoes.json',
                          'dt_geracao_tse': tse_g,
                          'secoes': len(snap_rows)}
    inep = load_inep(args.cache)
    if inep:
        p = os.path.join(args.cache, INEP_ESCOLAS_CSV)
        fontes['inep_2025'] = {'arquivo': INEP_ESCOLAS_CSV,
                               'origem': INEP_2025_ZIP_URL,
                               'sha256': sha256_file(p),
                               'escolas_sc': len(inep)}
    else:
        print('aviso: INEP indisponível (sem validação institucional)', file=sys.stderr)
    osm = load_osm(args.cache)
    if osm:
        p = os.path.join(args.cache, OSM_PBF_NAME)
        if os.path.exists(p):
            fontes['osm'] = {'url': OSM_PBF_URL, 'arquivo': OSM_PBF_NAME,
                             'sha256': sha256_file(p), 'features_sc': len(osm)}
        else:
            jpath = os.path.join(args.cache, OSM_JSON_NAME)
            fontes['osm'] = {'url': OSM_PBF_URL,
                             'arquivo': OSM_JSON_NAME,
                             'sha256': sha256_file(jpath) if os.path.exists(jpath) else '',
                             'features_sc': len(osm)}
    else:
        print('aviso: OSM indisponível (sem verificação cruzada/lacunas)', file=sys.stderr)
    tre = load_tre_sc(args.cache)
    if tre:
        p = os.path.join(args.cache, 'tre_sc_locais.json')
        fontes['tre_sc'] = {'url': TRE_SC_URL, 'arquivo': 'tre_sc_locais.json',
                            'sha256': sha256_file(p), 'registros': len(tre['locais'])}
    else:
        print('aviso: TRE-SC indisponível (sem cross-check)', file=sys.stderr)

    stats: dict = {}
    stats['tse_locais'] = assign_coords_tse(cat, tse_locais)
    stats['osm_gapfill'] = gap_fill_osm(cat, osm, feats, rings_by_code)
    stats['tre_sc'] = link_tre_sc(cat, tre)
    stats['osm_cross'] = cross_validate_osm(cat, osm, feats, rings_by_code)
    stats['inep'] = cross_check_inep(cat, inep, feats)

    # Revisões manuais auditáveis (manifesto versionado em sync/):
    # aplicado DEPOIS do pipeline automático. A validação geográfica
    # (PIP/bbox) roda UMA única vez, por último, sobre o catálogo final —
    # coordenada revisada só é publicada se contida no município (ou
    # edge <= 500 m). O sha256 do manifesto entra em fontes -> _gerado_em
    # (proteção contra catálogo defasado).
    ovr_path = os.path.join(REPO, 'sync', OVERRIDES_NAME)
    manifest = load_overrides(ovr_path)
    stats['overrides'] = apply_overrides(cat, manifest, lenient=bool(args.only))
    stats['validacao'] = validate(cat, feats, rings_by_code)
    fontes['revisoes_manuais'] = {
        'arquivo': f'sync/{OVERRIDES_NAME}',
        'sha256': sha256_file(ovr_path),
        'n': stats['overrides']['n'],
        'corrigir': stats['overrides']['corrigir'],
        'documentar': stats['overrides']['documentar'],
    }

    resumo = publish(cat, args.out, tse_index, fontes, stats, args.report,
                     n_sec_snap=len(snap_rows), n_sec_agregadas=n_sec_agregadas)
    r = json.load(open(args.report, encoding='utf-8'))['resumo']
    print(json.dumps({
        'locais': resumo['n_locais'],
        'locais_verificados': r['locais_verificados'],
        'por_match': r['locais_por_match'],
        'secoes': r['secoes_associadas_local_oficial'],
        'secoes_verificadas': r['secoes_verificadas'],
        'secoes_sem_coordenada': r['secoes_sem_coordenada'],
        'secoes_agregadas_fora_dataset': r['secoes_agregadas_fora_dataset'],
        'cobertura_local_pct': r['cobertura_por_local_pct'],
        'cobertura_secao_pct': r['cobertura_por_secao_pct'],
        'validacao': stats['validacao'],
        'osm_cross': stats['osm_cross'],
        'inep': stats['inep'],
        'tre_sc': stats['tre_sc'],
    }, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
