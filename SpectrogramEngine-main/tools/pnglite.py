"""Minimal RGB8 PNG read/write using only the Python standard library (zlib).

Just enough to support the engine's correctness checks without numpy/PIL:
the engine writes 8-bit, non-interlaced, truecolor-RGB PNGs, so that's all this
handles. Not a general PNG codec.
"""

import struct
import zlib


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def read_png_rgb(path):
    """Return (width, height, rows) where rows[y] is a bytes object of RGB triples."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"not a PNG file: {path}")
    pos = 8
    width = height = None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length  # length(4) + type(4) + data + crc(4)
        if ctype == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", body[:10])
            interlace = body[12]
            if bit_depth != 8 or color_type != 2 or interlace != 0:
                raise ValueError("expected 8-bit non-interlaced RGB PNG")
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break

    raw = zlib.decompress(bytes(idat))
    bpp = 3
    stride = width * bpp
    rows = []
    prev = bytearray(stride)
    i = 0
    for _y in range(height):
        ftype = raw[i]
        i += 1
        cur = bytearray(raw[i:i + stride])
        i += stride
        if ftype == 1:  # Sub
            for x in range(bpp, stride):
                cur[x] = (cur[x] + cur[x - bpp]) & 0xFF
        elif ftype == 2:  # Up
            for x in range(stride):
                cur[x] = (cur[x] + prev[x]) & 0xFF
        elif ftype == 3:  # Average
            for x in range(stride):
                a = cur[x - bpp] if x >= bpp else 0
                cur[x] = (cur[x] + ((a + prev[x]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for x in range(stride):
                a = cur[x - bpp] if x >= bpp else 0
                c = prev[x - bpp] if x >= bpp else 0
                cur[x] = (cur[x] + _paeth(a, prev[x], c)) & 0xFF
        elif ftype != 0:
            raise ValueError(f"unsupported PNG filter {ftype}")
        rows.append(bytes(cur))
        prev = cur
    return width, height, rows


def write_png_rgb(path, width, height, rows):
    """Write rows (each a bytes/bytearray of width*3 RGB) to an 8-bit RGB PNG."""
    def chunk(typ, payload):
        return (struct.pack(">I", len(payload)) + typ + payload +
                struct.pack(">I", zlib.crc32(typ + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type: None
        raw += row
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))
