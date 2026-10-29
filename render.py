"""Compositing and publication-quality export for MicroFig.

The browser computes the figure layout and posts a "render plan": a flat list of
drawing items in figure units.  This module is a pure renderer for that plan, so
what you see in the preview is exactly what lands in the SVG.

Levels math is intentionally duplicated in static/app.js -- keep the two in sync.
"""
from __future__ import annotations

import base64
import io
import math
import os
import xml.sax.saxutils as sax
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from imgio import STORE

MM_PER_INCH = 25.4

_FONT_DIRS = [
    "/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts",
    os.path.expanduser("~/Library/Fonts"), "C:/Windows/Fonts",
    "/usr/share/fonts", "/usr/local/share/fonts",
]
_FONT_FILES = {
    ("arial", False, False): ["Arial.ttf", "Helvetica.ttc", "DejaVuSans.ttf"],
    ("arial", True, False): ["Arial Bold.ttf", "Arial-Bold.ttf", "Helvetica.ttc", "DejaVuSans-Bold.ttf"],
    ("arial", False, True): ["Arial Italic.ttf", "Arial-Italic.ttf", "DejaVuSans-Oblique.ttf"],
    ("arial", True, True): ["Arial Bold Italic.ttf", "DejaVuSans-BoldOblique.ttf"],
    ("helvetica", False, False): ["Helvetica.ttc", "Arial.ttf", "DejaVuSans.ttf"],
    ("helvetica", True, False): ["Helvetica.ttc", "Arial Bold.ttf", "DejaVuSans-Bold.ttf"],
    ("times new roman", False, False): ["Times New Roman.ttf", "Times.ttc", "DejaVuSerif.ttf"],
    ("times new roman", True, False): ["Times New Roman Bold.ttf", "DejaVuSerif-Bold.ttf"],
}
_font_cache: Dict[tuple, ImageFont.FreeTypeFont] = {}


def hex_to_rgb(color: str) -> Tuple[float, float, float]:
    c = (color or "#ffffff").lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    try:
        return (int(c[0:2], 16) / 255.0, int(c[2:4], 16) / 255.0, int(c[4:6], 16) / 255.0)
    except ValueError:
        return (1.0, 1.0, 1.0)


def hex_to_rgb255(color: str) -> Tuple[int, int, int]:
    r, g, b = hex_to_rgb(color)
    return (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))


def flatten_rgba(img: Image.Image, background: str) -> Image.Image:
    """Composite onto `background` for formats with no alpha channel.  An unparsed
    background (e.g. "none", for a transparent canvas) falls back to white via
    hex_to_rgb's own ValueError handling -- the sensible default when a format can't
    keep the transparency the user actually asked for."""
    if img.mode != "RGBA":
        return img
    base = Image.new("RGB", img.size, hex_to_rgb255(background))
    base.paste(img, mask=img.split()[-1])
    return base


# --------------------------------------------------------------------------
# channel compositing
# --------------------------------------------------------------------------

def apply_levels(plane: np.ndarray, black: float, white: float, gamma: float,
                 gain: float) -> np.ndarray:
    """Raw plane -> float32 intensity in [0, 1]."""
    white = float(white)
    black = float(black)
    if white <= black:
        white = black + 1e-6
    v = (plane.astype(np.float32) - black) / (white - black)
    np.clip(v, 0.0, 1.0, out=v)
    g = float(gamma) if gamma and gamma > 0 else 1.0
    if abs(g - 1.0) > 1e-6:
        v **= (1.0 / g)
    if abs(float(gain) - 1.0) > 1e-6:
        v *= float(gain)
        np.clip(v, 0.0, 1.0, out=v)
    return v


def composite(stack: np.ndarray, channels: Sequence[dict], blend: str = "add",
              invert: bool = False, background: str = "#000000") -> np.ndarray:
    """(C, Y, X) raw stack + channel specs -> uint8 (Y, X, 3)."""
    if not len(channels):
        h, w = stack.shape[1], stack.shape[2]
        bg = np.array(hex_to_rgb(background), dtype=np.float32)
        return (np.ones((h, w, 3), np.float32) * bg * 255).astype(np.uint8)

    h, w = stack.shape[1], stack.shape[2]
    out = np.zeros((h, w, 3), dtype=np.float32)
    for spec in channels:
        idx = int(spec.get("index", 0))
        if idx < 0 or idx >= stack.shape[0]:
            continue
        v = apply_levels(stack[idx], spec.get("black", 0), spec.get("white", 65535),
                         spec.get("gamma", 1.0), spec.get("gain", 1.0))
        color = np.array(hex_to_rgb(spec.get("color", "#ffffff")), dtype=np.float32)
        contrib = v[:, :, None] * color[None, None, :]
        if blend == "max":
            np.maximum(out, contrib, out=out)
        elif blend == "screen":
            out = 1.0 - (1.0 - out) * (1.0 - contrib)
        else:
            out += contrib
    np.clip(out, 0.0, 1.0, out=out)
    if invert:
        out = 1.0 - out
    return (out * 255.0 + 0.5).astype(np.uint8)


def _crop_stack(stack: np.ndarray, sx: float, sy: float, sw: float, sh: float) -> np.ndarray:
    """Crop with zero padding so ROIs may hang off the edge of the image."""
    H, W = stack.shape[1], stack.shape[2]
    x0, y0 = int(math.floor(sx)), int(math.floor(sy))
    x1, y1 = int(math.ceil(sx + sw)), int(math.ceil(sy + sh))
    x1 = max(x1, x0 + 1)
    y1 = max(y1, y0 + 1)
    if x0 >= 0 and y0 >= 0 and x1 <= W and y1 <= H:
        return stack[:, y0:y1, x0:x1]
    out = np.zeros((stack.shape[0], y1 - y0, x1 - x0), dtype=stack.dtype)
    cx0, cy0 = max(x0, 0), max(y0, 0)
    cx1, cy1 = min(x1, W), min(y1, H)
    if cx1 > cx0 and cy1 > cy0:
        out[:, cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0] = stack[:, cy0:cy1, cx0:cx1]
    return out


def render_panel(item: dict, out_w: int, out_h: int,
                 resample: int = Image.LANCZOS) -> Optional[Image.Image]:
    """Render one panel item to an RGB PIL image of the requested pixel size."""
    stack = STORE.array(item.get("image_id", ""), float(item.get("rotation", 0) or 0))
    if stack is None:
        return None
    src = item.get("src") or {}
    sub = _crop_stack(stack, float(src.get("x", 0)), float(src.get("y", 0)),
                      float(src.get("w", stack.shape[2])), float(src.get("h", stack.shape[1])))

    out_w = max(1, int(round(out_w)))
    out_h = max(1, int(round(out_h)))
    # Downsample the raw planes before compositing when we are shrinking a lot --
    # much faster and gives proper area averaging instead of point sampling.
    if sub.shape[2] > out_w * 2 and sub.shape[1] > out_h * 2:
        fy = max(1, sub.shape[1] // max(out_h, 1))
        fx = max(1, sub.shape[2] // max(out_w, 1))
        ny = (sub.shape[1] // fy) * fy
        nx = (sub.shape[2] // fx) * fx
        sub = sub[:, :ny, :nx].reshape(sub.shape[0], ny // fy, fy, nx // fx, fx).mean(axis=(2, 4))

    rgb = composite(sub, item.get("channels") or [], item.get("blend", "add"),
                    bool(item.get("invert", False)), item.get("background", "#000000"))
    img = Image.fromarray(rgb, mode="RGB")
    if img.size != (out_w, out_h):
        img = img.resize((out_w, out_h), resample)
    return img


# --------------------------------------------------------------------------
# SVG output
# --------------------------------------------------------------------------

def _fmt(v: float) -> str:
    return f"{float(v):.3f}".rstrip("0").rstrip(".") or "0"


def _dash(item: dict) -> str:
    d = item.get("dash")
    return f' stroke-dasharray="{sax.escape(str(d))}"' if d else ""


def _png_data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True, compress_level=6)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _panel_pixels(item: dict, mm_per_unit: float, dpi: int, allow_upsample: bool) -> Tuple[int, int]:
    """How many pixels the embedded raster needs for the requested output DPI."""
    w_mm = float(item["w"]) * mm_per_unit
    h_mm = float(item["h"]) * mm_per_unit
    px_w = max(1, int(round(w_mm / MM_PER_INCH * dpi)))
    px_h = max(1, int(round(h_mm / MM_PER_INCH * dpi)))
    src = item.get("src") or {}
    native_w = max(1, int(round(float(src.get("w", px_w)))))
    native_h = max(1, int(round(float(src.get("h", px_h)))))
    if not allow_upsample:
        # never invent detail that is not in the data
        if px_w > native_w:
            scale = native_w / px_w
            px_w, px_h = native_w, max(1, int(round(px_h * scale)))
    return px_w, px_h


def build_svg(plan: dict) -> str:
    width = float(plan.get("width", 1000))
    height = float(plan.get("height", 1000))
    dpi = int(plan.get("dpi", 300))
    allow_upsample = bool(plan.get("allow_upsample", False))
    font_family = plan.get("font_family", "Arial")
    bg = plan.get("background", "#000000")

    phys_w_mm = plan.get("physical_width_mm")
    if not phys_w_mm:
        phys_w_mm = width / dpi * MM_PER_INCH
    phys_w_mm = float(phys_w_mm)
    phys_h_mm = phys_w_mm * height / width if width else phys_w_mm
    mm_per_unit = phys_w_mm / width if width else 1.0

    parts: List[str] = []
    parts.append('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')
    parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'version="1.1" width="{_fmt(phys_w_mm)}mm" height="{_fmt(phys_h_mm)}mm" '
        f'viewBox="0 0 {_fmt(width)} {_fmt(height)}">'
    )
    parts.append(f'<desc>MicroFig export - {dpi} dpi raster, vector annotation</desc>')
    if bg and bg.lower() not in ("none", "transparent"):
        parts.append(f'<rect x="0" y="0" width="{_fmt(width)}" height="{_fmt(height)}" fill="{sax.escape(bg)}"/>')

    for n, item in enumerate(plan.get("items", [])):
        kind = item.get("type")
        if kind == "panel":
            px_w, px_h = _panel_pixels(item, mm_per_unit, dpi, allow_upsample)
            img = render_panel(item, px_w, px_h)
            if img is None:
                continue
            uri = _png_data_uri(img)
            label = sax.escape(str(item.get("id", f"panel{n}")))
            parts.append(
                f'<image id="{label}" x="{_fmt(item["x"])}" y="{_fmt(item["y"])}" '
                f'width="{_fmt(item["w"])}" height="{_fmt(item["h"])}" '
                f'preserveAspectRatio="none" image-rendering="optimizeQuality" '
                f'xlink:href="{uri}"/>'
            )
        elif kind == "rect":
            fill = item.get("fill") or "none"
            stroke = item.get("stroke") or "none"
            sw = item.get("stroke_width", 1)
            rx = f' rx="{_fmt(item["rx"])}"' if item.get("rx") else ""
            parts.append(
                f'<rect x="{_fmt(item["x"])}" y="{_fmt(item["y"])}" width="{_fmt(item["w"])}" '
                f'height="{_fmt(item["h"])}"{rx} fill="{sax.escape(str(fill))}" '
                f'stroke="{sax.escape(str(stroke))}" stroke-width="{_fmt(sw)}"{_dash(item)}/>'
            )
        elif kind == "line":
            parts.append(
                f'<line x1="{_fmt(item["x1"])}" y1="{_fmt(item["y1"])}" x2="{_fmt(item["x2"])}" '
                f'y2="{_fmt(item["y2"])}" stroke="{sax.escape(str(item.get("stroke", "#fff")))}" '
                f'stroke-width="{_fmt(item.get("stroke_width", 1))}" '
                f'stroke-linecap="{sax.escape(str(item.get("linecap", "butt")))}"{_dash(item)}/>'
            )
        elif kind == "text":
            anchor = {"start": "start", "middle": "middle", "end": "end"}.get(
                item.get("anchor", "start"), "start")
            # Illustrator ignores dominant-baseline, so bake the shift into y and
            # always emit alphabetic -- keeps text where the preview put it.
            size_ = float(item.get("size", 12))
            ty = float(item["y"])
            baseline = item.get("baseline", "alphabetic")
            if baseline in ("middle", "central"):
                ty += size_ * 0.355
            elif baseline == "hanging":
                ty += size_ * 0.8
            baseline = "alphabetic"
            family = item.get("family") or font_family
            weight = item.get("weight", "normal")
            style = "italic" if item.get("italic") else "normal"
            rot = float(item.get("rotate", 0) or 0)
            transform = (f' transform="rotate({_fmt(rot)} {_fmt(item["x"])} {_fmt(ty)})"'
                         if rot else "")
            parts.append(
                f'<text x="{_fmt(item["x"])}" y="{_fmt(ty)}"{transform} '
                f'font-family="{sax.escape(str(family))}" font-size="{_fmt(item.get("size", 12))}" '
                f'font-weight="{sax.escape(str(weight))}" font-style="{style}" '
                f'fill="{sax.escape(str(item.get("fill", "#ffffff")))}" text-anchor="{anchor}" '
                + (f'stroke="{sax.escape(str(item["stroke"]))}" '
                   f'stroke-width="{_fmt(item.get("stroke_width", 1))}" '
                   f'paint-order="stroke" stroke-linejoin="round" '
                   if item.get("stroke") and item["stroke"] != "none" else "")
                + f'dominant-baseline="{sax.escape(str(baseline))}" '
                f'xml:space="preserve">{sax.escape(str(item.get("text", "")))}</text>'
            )
    parts.append("</svg>")
    return "\n".join(parts)


# --------------------------------------------------------------------------
# raster output
# --------------------------------------------------------------------------

def _load_font(family: str, size: int, weight: str, italic: bool) -> ImageFont.FreeTypeFont:
    key = (family.lower(), size, weight, italic)
    if key in _font_cache:
        return _font_cache[key]
    bold = str(weight).lower() in ("bold", "600", "700", "800", "900")
    candidates = _FONT_FILES.get((family.lower(), bold, bool(italic)))
    if not candidates:
        candidates = _FONT_FILES.get((family.lower(), bold, False)) or []
        candidates = candidates + ["Arial.ttf", "Helvetica.ttc", "DejaVuSans.ttf"]
    font = None
    for name in candidates:
        for d in _FONT_DIRS:
            p = os.path.join(d, name)
            if os.path.exists(p):
                try:
                    font = ImageFont.truetype(p, size)
                    break
                except Exception:
                    continue
        if font:
            break
    if font is None:
        try:
            import matplotlib
            p = os.path.join(os.path.dirname(matplotlib.__file__),
                             "mpl-data", "fonts", "ttf", "DejaVuSans.ttf")
            font = ImageFont.truetype(p, size)
        except Exception:
            font = ImageFont.load_default()
    _font_cache[key] = font
    return font


def build_raster(plan: dict, scale: Optional[float] = None) -> Image.Image:
    width = float(plan.get("width", 1000))
    height = float(plan.get("height", 1000))
    dpi = int(plan.get("dpi", 300))
    phys_w_mm = plan.get("physical_width_mm") or (width / dpi * MM_PER_INCH)
    if scale is None:
        scale = (float(phys_w_mm) / MM_PER_INCH * dpi) / width if width else 1.0
    scale = max(0.05, float(scale))

    W = max(1, int(round(width * scale)))
    H = max(1, int(round(height * scale)))
    bg = plan.get("background", "#000000")
    transparent = str(bg).lower() in ("none", "transparent")
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0) if transparent else hex_to_rgb255(bg) + (255,))
    draw = ImageDraw.Draw(canvas)

    for item in plan.get("items", []):
        kind = item.get("type")
        if kind == "panel":
            px_w = max(1, int(round(float(item["w"]) * scale)))
            px_h = max(1, int(round(float(item["h"]) * scale)))
            img = render_panel(item, px_w, px_h)
            if img is None:
                continue
            canvas.paste(img, (int(round(float(item["x"]) * scale)),
                               int(round(float(item["y"]) * scale))))
        elif kind == "rect":
            x0 = float(item["x"]) * scale
            y0 = float(item["y"]) * scale
            x1 = x0 + float(item["w"]) * scale
            y1 = y0 + float(item["h"]) * scale
            fill = item.get("fill")
            fill_rgb = None if not fill or fill == "none" else hex_to_rgb255(fill) + (255,)
            stroke = item.get("stroke")
            stroke_rgb = None if not stroke or stroke == "none" else hex_to_rgb255(stroke) + (255,)
            sw = max(1, int(round(float(item.get("stroke_width", 1)) * scale)))
            draw.rectangle([x0, y0, x1, y1], fill=fill_rgb, outline=stroke_rgb, width=sw)
        elif kind == "line":
            draw.line([float(item["x1"]) * scale, float(item["y1"]) * scale,
                       float(item["x2"]) * scale, float(item["y2"]) * scale],
                      fill=hex_to_rgb255(item.get("stroke", "#ffffff")) + (255,),
                      width=max(1, int(round(float(item.get("stroke_width", 1)) * scale))))
        elif kind == "text":
            size = max(1, int(round(float(item.get("size", 12)) * scale)))
            font = _load_font(item.get("family") or plan.get("font_family", "Arial"), size,
                              item.get("weight", "normal"), bool(item.get("italic")))
            anchor_map = {"start": "l", "middle": "m", "end": "r"}
            ax = anchor_map.get(item.get("anchor", "start"), "l")
            baseline = item.get("baseline", "alphabetic")
            ay = {"alphabetic": "s", "hanging": "a", "middle": "m", "central": "m"}.get(baseline, "s")
            xy = (float(item["x"]) * scale, float(item["y"]) * scale)
            color = hex_to_rgb255(item.get("fill", "#ffffff")) + (255,)
            rot = float(item.get("rotate", 0) or 0)
            text = str(item.get("text", ""))
            halo = item.get("stroke")
            hw = (max(1, int(round(float(item.get("stroke_width", 1)) * scale)))
                  if halo and halo != "none" else 0)
            kw = dict(stroke_width=hw, stroke_fill=hex_to_rgb255(halo) + (255,)) if hw else {}
            if not rot:
                draw.text(xy, text, font=font, fill=color, anchor=ax + ay, **kw)
            else:
                tmp = Image.new("RGBA", (max(8, size * (len(text) + 2)), size * 3), (0, 0, 0, 0))
                td = ImageDraw.Draw(tmp)
                td.text((tmp.width / 2, tmp.height / 2), text, font=font, fill=color, anchor="mm", **kw)
                tmp = tmp.rotate(-rot, expand=True, resample=Image.BICUBIC)
                canvas.alpha_composite(tmp, (int(xy[0] - tmp.width / 2), int(xy[1] - tmp.height / 2)))

    return canvas if transparent else canvas.convert("RGB")
