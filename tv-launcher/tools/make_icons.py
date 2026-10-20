"""Draws the app icon and the Android TV banner (run once; the PNGs are committed)."""
import sys
from PIL import Image, ImageDraw, ImageFont

RES = sys.argv[1]
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
TOP, BOTTOM = (26, 43, 94), (6, 10, 23)


def gradient(w, h):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / w + y / h) / 2
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
    return img


def house(draw, cx, cy, size, color):
    """A simple house: roof triangle over a body with a door."""
    s = size
    draw.polygon([(cx - s * 0.55, cy - s * 0.05), (cx, cy - s * 0.5), (cx + s * 0.55, cy - s * 0.05)], fill=color)
    draw.rectangle([cx - s * 0.38, cy - s * 0.08, cx + s * 0.38, cy + s * 0.42], fill=color)
    draw.rectangle([cx - s * 0.1, cy + s * 0.12, cx + s * 0.1, cy + s * 0.42], fill=TOP)


def icon(px):
    scale = 4  # draw big, shrink for smooth edges
    big = px * scale
    img = gradient(big, big).convert("RGBA")
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=big // 5, fill=255)
    img.putalpha(mask)
    house(ImageDraw.Draw(img), big / 2, big / 2, big * 0.62, (255, 255, 255, 255))
    return img.resize((px, px), Image.LANCZOS)


def banner(w=320, h=180):
    scale = 4
    img = gradient(w * scale, h * scale)
    d = ImageDraw.Draw(img)
    house(d, 58 * scale, 90 * scale, 62 * scale, (255, 255, 255))
    font = ImageFont.truetype(FONT, 38 * scale)
    d.text((100 * scale, 90 * scale), "TV Home", font=font, fill=(255, 255, 255), anchor="lm")
    return img.resize((w, h), Image.LANCZOS)


icon(96).save(f"{RES}/mipmap-xhdpi/ic_launcher.png")
icon(144).save(f"{RES}/mipmap-xxhdpi/ic_launcher.png")
banner().save(f"{RES}/drawable-xhdpi/banner.png")
