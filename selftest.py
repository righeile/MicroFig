"""Self-check for the parts of MicroFigure that can silently render the wrong thing.

    python3 selftest.py

The first check is the one this codebase actually needs: the levels maths lives
twice, in render.py and in static/app.js, and the whole WYSIWYG claim rests on
the two agreeing.  Rather than restate it a third time, the browser's lutFor is
sliced out of app.js and run under node, so a change to either side that drifts
from the other fails here.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R                                                  # noqa: E402

APP_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "app.js")
LEVELS = [(0, 65535, 1.0, 1.0, "#00ff00"), (120, 4000, 1.0, 1.0, "#ff00ff"),
          (0, 4095, 0.45, 1.0, "#00ffff"), (300, 20000, 2.2, 1.7, "#ffff00"),
          (10, 11, 1.0, 1.0, "#ffffff")]
RAW = [0, 1, 9, 10, 11, 119, 120, 121, 500, 4000, 4095, 20000, 32768, 65534, 65535]


def browser_lut(spec, raw):
    """Run static/app.js's own lutFor under node and read back its bytes."""
    src = open(APP_JS, encoding="utf-8").read()
    i = src.index("function lutFor(")
    body = src[i:src.index("\n}\n", i) + 2]
    js = ("const lutCache = new Map();\n" + body +
          "\nconst l = lutFor(JSON.parse(process.argv[2]));"
          "\nconsole.log(JSON.stringify(JSON.parse(process.argv[3])"
          ".map(v => [l.R[v], l.G[v], l.B[v], l.P[v]])));")
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "lut.js")
        open(f, "w", encoding="utf-8").write(js)
        out = subprocess.run([shutil.which("node"), f, json.dumps(spec), json.dumps(raw)],
                             capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def check_levels_match():
    if not shutil.which("node"):
        print("  levels: SKIPPED (no node) -- the browser half cannot be run here")
        return
    for black, white, gamma, gain, color in LEVELS:
        spec = dict(color=color, black=black, white=white, gamma=gamma, gain=gain)
        got = browser_lut(spec, RAW)
        want = R.composite(np.array(RAW, dtype=np.uint16).reshape(1, 1, -1),
                           [dict(index=0, **spec)])[0]
        for v, (r, g, b, packed), py in zip(RAW, got, want):
            assert (r, g, b) == tuple(int(x) for x in py), \
                f"levels drift at raw={v} {spec}: browser {(r, g, b)} vs render.py {tuple(py)}"
            assert packed == (0xFF000000 | b << 16 | g << 8 | r), \
                f"packed LUT word disagrees with its own bytes at raw={v}"
    print(f"  levels: browser and render.py agree exactly "
          f"({len(LEVELS)} settings x {len(RAW)} raw values)")


def check_merge_within_one():
    """Merges sum bytes on the client and floats on the server, so they are close
    but not identical -- one level, and no more, is the documented tolerance."""
    if not shutil.which("node"):
        return
    specs = [dict(color="#00ff00", black=0, white=4095, gamma=1.0, gain=1.0),
             dict(color="#ff00ff", black=200, white=3000, gamma=1.6, gain=1.0)]
    luts = [browser_lut(s, RAW) for s in specs]
    stack = np.array([RAW, RAW], dtype=np.uint16).reshape(2, 1, -1)
    want = R.composite(stack, [dict(index=i, **s) for i, s in enumerate(specs)])[0]
    for k, v in enumerate(RAW):
        for ch in range(3):
            client = min(255, luts[0][k][ch] + luts[1][k][ch])
            assert abs(client - int(want[k][ch])) <= 1, \
                f"merge differs by more than one level at raw={v}: {client} vs {want[k][ch]}"
    print("  merge: additive blend within one level of the server")


def check_flatten_background():
    """A transparent canvas exported to a format with no alpha used to come out
    black whatever background was asked for."""
    img = Image.new("RGBA", (2, 2), (0, 0, 0, 0))
    img.putpixel((0, 0), (10, 20, 30, 255))
    assert R.flatten_rgba(img, "#204080").getpixel((1, 1)) == (32, 64, 128)
    assert R.flatten_rgba(img, "#204080").getpixel((0, 0)) == (10, 20, 30)
    assert R.flatten_rgba(img, "none").getpixel((1, 1)) == (255, 255, 255)
    assert R.flatten_rgba(Image.new("RGB", (2, 2), (1, 2, 3)), "#000000").mode == "RGB"
    print("  flatten: transparency lands on the named background, white for 'none'")


def check_svg_background():
    plan = dict(width=100, height=50, dpi=300, items=[])
    assert '<rect' in R.build_svg({**plan, "background": "#ffffff"})
    assert '<rect' not in R.build_svg({**plan, "background": "none"})
    assert 'width="8.467mm"' in R.build_svg({**plan, "background": "none"})
    # _fmt must not eat a trailing zero that belongs to the integer part
    assert R._fmt(1000) == "1000" and R._fmt(0) == "0" and R._fmt(0.5) == "0.5"
    print("  svg: background rect only when opaque, physical size intact")


def check_plane_clamp():
    """?max=0 once downsampled a plane to nothing, which handed the browser a
    0 x 0 canvas and killed the preview."""
    import app as A
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "probe.png")
        Image.fromarray(np.arange(64 * 64, dtype=np.uint16).reshape(64, 64) % 255,
                        mode="L").save(path)
        meta = A.STORE.load(path)
        client = A.app.test_client()
        for q in ("0", "-5", "1", "1400", "99999"):
            r = client.get(f"/api/image/{meta.id}/plane/0?max={q}")
            assert r.status_code == 200, (q, r.status_code)
            assert int(r.headers["X-Width"]) >= 1 and int(r.headers["X-Height"]) >= 1, q
            assert len(r.data) == int(r.headers["X-Width"]) * int(r.headers["X-Height"]) * 2, q
        assert client.get(f"/api/image/{meta.id}/plane/9").status_code == 400
        assert client.get("/api/image/nope/plane/0").status_code == 404
    print("  plane: every requested size returns a usable plane")


if __name__ == "__main__":
    print("MicroFigure self-check")
    check_levels_match()
    check_merge_within_one()
    check_flatten_background()
    check_svg_background()
    check_plane_clamp()
    print("all checks passed")
