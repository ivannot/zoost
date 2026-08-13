#!/usr/bin/env python3
"""Are two PNGs the same picture?

    python3 tools/pngsame.py a.png b.png

`siteimg.py` has had this question answered for WebP since it started leaving a file alone when the
render produced the same pixels - it shells out to `dwebp` and compares the PPM. The PNG half was
missing, and it was missing exactly where it mattered: the 1280x800 screenshots the Store takes, and
any comparison between two ways of capturing the same page. Two PNGs of one picture routinely differ
in their bytes - the encoder is free to choose filters and deflate settings - so `cmp` answers a
question nobody asked.

Written here rather than taken from a library because there is none on this machine and because the
subset needed is small: these files are 8-bit RGB or RGBA, non-interlaced, which is what Chrome
writes. Anything else is refused loudly rather than guessed at, since a comparison that quietly does
not understand its input is worse than no comparison.
"""
import pathlib
import struct
import sys
import zlib


def chunks(raw: bytes):
    """The PNG chunk stream, after the 8-byte signature."""
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    i = 8
    while i < len(raw):
        (length,) = struct.unpack(">I", raw[i:i + 4])
        kind = raw[i + 4:i + 8]
        yield kind, raw[i + 8:i + 8 + length]
        i += 8 + length + 4                      # +4 for the CRC, which zlib would only re-check


def pixels(path: pathlib.Path):
    """(width, height, channels, raw rows) with the row filters undone.

    Undoing the filters is the whole of the work: PNG stores each row with one of five predictors,
    chosen by the encoder for compression, so two encoders can store identical pixels as completely
    different bytes. That is the difference this exists to see through.
    """
    raw = path.read_bytes()
    w = h = depth = colour = None
    data = bytearray()
    for kind, body in chunks(raw):
        if kind == b"IHDR":
            w, h, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body[:13])
            if depth != 8 or colour not in (2, 6) or interlace:
                raise ValueError(f"{path.name}: only 8-bit RGB/RGBA non-interlaced is understood "
                                 f"(depth={depth}, colour={colour}, interlace={interlace})")
        elif kind == b"IDAT":
            data += body
        elif kind == b"IEND":
            break
    if w is None:
        raise ValueError(f"{path.name}: no header")
    ch = 3 if colour == 2 else 4
    flat = zlib.decompress(bytes(data))
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = flat[pos]; pos += 1
        row = bytearray(flat[pos:pos + stride]); pos += stride
        if f == 1:                                              # Sub
            for x in range(ch, stride):
                row[x] = (row[x] + row[x - ch]) & 0xFF
        elif f == 2:                                            # Up
            for x in range(stride):
                row[x] = (row[x] + prev[x]) & 0xFF
        elif f == 3:                                            # Average
            for x in range(stride):
                left = row[x - ch] if x >= ch else 0
                row[x] = (row[x] + ((left + prev[x]) >> 1)) & 0xFF
        elif f == 4:                                            # Paeth
            for x in range(stride):
                a = row[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[x] = (row[x] + pr) & 0xFF
        elif f != 0:
            raise ValueError(f"{path.name}: unknown row filter {f}")
        out[y * stride:(y + 1) * stride] = row
        prev = row
    return w, h, ch, bytes(out)


def compare(a: pathlib.Path, b: pathlib.Path):
    """(same, message). Never raises for a difference - only for a file it cannot read."""
    wa, ha, ca, pa = pixels(a)
    wb, hb, cb, pb = pixels(b)
    if (wa, ha) != (wb, hb):
        return False, f"different size: {wa}x{ha} against {wb}x{hb}"
    if ca != cb:
        return False, f"different channels: {ca} against {cb}"
    if pa == pb:
        return True, f"same picture: {wa}x{ha}, {len(pa):,} bytes of pixels"
    diff = sum(1 for i in range(0, len(pa), ca) if pa[i:i + ca] != pb[i:i + ca])
    worst = max(abs(x - y) for x, y in zip(pa, pb))
    pct = 100.0 * diff / (wa * ha)
    return False, (f"{diff:,} of {wa * ha:,} pixels differ ({pct:.3f}%), "
                   f"worst channel difference {worst}/255")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().split("\n\n")[1])
        return 2
    a, b = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    same, why = compare(a, b)
    print(("same  " if same else "differ") + "  " + why)
    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main())
