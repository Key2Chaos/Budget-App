"""Generate the app's PNG icons (no dependencies). Run: python tools/make_icons.py
iOS needs PNG for apple-touch-icon; it applies its own rounded mask, so these are full-bleed squares."""
import os, struct, zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
TOP, BOTTOM = (0x7B, 0x61, 0xFF), (0x58, 0x56, 0xD6)
# Three rising bars, in a 0..1 unit square: (x0, y0, x1, y1)
BARS = [(0.22, 0.56, 0.36, 0.78), (0.43, 0.42, 0.57, 0.78), (0.64, 0.24, 0.78, 0.78)]
RADIUS = 0.035
SS = 4  # supersampling per axis


def in_round_rect(px, py, r):
    x0, y0, x1, y1 = r
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    cx = min(max(px, x0 + RADIUS), x1 - RADIUS)
    cy = min(max(py, y0 + RADIUS), y1 - RADIUS)
    return (px - cx) ** 2 + (py - cy) ** 2 <= RADIUS ** 2


def render(size):
    rows = []
    for y in range(size):
        t = y / (size - 1)
        bg = [round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)]
        row = bytearray([0])
        for x in range(size):
            hits = 0
            # quick reject: only supersample near bars
            ux, uy = (x + 0.5) / size, (y + 0.5) / size
            if any(b[0] - 0.01 <= ux <= b[2] + 0.01 and b[1] - 0.01 <= uy <= b[3] + 0.01 for b in BARS):
                for sy in range(SS):
                    for sx in range(SS):
                        px, py = (x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size
                        if any(in_round_rect(px, py, b) for b in BARS):
                            hits += 1
            a = hits / (SS * SS)
            row += bytes(round(bg[i] * (1 - a) + 255 * a) for i in range(3))
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', raw) + chunk(b'IEND', b''))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, size in [('apple-touch-icon.png', 180), ('icon-192.png', 192), ('icon-512.png', 512)]:
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(render(size))
        print('wrote', name)
