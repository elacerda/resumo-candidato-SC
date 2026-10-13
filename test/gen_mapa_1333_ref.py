#!/usr/bin/env python3
"""Gera o mapa (HTML interativo + SVG estático) das seções com votos para
Ju Andózio (1333), Deputada Federal — Santa Catarina, Eleições 2026 (1º turno).

Gerador de REFERÊNCIA (Python) usado por test/e2e.js para conferir que o pipeline
JS (js/core.js) produz pontos idênticos, bit a bit. Não faz parte do app.

Uso:
    python3 test/gen_mapa_1333_ref.py [geojson_sc] [dir_saida]
    # p/ regenerar a fixture do e2e.js:
    python3 test/gen_mapa_1333_ref.py data/geo_sc_municipios.json test/fixture_1333

Inputs (relativos à raiz do repo):
    data/1333_sc_2026.json        # extração TSE: seções com votos p/ 1333
    data/geo_sc_municipios.json   # malha municipal de SC (IBGE, GeoJSON)

Outputs (em dir_saida; padrão: diretório temporário):
    1333_sc_mapa.html             # mapa interativo (mouse-over por seção)
    1333_sc_mapa.svg              # versão estática (tooltips nativos <title>)
"""
import json, math, os, random, sys, tempfile, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = json.load(open(os.path.join(ROOT, 'data', '1333_sc_2026.json'), encoding='utf-8'))
GEO = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'data', 'geo_sc_municipios.json')
gc = json.load(open(GEO, encoding='utf-8'))

TOTAL_ESPERADO = 4876
assert DATA['total'] == TOTAL_ESPERADO, f"total {DATA['total']} != {TOTAL_ESPERADO}"

# ---- cores (paleta fixa, sem CSS vars) ------------------------------------
BG      = '#0e1319'
FILL0   = '#161d27'   # município sem votos
STROKE0 = '#2a3543'
ACCENT  = '#3b82f6'   # choropleth (votos do município)
STROKE1 = '#35507a'
DOT     = '#ffb454'   # pontos = seções com voto
DOT_ED  = 'rgba(255,255,255,0.25)'
FG      = '#e8eef5'
MUTED   = '#8fa0b3'

def norm(s):
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return ''.join(c for c in s.upper() if c.isalnum())

# ---- geometria -------------------------------------------------------------
def ring_of(g):
    if g['type'] == 'Polygon':
        return g['coordinates'][0]
    rings = [p[0] for p in g['coordinates']]
    return max(rings, key=lambda r: len(r))

def bbox(ring):
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)

def in_poly(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

def decimate(ring, step):
    pts = ring[::step]
    if pts[0] != ring[-1]:
        pts.append(ring[-1])
    return pts

feats = []
for f in gc['features']:
    p = f['properties']
    muni = str(p.get('id') or '')
    nome = p.get('name') or p.get('description') or ''
    feats.append((muni, nome, ring_of(f['geometry'])))

# ---- mapeia código TSE -> geometria por nome normalizado --------------------
geo_by_name = {}
for muni, nome, r in feats:
    geo_by_name.setdefault(norm(nome), []).append(muni)
tse2geo, unmatched, ambiguous = {}, [], []
for m, v in DATA['mun'].items():
    cands = geo_by_name.get(norm(v['nome']), [])
    if len(cands) == 1:
        tse2geo[m] = cands[0]
    elif len(cands) > 1:
        tse2geo[m] = cands[0]
        ambiguous.append((m, v['nome'], cands))
    else:
        unmatched.append((m, v['nome']))
print(f'mapeados {len(tse2geo)}/{len(DATA["mun"])} | sem geometria: {unmatched}')
for a in ambiguous:
    print('AVISO ambíguo:', a)

# ---- projeção (equiretangular) ---------------------------------------------
allxs = [p[0] for _, _, r in feats for p in r]
allys = [p[1] for _, _, r in feats for p in r]
minx, miny, maxx, maxy = min(allxs), min(allys), max(allxs), max(allys)
kx = math.cos(math.radians((miny + maxy) / 2))
W = 980
scale = W / ((maxx - minx) * kx)
H = int(math.ceil((maxy - miny) * scale))
pad = 14

def P(lon, lat):
    return (round(pad + (lon - minx) * kx * scale, 1),
            round(pad + (maxy - lat) * scale, 1))

# ---- dados re-chaveados para geometria --------------------------------------
mun_votes = {tse2geo[m]: v['votos'] for m, v in DATA['mun'].items() if m in tse2geo}
maxmun = max(mun_votes.values())
mun_sections = {}
for s in DATA['sections']:
    if s['muni'] in tse2geo:
        mun_sections.setdefault(tse2geo[s['muni']], []).append(s)

def fill_for(v):
    if not v:
        return None
    t = math.log2(v + 1) / math.log2(maxmun + 1)
    return round(0.12 + 0.73 * t, 3)

def place_points(ring, n, seed):
    """n pontos determinísticos dentro do polígono: grade com jitter + rejeição."""
    rng = random.Random(seed)
    bx0, by0, bx1, by1 = bbox(ring)
    pts = []
    if n > 0 and (bx1 - bx0) > 0 and (by1 - by0) > 0:
        cols = max(1, int(math.ceil(math.sqrt(n * (bx1 - bx0) / (by1 - by0)))))
        rows = max(1, int(math.ceil(n / cols)))
        cw, ch = (bx1 - bx0) / cols, (by1 - by0) / rows
        for ry in range(rows):
            for rx in range(cols):
                if len(pts) >= n:
                    break
                lon = bx0 + (rx + 0.5) * cw + rng.uniform(-0.45, 0.45) * cw
                lat = by0 + (ry + 0.5) * ch + rng.uniform(-0.45, 0.45) * ch
                if in_poly(lon, lat, ring):
                    pts.append((lon, lat))
        tries = 0
        while len(pts) < n and tries < n * 40:
            tries += 1
            lon = rng.uniform(bx0, bx1); lat = rng.uniform(by0, by1)
            if in_poly(lon, lat, ring):
                pts.append((lon, lat))
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        while len(pts) < n:
            pts.append((cx, cy))
    return pts

ring_by_geo = {m: r for m, _, r in feats}
dot_xy, dot_sec = [], []   # (x,y) e a seção correspondente, na mesma ordem
for muni, sects in sorted(mun_sections.items()):
    ring = ring_by_geo[muni]
    pts = place_points(ring, len(sects), int(muni))
    for (lon, lat), s in zip(pts, sects):
        dot_xy.append(P(lon, lat))
        dot_sec.append(s)
print('pontos:', len(dot_xy))

def dot_r(v):
    return round(1.3 + 0.55 * min(v - 1, 4), 2)

# ---- rótulos: municípios com mais votos -------------------------------------
def centroid(ring):
    rs = ring[::5]
    return (sum(p[0] for p in rs) / len(rs), sum(p[1] for p in rs) / len(rs))

mun_meta = {tse2geo[m]: (v['nome'], v['votos']) for m, v in DATA['mun'].items() if m in tse2geo}
labels = []
for muni, ring in ring_by_geo.items():
    nome, v = mun_meta.get(muni, ('', 0))
    if v >= 60:
        x, y = P(*centroid(ring))
        labels.append((x, y, nome.title(), v))
n_mun = len(mun_votes)

# ---- monta SVG ---------------------------------------------------------------
def build_svg(with_titles, hud=True):
    parts = [f'<svg id="map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W + 2*pad} {H + 2*pad}" font-family="system-ui, -apple-system, sans-serif">']
    parts.append(f'<rect x="0" y="0" width="{W + 2*pad}" height="{H + 2*pad}" fill="{BG}"/>')
    for muni, nome, ring in feats:
        d = "M " + " L ".join(f"{x} {y}" for x, y in (P(*p) for p in decimate(ring, 3))) + " Z"
        fo = fill_for(mun_votes.get(muni, 0))
        if fo is not None:
            parts.append(f'<path d="{d}" fill="{ACCENT}" fill-opacity="{fo}" stroke="{STROKE1}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>')
        else:
            parts.append(f'<path d="{d}" fill="{FILL0}" stroke="{STROKE0}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>')
    for i, ((x, y), s) in enumerate(zip(dot_xy, dot_sec)):
        r = dot_r(s['votos'])
        if with_titles:
            local = (s.get('local') or '').replace('&', '&amp;').replace('<', '&lt;')
            title = f"Seção {s['secao']} · Zona {s['zona']} — {s['muni_nome'].title()}\n{s['votos']} voto(s) para Ju Andózio (1333)\nLocal: {local}"
            parts.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{DOT}" fill-opacity="0.9" stroke="{DOT_ED}" stroke-width="0.5" vector-effect="non-scaling-stroke"><title>{title}</title></circle>')
        else:
            parts.append(f'<circle class="dot" data-i="{i}" cx="{x}" cy="{y}" r="{r}" fill="{DOT}" fill-opacity="0.9" stroke="{DOT_ED}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>')
    for x, y, nome, v in sorted(labels, key=lambda t: -t[3]):
        parts.append(f'<text class="lbl" x="{x}" y="{y-4}" text-anchor="middle" font-size="11" font-weight="600" fill="{FG}" stroke="{BG}" stroke-width="3" paint-order="stroke">{nome}</text>')
        parts.append(f'<text class="lbl" x="{x}" y="{y+9}" text-anchor="middle" font-size="9.5" fill="{MUTED}" stroke="{BG}" stroke-width="3" paint-order="stroke">{v} votos</text>')
    if hud:
        parts.append(f'<text x="{pad+4}" y="{pad+22}" font-size="16" font-weight="700" fill="{FG}">Ju Andózio (1333) — Deputada Federal · Santa Catarina</text>')
        parts.append(f'<text x="{pad+4}" y="{pad+38}" font-size="11.5" fill="{MUTED}">Eleições 2026 · 1º turno (04/10) · 4.876 votos em 3.397 de 17.326 seções · {n_mun} de 295 municípios · cada ponto = 1 seção com voto · fonte: TSE</text>')
        lx = W + pad - 172; ly = H + pad - 58
        parts.append(f'<rect x="{lx}" y="{ly}" width="172" height="52" fill="{FILL0}" fill-opacity="0.9" stroke="{STROKE0}" rx="4"/>')
        parts.append(f'<text x="{lx+10}" y="{ly+14}" font-size="10" fill="{FG}">votos por município (1333):</text>')
        for i in range(8):
            t = i / 7
            parts.append(f'<rect x="{lx+10+i*15}" y="{ly+20}" width="15" height="9" fill="{ACCENT}" fill-opacity="{round(0.12+0.73*t,3)}"/>')
        parts.append(f'<text x="{lx+10}" y="{ly+40}" font-size="9" fill="{MUTED}">0</text>')
        parts.append(f'<text x="{lx+128}" y="{ly+40}" font-size="9" fill="{MUTED}" text-anchor="end">{maxmun:,} (Florianópolis)</text>')
        parts.append(f'<circle cx="{lx+148}" cy="{ly+36}" r="3" fill="{DOT}"/><text x="{lx+156}" y="{ly+40}" font-size="9" fill="{MUTED}">1 seção</text>')
    parts.append('</svg>')
    return "\n".join(parts)

# ---- HTML interativo ----------------------------------------------------------
tip_js = """
const SECTIONS = __DATA__;
const svg = document.getElementById('map');
const tip = document.getElementById('tip');

// ---------- zoom (scroll) + pan (arrastar) via viewBox ----------
const VB = svg.viewBox.baseVal;
const VBW = VB.width, VBH = VB.height;
const MIN_W = VBW / 60; // zoom máximo ~60x
let vb = { x: VB.x, y: VB.y, w: VBW, h: VBH };

const dots = Array.from(svg.querySelectorAll('circle.dot'));
const baseR = dots.map(d => parseFloat(d.getAttribute('r')));
const lbls = Array.from(svg.querySelectorAll('text.lbl'));
const baseFs = lbls.map(t => parseFloat(t.getAttribute('font-size')));
const baseHalo = 3;

function apply() {
  svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
  const s = vb.w / VBW; // pontos e rótulos com tamanho constante na tela
  for (let i = 0; i < dots.length; i++) dots[i].setAttribute('r', (baseR[i] * s).toFixed(2));
  for (let i = 0; i < lbls.length; i++) {
    lbls[i].setAttribute('font-size', (baseFs[i] * s).toFixed(2));
    lbls[i].setAttribute('stroke-width', (baseHalo * s).toFixed(2));
  }
}
function toSvg(ev) {
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = svg.createSVGPoint();
  p.x = ev.clientX; p.y = ev.clientY;
  return p.matrixTransform(m.inverse());
}
function zoomAt(p, f) {
  const nw = Math.min(VBW, Math.max(MIN_W, vb.w / f));
  const k = nw / vb.w;
  vb.x = p.x - (p.x - vb.x) * k;
  vb.y = p.y - (p.y - vb.y) * k;
  vb.w = nw;
  vb.h = VBH * (nw / VBW);
  apply();
}
svg.addEventListener('wheel', ev => {
  ev.preventDefault();
  const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.008 : 0.0015));
  if (Math.abs(f - 1) > 1e-4) {
    zoomAt(toSvg(ev), f);
    tip.style.display = 'none';
  }
}, { passive: false });

let drag = null;
svg.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  const r = svg.getBoundingClientRect();
  drag = { sx: ev.clientX, sy: ev.clientY, vx: vb.x, vy: vb.y, k: vb.w / r.width };
  svg.classList.add('dragging');
  ev.preventDefault();
});
window.addEventListener('mousemove', ev => {
  if (!drag) return;
  vb.x = drag.vx - (ev.clientX - drag.sx) * drag.k;
  vb.y = drag.vy - (ev.clientY - drag.sy) * drag.k;
  apply();
  tip.style.display = 'none';
});
window.addEventListener('mouseup', () => {
  if (drag) { drag = null; svg.classList.remove('dragging'); }
});
svg.addEventListener('dblclick', ev => {
  ev.preventDefault();
  vb = { x: VB.x, y: VB.y, w: VBW, h: VBH };
  apply();
});

// ---------- tooltip ----------
function showTip(s, cx, cy) {
  const end = s.e ? `<div class="m">${esc(s.e)}</div>` : '';
  tip.innerHTML =
    `<div class="h">Seção ${esc(s.s)} · Zona ${esc(s.z)}</div>` +
    `<div class="muni">${esc(s.m)}</div>` +
    `<div class="m">${esc(s.l)}</div>${end}` +
    `<div class="v">${s.v} ${s.v === 1 ? 'voto' : 'votos'} para Ju Andózio (1333)</div>`;
  tip.style.display = 'block';
  const bw = tip.offsetWidth, bh = tip.offsetHeight;
  let x = cx + 14, y = cy + 14;
  if (x + bw > window.innerWidth - 8)  x = cx - bw - 14;
  if (y + bh > window.innerHeight - 8) y = cy - bh - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function esc(t){ return (t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
svg.addEventListener('mousemove', ev => {
  if (drag) return;
  const t = ev.target;
  if (t.classList && t.classList.contains('dot')) {
    showTip(SECTIONS[+t.dataset.i], ev.clientX, ev.clientY);
  } else if (tip.style.display === 'block') {
    tip.style.display = 'none';
  }
});
svg.addEventListener('mouseleave', () => tip.style.display = 'none');
"""

def build_html():
    svg_body = build_svg(with_titles=False, hud=False)
    swatches = ''.join(f'<rect x="{i*15}" y="0" width="15" height="9" fill="{ACCENT}" fill-opacity="{round(0.12 + 0.73 * i / 7, 3)}"/>' for i in range(8))
    payload = [{ 'm': s['muni_nome'].title(), 'z': s['zona'], 's': s['secao'],
                 'v': s['votos'], 'l': s.get('local') or '', 'e': s.get('end') or '' }
               for s in dot_sec]
    page = f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ju Andózio (1333) — seções com voto, SC, 2026</title>
<style>
  html, body {{ margin: 0; background: {BG}; color: {FG}; }}
  body {{ display: flex; flex-direction: column; align-items: center; padding: 18px 12px; }}
  .wrap {{ position: relative; width: 100%; max-width: 1080px; }}
  svg {{ width: 100%; height: auto; display: block; border-radius: 8px; cursor: grab; user-select: none; -webkit-user-select: none; }}
  svg.dragging, svg.dragging .dot {{ cursor: grabbing; }}
  .dot {{ cursor: pointer; }}
  .hud {{ position: absolute; z-index: 5; background: rgba(22,29,39,0.92); border: 1px solid {STROKE0}; border-radius: 6px; pointer-events: none; }}
  #hudTitle {{ top: 14px; left: 14px; padding: 8px 12px; }}
  #hudTitle .t {{ font-size: 16px; font-weight: 700; color: {FG}; }}
  #hudTitle .s {{ font-size: 11.5px; color: {MUTED}; margin-top: 3px; }}
  #hudLegend {{ right: 14px; bottom: 14px; padding: 8px 10px; }}
  #hudLegend .l1 {{ font-size: 10px; color: {FG}; }}
  #hudLegend .l2 {{ display: flex; align-items: center; gap: 5px; font-size: 9px; color: {MUTED}; margin-top: 4px; }}
  #hudLegend .d {{ width: 6px; height: 6px; border-radius: 50%; background: {DOT}; display: inline-block; flex: none; }}
  .dot:hover {{ stroke: #ffffff; stroke-width: 1.2; fill-opacity: 1; }}
  #tip {{ position: fixed; display: none; z-index: 10; max-width: 300px; pointer-events: none;
          background: rgba(23,30,40,0.97); border: 1px solid #3a4a5f; border-radius: 6px;
          padding: 8px 10px; font: 12px/1.45 system-ui, -apple-system, sans-serif;
          box-shadow: 0 6px 18px rgba(0,0,0,0.5); }}
  #tip .h {{ font-weight: 700; font-size: 12.5px; }}
  #tip .muni {{ color: {MUTED}; font-size: 11.5px; }}
  #tip .m {{ color: {MUTED}; font-size: 11px; margin-top: 2px; overflow-wrap: anywhere; }}
  #tip .v {{ margin-top: 6px; color: {DOT}; font-weight: 700; }}
  footer {{ max-width: 1080px; width: 100%; margin-top: 10px; color: {MUTED}; font-size: 10.5px; line-height: 1.5; }}
</style>
</head>
<body>
<div class="wrap">
__SVG__
<div id="hudTitle" class="hud">
  <div class="t">Ju Andózio (1333) — Deputada Federal · Santa Catarina</div>
  <div class="s">Eleições 2026 · 1º turno (04/10) · 4.876 votos em 3.397 de 17.326 seções · {n_mun} de 295 municípios · cada ponto = 1 seção com voto · fonte: TSE</div>
</div>
<div id="hudLegend" class="hud">
  <div class="l1">votos por município (1333):</div>
  <svg width="120" height="9">{swatches}</svg>
  <div class="l2"><span>0</span><span class="d"></span><span>1 seção</span><span style="flex:1"></span><span>{maxmun:,} (Florianópolis)</span></div>
</div>
</div>
<div id="tip"></div>
<footer>
Cada ponto representa uma seção eleitoral com pelo menos 1 voto para Ju Andózio (JULIANA ANDOZIO no TSE),
número 1333, Deputada Federal — SC, 1º turno de 04/10/2026. Total: 4.876 votos em 3.397 de 17.326 seções
(224 de 295 municípios). Os pontos são posicionados por sorteio determinístico dentro do polígono do
município da seção (identifique a seção exata pelo tooltip). Fonte dos votos: TSE (dados abertos,
votacao_secao_2026_SC). Malha municipal: IBGE (espelho tbrugz/geodata-br).
Interação: scroll do mouse dá zoom centrado no cursor, arrastar move o mapa e duplo clique
volta à visão completa.
</footer>
<script>
__JS__
</script>
</body>
</html>
"""
    page = page.replace('__SVG__', svg_body)
    page = page.replace('__JS__', tip_js)
    page = page.replace('__DATA__', json.dumps(payload, ensure_ascii=False))
    return page

# ---- escreve ------------------------------------------------------------------
OUT = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix='mapa_1333_ref_')
os.makedirs(OUT, exist_ok=True)
html_out = os.path.join(OUT, '1333_sc_mapa.html')
svg_out = os.path.join(OUT, '1333_sc_mapa.svg')
open(html_out, 'w', encoding='utf-8').write(build_html())
open(svg_out, 'w', encoding='utf-8').write(build_svg(with_titles=True))
print(html_out, os.path.getsize(html_out), 'bytes')
print(svg_out, os.path.getsize(svg_out), 'bytes')
