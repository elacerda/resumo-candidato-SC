"""Self-test do leitor PBF (sync/geo_pbf.py): monta PBFs sintéticos com um
escritor protobuf mínimo (spec oficial openstreetmap/OSM-binary,
confere sync/geo_pbf.py) e valida a decodificação:

- container: com magic "pbf" e SEM magic (stream de blobs no byte 0);
- blobs: OSMHeader (zlib + raw_size), OSMData (zlib + raw_size),
  OSMData Raw (sem compressão) e OSMData Delta (esquema antigo:
  chunks zlib com XOR acumulado);
- raw_size inválido -> PbfError;
- PrimitiveBlock: stringtable (repeated bytes), granularity=17,
  lat_offset=19 / lon_offset=20 (int64 varint, NÃO zigzag);
- Node esparsos: id=1 (sint64 zigzag), keys=2/vals=3, lat=8/lon=9;
- DenseNodes: id/lat/lon (sint64 zigzag, DELTA), keys_vals=10
  (intercalado k,v,...,0 por nó);
- Way: id=1 (int64), refs=8 (sint64 zigzag, DELTA), keys/vals.

Uso: python3 test/geo_pbf_roundtrip.py
"""
import os
import struct
import sys
import tempfile
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'sync'))
import geo_pbf  # noqa: E402

ok = True


def check(name, cond, extra=''):
    global ok
    print(('  ✓ ' if cond else '  ✗ ') + name + (('  [' + extra + ']') if (not cond and extra) else ''))
    if not cond:
        ok = False


# ---------- escritor protobuf mínimo ----------

def varint(v):
    """Varint (unsigned); aceita negativos como int64 two's complement."""
    if v < 0:
        v += 1 << 64
    out = b''
    while True:
        b7 = v & 0x7F
        v >>= 7
        if v:
            out += bytes([b7 | 0x80])
        else:
            return out + bytes([b7])


def zigzag(v):
    """Zigzag (sint32/sint64)."""
    return (v << 1) ^ (v >> 63)


def tag(field, wire):
    return varint((field << 3) | wire)


def ld(field, payload):
    return tag(field, 2) + varint(len(payload)) + payload


def var(field, v):
    return tag(field, 0) + varint(v)


def msg(fields):
    return b''.join(fields)


def container(pairs, with_magic=True):
    """pairs = [(BlobHeader, Blob), ...]; cada Blob segue o header direto."""
    out = b'pbf' + struct.pack('>I', 1) if with_magic else b''
    for header, body in pairs:
        out += struct.pack('>I', len(header)) + header + body
    return out


def blob_header(tipo, datasize):
    return msg([ld(1, tipo.encode()), var(3, datasize)])


def blob_zlib(payload, with_raw_size=True):
    comp = zlib.compress(payload)
    fields = [var(2, len(payload))] if with_raw_size else []
    fields.append(ld(3, comp))
    return msg(fields)


def blob_raw(payload):
    return msg([var(2, len(payload)), ld(1, payload)])


def string_table(strings):
    return msg([ld(1, s.encode('utf-8')) for s in strings])


ST = ['', 'name', 'highway', 'primary', 'office', 'ngo', 'place', 'city', 'Itajaí']
LAT_OFF = -27465000000  # -27.465 graus em nanodegraus
LON_OFF = -48700000000  # -48.7 graus em nanodegraus


def block_main():
    """Bloco principal: 2 nodes esparsos + 3 dense + 1 way."""
    # nó esparsos
    node1 = msg([var(1, zigzag(101)), var(8, zigzag(0)), var(9, zigzag(0))])
    node2 = msg([var(1, zigzag(202)), var(8, zigzag(123)), var(9, zigzag(456)),
                 ld(2, varint(1) + varint(4)),   # keys: name, office
                 ld(3, varint(5) + varint(5))])  # vals: ngo, ngo
    # dense: ids 301,302,310 (deltas 301,+1,+8); lats 0,+1,-1; lons 0,-2,+4
    dense = msg([
        ld(1, varint(zigzag(301)) + varint(zigzag(1)) + varint(zigzag(8))),
        ld(8, varint(zigzag(0)) + varint(zigzag(1)) + varint(zigzag(-1))),
        ld(9, varint(zigzag(0)) + varint(zigzag(-2)) + varint(zigzag(4))),
        # keys_vals: nó301 sem tags (0); nó302 name=ngo (1,5); nó310 highway=primary (2,3)
        ld(10, varint(0) + varint(1) + varint(5) + varint(0)
                  + varint(2) + varint(3) + varint(0)),
    ])
    # way: refs 101, +99, -97 -> 101,200,103; tags highway=primary
    way = msg([var(1, 505),
               ld(2, varint(zigzag(101) + 0) + varint(0)),  # placeholder
               ])
    way = msg([var(1, 505),
               ld(8, varint(zigzag(101)) + varint(zigzag(99)) + varint(zigzag(-97))),
               ld(2, varint(2)), ld(3, varint(3))])
    group = msg([ld(1, node1), ld(1, node2), ld(2, dense), ld(3, way)])
    return msg([ld(1, string_table(ST)), ld(2, group),
                var(17, 100), var(19, LAT_OFF), var(20, LON_OFF)])


def block_raw_node():
    """Bloco do blob Raw: 1 node esparsos, offsets 0 (default)."""
    # stringtable próprio: ['' , 'place', 'city'] -> keys [1], vals [2]
    st2 = string_table(['', 'place', 'city'])
    node = msg([var(1, zigzag(404)), var(8, zigzag(-276000000)), var(9, zigzag(-485500000)),
                ld(2, varint(1)), ld(3, varint(2)), var(17, 100)])
    group = msg([ld(1, node)])
    return msg([ld(1, st2), ld(2, group)])


def make_pbf(path, with_magic=True, raw_size_ok=True, delta=False):
    header_payload = msg([ld(1, b'geo-pbf-test'), ld(17, b'https://example.org/geo-pbf-test')])
    b_header = msg([var(2, len(header_payload)), ld(3, zlib.compress(header_payload))])
    pairs = [(blob_header('OSMHeader', len(b_header)), b_header)]
    if delta:
        # esquema antigo: blob "Delta" com 2 chunks (2º = diferença)
        full = block_main()
        cut = len(full) // 2
        chunk1 = zlib.compress(full[:cut])
        xor = bytes(a ^ b for a, b in zip(full[:cut], full[cut:]))
        chunk2 = zlib.compress(xor)
        data = varint(len(chunk1)) + chunk1 + varint(len(chunk2)) + chunk2
        b_delta = msg([ld(3, data)])
        pairs.append((blob_header('Delta', len(b_delta)), b_delta))
    else:
        raw_size = len(block_main()) if raw_size_ok else len(block_main()) + 7
        b_main = msg([var(2, raw_size), ld(3, zlib.compress(block_main()))])
        b_raw = blob_raw(block_raw_node())
        pairs += [(blob_header('OSMData', len(b_main)), b_main),
                  (blob_header('OSMData', len(b_raw)), b_raw)]
    with open(path, 'wb') as f:
        f.write(container(pairs, with_magic))


def main():
    with tempfile.TemporaryDirectory() as td:
        # A) com magic, tudo ok
        p = os.path.join(td, 'a.pbf')
        make_pbf(p, with_magic=True)
        feats = list(geo_pbf.iter_features(p))
        check('A: 7 features', len(feats) == 7, str(len(feats)))
        by_id = {f['id']: f for f in feats}
        check('A: ids', set(by_id) == {101, 202, 301, 302, 310, 404, 505}, str(sorted(by_id)))
        w = by_id.get(505, {})
        check('A: way refs delta (101,200,103)', w.get('refs') == [101, 200, 103], str(w.get('refs')))
        check('A: way tags', w.get('tags') == {'highway': 'primary'}, str(w.get('tags')))
        check('A: nó 101 sem tags / offset', abs(by_id[101]['lat'] - LAT_OFF / 1e9) < 1e-12
              and abs(by_id[101]['lon'] - LON_OFF / 1e9) < 1e-12,
              f"{by_id[101]['lat']},{by_id[101]['lon']}")
        check('A: nó 202 coords', abs(by_id[202]['lat'] - (123 * 100 + LAT_OFF) / 1e9) < 1e-12
              and abs(by_id[202]['lon'] - (456 * 100 + LON_OFF) / 1e9) < 1e-12,
              f"{by_id[202]['lat']},{by_id[202]['lon']}")
        check('A: nó 202 tags', by_id[202]['tags'] == {'name': 'ngo', 'office': 'ngo'}, str(by_id[202]['tags']))
        check('A: dense 301 sem tags', by_id[301]['tags'] == {} and abs(by_id[301]['lat'] - LAT_OFF / 1e9) < 1e-12)
        check('A: dense 302 lat', abs(by_id[302]['lat'] - (100 + LAT_OFF) / 1e9) < 1e-12, str(by_id[302]['lat']))
        check('A: dense 302 tags', by_id[302]['tags'] == {'name': 'ngo'}, str(by_id[302]['tags']))
        check('A: dense 310 lon', abs(by_id[310]['lon'] - (200 + LON_OFF) / 1e9) < 1e-12, str(by_id[310]['lon']))
        check('A: dense 310 tags', by_id[310]['tags'] == {'highway': 'primary'}, str(by_id[310]['tags']))
        check('A: blob Raw nó 404', abs(by_id[404]['lat'] + 27.6) < 1e-12
              and abs(by_id[404]['lon'] + 48.55) < 1e-12, f"{by_id[404]['lat']},{by_id[404]['lon']}")
        check('A: blob Raw nó 404 tags', by_id[404]['tags'] == {'place': 'city'}, str(by_id[404]['tags']))

        # B) sem magic (stream de blobs no byte 0 — como sul-latest.osm.pbf)
        p = os.path.join(td, 'b.pbf')
        make_pbf(p, with_magic=False)
        feats_b = list(geo_pbf.iter_features(p))
        check('B (sem magic): mesmas features', feats_b == feats, f'{len(feats_b)} vs {len(feats)}')

        # C) raw_size inválido -> PbfError
        p = os.path.join(td, 'c.pbf')
        make_pbf(p, with_magic=True, raw_size_ok=False)
        try:
            list(geo_pbf.iter_features(p))
            check('C: raw_size inválido rejeitado', False, 'sem exceção')
        except geo_pbf.PbfError:
            check('C: raw_size inválido rejeitado', True)

        # D) blob Delta (esquema antigo, XOR acumulado)
        p = os.path.join(td, 'd.pbf')
        make_pbf(p, with_magic=True, delta=True)
        feats_d = [f for f in geo_pbf.iter_features(p)]
        ids_d = sorted(f['id'] for f in feats_d)
        check('D (Delta): 6 features do bloco', ids_d == [101, 202, 301, 302, 310, 505], str(ids_d))
        check('D (Delta): coords ok', abs([f for f in feats_d if f['id'] == 302][0]['lat'] - (100 + LAT_OFF) / 1e9) < 1e-12)

    print('\nPBF ROUNDTRIP ' + ('OK' if ok else 'FALHOU'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
