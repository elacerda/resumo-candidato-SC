"""Leitor mínimo de OSM PBF (protobuf), somente stdlib.

Implementa o suficiente do formato OSM PBF para extrair nós e ways com
tags de um extrato geofabrik:

Container (fileformat.proto)
    - sequência de blobs; cada blob: u32 big-endian (tamanho do
      BlobHeader) + BlobHeader{type, datasize} + Blob (exatamente
      ``datasize`` bytes);
    - ``BlobHeader``: 1=type (str), 3=datasize (u32);
    - ``Blob``: 1=raw, 2=raw_size (u32; tamanho não comprimido),
      3=zlib_data, 4=lzma_data, 6=lz4_data, 7=zstd_data;
    - blob "OSMHeader" (identificação; corpo = HeaderBlock) é
      ignorado; o corpo de um blob "OSMData" é UMA mensagem
      PrimitiveBlock (formato atual do OSM-binary; confirmados os
      protos oficiais em openstreetmap/OSM-binary e o parser Java de
      referência);
    - blob "Delta": sequência de <varint tam><bytes zlib>; o primeiro
      decomprime normalmente, cada seguinte é XOR byte-a-byte com o
      anterior (diferença acumulada);
    - arquivos com ou sem o cabeçalho de 7 bytes "pbf"+versão
      (alguns escritores omitem o magic — o stream de blobs começa no
      byte 0).

PrimitiveBlock (osmformat.proto)
    - 1=StringTable{1=repeated bytes s}, 2=repeated PrimitiveGroup,
      17=granularity (int32 varint; default 100),
      19=lat_offset (int64 varint), 20=lon_offset (int64 varint);
    - graus = (valor * granularity + offset) / 1e9;
    - ``DenseNodes``: 1=id (sint64, delta), 8=lat (sint64, delta),
      9=lon (sint64, delta), 10=keys_vals (int32 entrelaçado
      k1,v1,k2,v2,...,0 por nó; 0 encerra a lista de tags do nó);
    - ``Node`` esparsos: 1=id (sint64), 2=keys, 3=vals (uint32),
      8=lat, 9=lon (sint64);
    - ``Way``: 1=id (int64), 2=keys, 3=vals, 8=refs (sint64, delta);
    - sint64 = varint com codificação zigzag.

Uso:
    from geo_pbf import iter_features
    for feat in iter_features(caminho_pbf):
        # {"id": int, "kind": "node"|"way", "lat", "lon", "tags"}
        # (ways: "refs" em vez de lat/lon; sem relação — pulada)

Limitações (intencionais): relações são puladas (não usadas),
lz4/zstd não são suportados na stdlib (erro explícito),
info/changeset são ignorados. Determinístico e sem dependências.
"""
from __future__ import annotations

import struct
import zlib
from typing import Dict, Iterator, List, Optional, Tuple

__all__ = ["PbfError", "iter_features", "parse_container", "read_pb"]


class PbfError(ValueError):
    """Estrutura inválida em um arquivo PBF."""


# ---------------- protobuf: wire format ----------------

def _varint(buf, off: int) -> Tuple[int, int]:
    """Lê um varint (até 10 bytes) a partir de off; retorna (valor, novo_off)."""
    n = len(buf)
    val = b = 0
    for shift in range(0, 70, 7):
        if off >= n:
            raise PbfError("varint truncado")
        b = buf[off]
        off += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, off
    raise PbfError("varint muito longo")


def _zigzag(v: int) -> int:
    """Decodifica int zigzag (sint32/sint64) a partir do varint."""
    return (v >> 1) ^ -(v & 1)


def read_pb(buf) -> Iterator[Tuple[int, int, bytes]]:
    """Itera campos protobuf: (field, wire_type, payload).

    wire 0 -> payload = varint (bytes big-endian de 1 a 10);
    wire 1 -> 8 bytes; wire 5 -> 4 bytes; wire 2 -> bytes delimitados.
    """
    off = 0
    n = len(buf)
    while off < n:
        tag, off = _varint(buf, off)
        field, wire = tag >> 3, tag & 7
        if field == 0:
            raise PbfError("campo 0 inválido")
        if wire == 0:
            val, off = _varint(buf, off)
            yield field, wire, val.to_bytes((val.bit_length() + 7) // 8 or 1, "big")
        elif wire == 1:
            if off + 8 > n:
                raise PbfError("bytes64 truncado")
            yield field, wire, buf[off:off + 8]
            off += 8
        elif wire == 2:
            ln, off = _varint(buf, off)
            if off + ln > n:
                raise PbfError("campo de bytes truncado")
            yield field, wire, buf[off:off + ln]
            off += ln
        elif wire == 5:
            if off + 4 > n:
                raise PbfError("bytes32 truncado")
            yield field, wire, buf[off:off + 4]
            off += 4
        else:
            raise PbfError(f"wire type {wire} não suportado")


def _packed(buf, signed: bool) -> List[int]:
    """Pacote de varints (packed); signed -> zigzag."""
    out: List[int] = []
    off = 0
    n = len(buf)
    while off < n:
        v, off = _varint(buf, off)
        out.append(_zigzag(v) if signed else v)
    return out


# ---------------- container PBF (blobs) ----------------

def _decode_blob(payload: bytes) -> Tuple[str, bytes]:
    """Blob -> (tipo, dados decomprimidos).

    Tipo = campo 1 do BlobHeader já foi lido pelo container; aqui o
    ``payload`` é o corpo do Blob. raw_size (campo 2) é validado quando
    presente.
    """
    raw = zlib_data = lzma_data = None
    raw_size: Optional[int] = None
    has_lz4 = has_zstd = False
    for field, wire, p in read_pb(payload):
        if field == 1 and wire == 2:
            raw = p
        elif field == 2 and wire == 0:
            raw_size = int.from_bytes(p, "big")
        elif field == 3 and wire == 2:
            zlib_data = p
        elif field == 4 and wire == 2:
            lzma_data = p
        elif field == 6 and wire == 2:
            has_lz4 = True
        elif field == 7 and wire == 2:
            has_zstd = True
        # demais campos: ignorados (forward compat)
    if has_lz4 or has_zstd:
        raise PbfError("blob lz4/zstd não suportado (stdlib)")
    if raw is not None:
        out = raw
    elif zlib_data is not None:
        out = zlib.decompress(zlib_data)
    elif lzma_data is not None:
        import lzma
        out = lzma.decompress(lzma_data)
    else:
        raise PbfError("blob sem dados")
    if raw_size is not None and len(out) != raw_size:
        raise PbfError(f"raw_size={raw_size} != {len(out)} após decompressão")
    return (None, out)


def _delta_chunks(data_field: bytes) -> bytes:
    """Sequência <varint tam><zlib> com XOR acumulado (blob Delta)."""
    chunks: List[bytes] = []
    off = 0
    n = len(data_field)
    prev: Optional[bytes] = None
    while off < n:
        ln, off = _varint(data_field, off)
        if off + ln > n:
            raise PbfError("chunk Delta truncado")
        chunk = zlib.decompress(data_field[off:off + ln])
        off += ln
        if prev is not None:
            chunk = bytes(a ^ b for a, b in zip(prev, chunk))
        prev = chunk
        chunks.append(chunk)
    return b"".join(chunks)


def parse_container(data: bytes) -> Iterator[Tuple[str, bytes]]:
    """Itera blobs do container PBF: (tipo, payload decomprimido).

    Aceita arquivo com magic "pbf" (7 bytes) ou sem magic (stream de
    blobs a partir do byte 0).
    """
    off = 0
    if data[:3] == b"pbf":
        off = 7
    elif data[:4] == b"\x00\x00\x00\x00":
        raise PbfError("começo de arquivo inesperado (nem magic nem blob)")
    n = len(data)
    while off < n:
        if off + 4 > n:
            raise PbfError("tamanho de BlobHeader truncado")
        (hlen,) = struct.unpack(">I", data[off:off + 4])
        off += 4
        if off + hlen > n:
            raise PbfError("BlobHeader truncado")
        header = data[off:off + hlen]
        off += hlen
        tipo = b""
        datasize = 0
        for field, wire, p in read_pb(header):
            if field == 1 and wire == 2:
                tipo = p
            elif field == 3 and wire == 0:
                datasize = int.from_bytes(p, "big")
        if not datasize:
            raise PbfError(f"BlobHeader {tipo!r} sem datasize")
        if off + datasize > n:
            raise PbfError("Blob truncado")
        blob = data[off:off + datasize]
        off += datasize
        if tipo == b"OSMHeader":
            _decode_blob(blob)  # valida; conteúdo ignorado
            continue
        if tipo == b"Delta":
            data_field = None
            for field, wire, p in read_pb(blob):
                if field == 3 and wire == 2:
                    data_field = p
            if data_field is None:
                raise PbfError("bloco Delta sem zlib_data")
            yield "OSMData", _delta_chunks(data_field)
        elif tipo == b"OSMData":
            _t, payload = _decode_blob(blob)
            yield "OSMData", payload
        else:
            raise PbfError(f"tipo de blob desconhecido: {tipo!r}")


# ---------------- PrimitiveBlock ----------------

def _string_table(p: bytes) -> List[str]:
    """StringTable{repeated bytes s = 1}; índice 0 = string vazia."""
    st: List[str] = []
    for field, wire, s in read_pb(p):
        if field == 1 and wire == 2:
            st.append(s.decode("utf-8", "replace"))
    if not st:
        st = [""]
    return st


def _tags(keys: List[int], vals: List[int], st: List[str]) -> Dict[str, str]:
    if len(keys) != len(vals):
        raise PbfError("keys/vals divergem")
    return {st[k]: st[v] for k, v in zip(keys, vals)}


def _deg(v: int, offset: int, gran: int) -> float:
    return (v * gran + offset) / 1e9


def _iter_group(g: bytes, st: List[str], gran: int,
                lat_off: int, lon_off: int) -> Iterator[Dict]:
    for field, wire, p in read_pb(g):
        if field == 1 and wire == 2:  # Node esparsos
            nid = nlat = nlon = 0
            keys: List[int] = []
            vals: List[int] = []
            for f2, w2, p2 in read_pb(p):
                if f2 == 1 and w2 == 0:
                    nid = _zigzag(int.from_bytes(p2, "big"))
                elif f2 == 2 and w2 == 2:
                    keys = _packed(p2, signed=False)
                elif f2 == 3 and w2 == 2:
                    vals = _packed(p2, signed=False)
                elif f2 == 8 and w2 == 0:
                    nlat = _zigzag(int.from_bytes(p2, "big"))
                elif f2 == 9 and w2 == 0:
                    nlon = _zigzag(int.from_bytes(p2, "big"))
            yield {
                "id": nid, "kind": "node",
                "lat": _deg(nlat, lat_off, gran),
                "lon": _deg(nlon, lon_off, gran),
                "tags": _tags(keys, vals, st),
            }
        elif field == 2 and wire == 2:  # DenseNodes
            ids: List[int] = []
            lats: List[int] = []
            lons: List[int] = []
            kv: List[int] = []
            for f2, w2, p2 in read_pb(p):
                if f2 == 1 and w2 == 2:
                    ids = _packed(p2, signed=True)
                elif f2 == 8 and w2 == 2:
                    lats = _packed(p2, signed=True)
                elif f2 == 9 and w2 == 2:
                    lons = _packed(p2, signed=True)
                elif f2 == 10 and w2 == 2:
                    kv = _packed(p2, signed=False)
            if not (len(ids) == len(lats) == len(lons)):
                raise PbfError("DenseNodes: id/lat/lon divergem")
            cur_id = cur_lat = cur_lon = 0
            i = 0  # índice em kv
            for (nid_d, lat_d, lon_d) in zip(ids, lats, lons):
                cur_id += nid_d
                cur_lat += lat_d
                cur_lon += lon_d
                tags: Dict[str, str] = {}
                while i < len(kv):
                    k = kv[i]
                    i += 1
                    if k == 0:
                        break
                    if i >= len(kv):
                        raise PbfError("DenseNodes: kv sem terminador")
                    v = kv[i]
                    i += 1
                    tags[st[k]] = st[v]
                yield {
                    "id": cur_id, "kind": "node",
                    "lat": _deg(cur_lat, lat_off, gran),
                    "lon": _deg(cur_lon, lon_off, gran),
                    "tags": tags,
                }
        elif field == 3 and wire == 2:  # Way
            wid = 0
            keys: List[int] = []
            vals: List[int] = []
            refs_raw: List[int] = []
            for f2, w2, p2 in read_pb(p):
                if f2 == 1 and w2 == 0:
                    wid = int.from_bytes(p2, "big")
                elif f2 == 2 and w2 == 2:
                    keys = _packed(p2, signed=False)
                elif f2 == 3 and w2 == 2:
                    vals = _packed(p2, signed=False)
                elif f2 == 8 and w2 == 2:
                    refs_raw = _packed(p2, signed=True)
            refs: List[int] = []
            cur = 0
            for r in refs_raw:
                cur += r
                refs.append(cur)
            if refs:
                yield {
                    "id": wid, "kind": "way",
                    "refs": refs,
                    "tags": _tags(keys, vals, st),
                }
        # field 4 (relations) e demais: pulos


def iter_features(path: str) -> Iterator[Dict]:
    """Itera todas as features (nós e ways) de um PBF, com tags decodificados.

    Nós: ``{"id", "kind": "node", "lat", "lon", "tags"}`` (graus WGS84).
    Ways: ``{"id", "kind": "way", "refs": [ids dos nós], "tags"}`` (sem
    coordenadas; use o índice de nós para posicionar).
    Relações são puladas.
    """
    with open(path, "rb") as f:
        data = f.read()
    for _tipo, payload in parse_container(data):
        # payload = PrimitiveBlock (1 blob por bloco)
        for block in (payload,):
            st = [""]
            gran = 100
            lat_off = lon_off = 0
            groups: List[bytes] = []
            for field, wire, p in read_pb(block):
                if field == 1 and wire == 2:
                    st = _string_table(p)
                elif field == 2 and wire == 2:
                    groups.append(p)
                elif field == 17 and wire == 0:
                    gran = int.from_bytes(p, "big", signed=True) or 100
                elif field == 19 and wire == 0:
                    lat_off = int.from_bytes(p, "big", signed=True)
                elif field == 20 and wire == 0:
                    lon_off = int.from_bytes(p, "big", signed=True)
            for g in groups:
                yield from _iter_group(g, st, gran, lat_off, lon_off)
