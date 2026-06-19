#!/usr/bin/env python3
# Regenerate the BhatBot app icon from the Desktop-HUD reticle motif.
# Full-bleed dark bg; reticle kept inside a safe zone so iOS corner-rounding
# never clips it (old icon's outer ring bled off every edge).
import math, sys, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 4                      # supersample
OUT = 1024
S = OUT * SS
C = S / 2
BG = (9, 13, 19)            # #090d13

def font(px):
    for p in ["/System/Library/Fonts/Menlo.ttc",
              "/System/Library/Fonts/SFNSMono.ttf",
              "/System/Library/Fonts/Supplemental/Courier New Bold.ttf"]:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, px, index=1) if p.endswith("ttc") else ImageFont.truetype(p, px)
            except Exception: pass
    return ImageFont.load_default()

# ---- background: radial navy gradient + vignette -----------------------------
import numpy as np
yy, xx = np.mgrid[0:S, 0:S]
d = np.sqrt((xx - C) ** 2 + (yy - C) ** 2) / (C)
d = np.clip(d, 0, 1)
core = np.array([16, 30, 44]); edge = np.array([6, 9, 14])
grad = (core[None, None, :] * (1 - d[..., None]) + edge[None, None, :] * d[..., None])
bg = Image.fromarray(grad.astype("uint8"), "RGB")

# faint star particles for depth (subtle, HUD-clean)
rng = np.random.default_rng(7)
draw = ImageDraw.Draw(bg)
for _ in range(140):
    px, py = rng.uniform(0, S), rng.uniform(0, S)
    r = rng.uniform(1.0, 3.2) * SS
    a = int(rng.uniform(20, 90))
    draw.ellipse([px - r, py - r, px + r, py + r], fill=(120, 200, 235))

base = bg.convert("RGBA")

# ---- reticle layers (drawn bright; a blurred copy becomes the glow) ----------
ink = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(ink)

def ring(r, w, col, a=255):
    bb = [C - r, C - r, C + r, C + r]
    d.ellipse(bb, outline=col + (a,), width=int(w))

def dashed_ring(r, w, col, dash_deg, gap_deg, a=255):
    bb = [C - r, C - r, C + r, C + r]
    ang = 0.0
    while ang < 360:
        d.arc(bb, ang, ang + dash_deg, fill=col + (a,), width=int(w))
        ang += dash_deg + gap_deg

R = S * 0.36                                  # outer ring radius -> 0.72 dia, ~14% margin
dashed_ring(R,            0.009 * S, (10, 74, 99),  6.5, 4.2, 255)
dashed_ring(S * 0.27,     0.006 * S, (0, 200, 255), 4.5, 5.0, 200)
ring(S * 0.16,            0.006 * S, (127, 227, 255), 255)

# center glow dot
cr = S * 0.072
d.ellipse([C - cr, C - cr, C + cr, C + cr], fill=(189, 239, 255, 255))

# glow = blurred copy of ink, added under the crisp ink
glow = ink.filter(ImageFilter.GaussianBlur(S * 0.012))
glow2 = ink.filter(ImageFilter.GaussianBlur(S * 0.045))
comp = Image.alpha_composite(base, glow2)
comp = Image.alpha_composite(comp, glow)
comp = Image.alpha_composite(comp, ink)

# ---- SB monogram -------------------------------------------------------------
d2 = ImageDraw.Draw(comp)
f = font(int(S * 0.072))
tb = d2.textbbox((0, 0), "SB", font=f)
tw, th = tb[2] - tb[0], tb[3] - tb[1]
d2.text((C - tw / 2 - tb[0], C - th / 2 - tb[1]), "SB", font=f, fill=(4, 34, 46, 255))

# ---- downscale + export ------------------------------------------------------
final = comp.convert("RGB").resize((OUT, OUT), Image.LANCZOS)
dst = sys.argv[1] if len(sys.argv) > 1 else "icon-1024.png"
final.save(dst)
for sz, name in [(512, "icon-512.png"), (192, "icon-192.png")]:
    p = os.path.join(os.path.dirname(dst) or ".", name)
    final.resize((sz, sz), Image.LANCZOS).save(p)
    print("wrote", p)
print("wrote", dst)
