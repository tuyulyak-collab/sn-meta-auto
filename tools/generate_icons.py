#!/usr/bin/env python3
"""Generate brutalism SN Meta Auto icons (16/48/128).

No external deps — writes minimal PNG files using Python's zlib.
"""

import os
import struct
import zlib

COLOR_BG = (255, 77, 0)        # #FF4D00 primary orange
COLOR_BORDER = (17, 17, 17)    # #111111
COLOR_ACCENT = (249, 217, 35)  # #F9D923
COLOR_WHITE = (255, 255, 255)


def make_rgba_canvas(size, fill=(0, 0, 0, 0)):
    return [[fill for _ in range(size)] for _ in range(size)]


def draw_rect(canvas, x0, y0, x1, y1, color):
    size = len(canvas)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(size, x1), min(size, y1)
    for y in range(y0, y1):
        row = canvas[y]
        for x in range(x0, x1):
            row[x] = color


def draw_border(canvas, color, thickness):
    size = len(canvas)
    draw_rect(canvas, 0, 0, size, thickness, color)
    draw_rect(canvas, 0, size - thickness, size, size, color)
    draw_rect(canvas, 0, 0, thickness, size, color)
    draw_rect(canvas, size - thickness, 0, size, size, color)


def write_png(path, canvas):
    size = len(canvas)
    raw = bytearray()
    for row in canvas:
        raw.append(0)  # filter type none
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def rgba(c, a=255):
    return (c[0], c[1], c[2], a)


def draw_icon(size):
    c = make_rgba_canvas(size, fill=rgba(COLOR_WHITE))
    # background orange panel
    pad = max(1, size // 16)
    draw_rect(c, pad, pad, size - pad, size - pad, rgba(COLOR_BG))
    # accent corner
    draw_rect(c, pad, pad, size // 2, size // 2, rgba(COLOR_ACCENT))
    # thick black border
    bw = max(2, size // 10)
    draw_border(c, rgba(COLOR_BORDER), bw)
    # "SN" glyph (simplified — thick black bars)
    cx = size // 2
    cy = size // 2
    bar = max(2, size // 12)
    draw_rect(c, cx - bar * 2, cy - bar * 3, cx + bar * 2, cy - bar * 2, rgba(COLOR_BORDER))
    draw_rect(c, cx - bar * 2, cy + bar * 2, cx + bar * 2, cy + bar * 3, rgba(COLOR_BORDER))
    draw_rect(c, cx - bar * 2, cy - bar, cx + bar * 2, cy, rgba(COLOR_BORDER))
    return c


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 48, 128):
        canvas = draw_icon(s)
        path = os.path.join(out_dir, f"icon{s}.png")
        write_png(path, canvas)
        print(f"wrote {path} ({s}x{s})")


if __name__ == "__main__":
    main()
