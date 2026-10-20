"""Draws the Yeghadam mark and writes every icon size the extension and the Android app need.

The mark is one step: a hollow ring (where you are) and, one step over, a solid lime dot (where it is cheaper).
Small sizes use a thicker ring so it stays crisp.

    python scripts/make-icons.py
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
INK = (21, 25, 46, 255)        # #15192E
LIME = (197, 240, 74, 255)     # #C5F04A
WHITE = (255, 255, 255, 255)
SS = 8  # supersampling


def draw(size):
    S = size * SS
    u = S / 512  # design grid is 512
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    g = ImageDraw.Draw(img)
    g.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=INK)

    small = size <= 32
    # ring: you are here
    rc, rr, rw = ((166, 338), 78, 34) if small else ((168, 336), 66, 26)
    g.ellipse([(rc[0] - rr) * u, (rc[1] - rr) * u, (rc[0] + rr) * u, (rc[1] + rr) * u], outline=WHITE, width=int(rw * u))
    # dot: one step over, cheaper
    dc, dr = ((344, 180), 104) if small else ((340, 186), 98)
    g.ellipse([(dc[0] - dr) * u, (dc[1] - dr) * u, (dc[0] + dr) * u, (dc[1] + dr) * u], fill=LIME)
    return img.resize((size, size), Image.LANCZOS)


def save(path, size):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    draw(size).save(full)
    print('wrote', path, size)


if __name__ == '__main__':
    for s in (16, 32, 48, 128):
        save(f'extension/icons/icon{s}.png', s)
    for name, s in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
        save(f'android/app/src/main/res/mipmap-{name}/ic_launcher.png', s)
    save('brand/icon-512.png', 512)
