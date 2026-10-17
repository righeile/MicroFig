"""Self-check for the parts of MicroFig that can silently render the wrong thing.

    python3 selftest.py

The first checks are the ones this codebase actually needs: the levels math and
the compositor live twice, in render.py and in static/app.js, and the whole
WYSIWYG claim rests on the two agreeing.  Rather than restate them a third time,
the browser's own functions are sliced out of app.js and run under node, so a
change to either side that drifts from the other fails here.
"""
from __future__ import annotations

import json
import os
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
HAVE_NODE = shutil.which("node")


def run_js(names, driver, payload):
    """Run static/app.js's own `names` under node against `payload`."""
    src = open(APP_JS, encoding="utf-8").read()
    parts = ["const lutCache = new Map();"]
    for name in names:
        i = src.index(f"function {name}(")
        parts.append(src[i:src.index("\n}\n", i) + 2])
    parts.append(driver)
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "slice.js")
        open(f, "w", encoding="utf-8").write("\n".join(parts))
        out = subprocess.run([HAVE_NODE, f, json.dumps(payload)],
                             capture_output=True, text=True)
    if out.returncode:
        raise AssertionError(out.stderr.strip()[-800:])
    return json.loads(out.stdout)


LUT_DRIVER = """
const inp = JSON.parse(process.argv[2]);
const l = lutFor(inp.channel);
console.log(JSON.stringify(inp.raw.map(v => [l.R[v], l.G[v], l.B[v], l.P[v]])));
"""

TILE_DRIVER = """
const inp = JSON.parse(process.argv[2]);
const lvls = inp.planes.map(pd => {
  let l = { data: Uint16Array.from(pd), w: inp.w, h: inp.h };
  for (let k = 1; k < inp.k; k <<= 1) l = reduceHalf(l.data, l.w, l.h);
  return l;
});
const ds = lvls.map(l => tileFrom(l, inp.x0, inp.y0, inp.tw, inp.th));
const ls = inp.channels.map(lutFor);
const rgba = new Uint8ClampedArray(inp.tw * inp.th * 4);
compositePixels(ds, ls, inp.tw * inp.th, inp.blend, inp.invert, rgba);
console.log(JSON.stringify({ lw: lvls[0].w, lh: lvls[0].h,
                             level: Array.from(lvls[0].data),
                             tile: Array.from(ds[0]), rgba: Array.from(rgba) }));
"""

BOUNDS_DRIVER = """
const i = JSON.parse(process.argv[2]);
console.log(JSON.stringify(rotatedBounds(i.deg, i.ox, i.oy, i.rx, i.ry, i.sx, i.sy, i.w, i.h)));
"""


def browser_lut(spec, raw):
    return run_js(["lutFor"], LUT_DRIVER, {"channel": spec, "raw": raw})


def half(a):
    """What reduceHalf does: a rounded 2x2 box average, odd last row/column
    dropped -- the same trim the server's own downsampling uses."""
    h, w = a.shape
    nh, nw = max(1, h // 2), max(1, w // 2)
    r0, c0 = np.arange(nh) * 2, np.arange(nw) * 2
    dy, dx = (1 if h > 1 else 0), (1 if w > 1 else 0)
    s = (a[np.ix_(r0, c0)].astype(np.int64) + a[np.ix_(r0, c0 + dx)] +
         a[np.ix_(r0 + dy, c0)] + a[np.ix_(r0 + dy, c0 + dx)] + 2) >> 2
    return s.astype(np.uint16)


def check_levels_match():
    if not HAVE_NODE:
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


def check_tiles_match():
    """The preview composites a reduced tile of the plane rather than the whole
    thing at full resolution.  Reduce, crop and composite must each land where
    render.py lands, or a panel looks different from the file it exports to."""
    if not HAVE_NODE:
        print("  tiles: SKIPPED (no node)")
        return
    rng = np.random.default_rng(3)
    src = rng.integers(0, 4096, size=(37, 41), dtype=np.uint16)     # odd on purpose
    src[5:9, 5:9] = 4095
    specs = [dict(color="#00ff00", black=40, white=3000, gamma=1.0, gain=1.0),
             dict(color="#ff00ff", black=0, white=4095, gamma=1.8, gain=1.2)]
    cases = [(1, 0, 0, 41, 37, "add", False, 1), (2, 0, 0, 20, 18, "add", False, 1),
             (4, 0, 0, 10, 9, "max", False, 2), (2, -6, -4, 32, 32, "add", False, 2),
             (2, 8, 8, 32, 32, "screen", True, 2), (8, 0, 0, 8, 8, "add", True, 1)]
    for k, x0, y0, tw, th, blend, invert, nch in cases:
        planes = [src, (src // 3 + 200).astype(np.uint16)][:nch]
        got = run_js(["lutFor", "reduceHalf", "tileFrom", "compositePixels"], TILE_DRIVER,
                     {"planes": [p.ravel().tolist() for p in planes],
                      "w": int(src.shape[1]), "h": int(src.shape[0]), "k": k,
                      "x0": x0, "y0": y0, "tw": tw, "th": th,
                      "blend": blend, "invert": invert,
                      "channels": specs[:nch]})

        lvls = []
        for p in planes:
            a = p
            j = 1
            while j < k:
                a = half(a)
                j <<= 1
            lvls.append(a)
        assert (lvls[0].shape[1], lvls[0].shape[0]) == (got["lw"], got["lh"]), \
            f"level {k} size {got['lw']}x{got['lh']} vs {lvls[0].shape[::-1]}"
        assert np.array_equal(lvls[0].ravel(), np.array(got["level"], dtype=np.uint16)), \
            f"reduceHalf differs from a rounded box average at level {k}"

        # the crop, zero-padded exactly the way _crop_stack pads it
        stack = np.stack(lvls)
        cut = R._crop_stack(stack, x0, y0, tw, th)
        assert cut.shape == (nch, th, tw), (cut.shape, (nch, th, tw))
        assert np.array_equal(cut[0].ravel(), np.array(got["tile"], dtype=np.uint16)), \
            "tileFrom pads differently from render.py's _crop_stack"

        want = R.composite(cut, [dict(index=i, **s) for i, s in enumerate(specs[:nch])],
                           blend, invert)
        rgba = np.array(got["rgba"], dtype=np.int16).reshape(th, tw, 4)
        assert (rgba[:, :, 3] == 255).all(), "tile must be opaque"
        d = np.abs(rgba[:, :, :3].astype(int) - want.astype(int))
        tol = 0 if nch == 1 else 1     # a merge sums rounded bytes here, floats there
        assert d.max() <= tol, \
            f"tile k={k} {blend} invert={invert} {nch}ch differs by {d.max()} (tol {tol})"
    print(f"  tiles: reduce, crop and composite match render.py over {len(cases)} cases")


def bounds(deg, ox, oy, rx, ry, sx, sy, w, h):
    return run_js(["rotatedBounds"], BOUNDS_DRIVER,
                  {"deg": deg, "ox": ox, "oy": oy, "rx": rx, "ry": ry,
                   "sx": sx, "sy": sy, "w": w, "h": h})


def check_rotation_frame():
    """A rotated panel's coordinates are cut out of the stack the *server* turned,
    so the browser has to turn them back the same way round and about the same
    center.  Turning the wrong way looks plausible and puts the panel somewhere
    else entirely, which is why this is pinned to scipy rather than restated."""
    if not HAVE_NODE:
        print("  rotation: SKIPPED (no node)")
        return
    import imgio
    n = 41
    py, px = 14.0, 11.0
    ys, xs = np.mgrid[0:n, 0:n]
    for deg in (23.0, -23.0, 90.0, 7.5, 180.0):
        a = np.zeros((1, n, n), np.uint16)
        a[0, int(py), int(px)] = 20000
        rot = imgio._rotate_stack(a, deg)[0].astype(np.float64)
        # bilinear resampling spreads the mark over four pixels but keeps its
        # center of mass, so this is where the server put it
        tot = rot.sum()
        assert tot > 0, f"the mark rotated out of the frame at {deg} deg"
        qy, qx = (rot * ys).sum() / tot, (rot * xs).sum() / tot
        o = (n - 1) / 2
        x0, y0, x1, y1 = bounds(deg, o, o, 1, 1, qx, qy, 0, 0)
        assert abs(x0 - px) < 0.05 and abs(y0 - py) < 0.05, (
            f"{deg} deg: the server put ({px}, {py}) at ({qx:.2f}, {qy:.2f}); the browser "
            f"reads that back as ({x0:.2f}, {y0:.2f})")
        assert x1 == x0 and y1 == y0, "a zero-sized rect should not grow a bounding box"

        # A coarse level of a non-square plane does not halve both sides by the
        # same fraction -- 600 x 450 becomes 150 x 112 -- and turning in that
        # frame shears the picture.  The same physical point has to come back.
        rx, ry = 150 / 600, 112 / 450
        sx0, sy0, _, _ = bounds(deg, o * rx, o * ry, rx, ry, qx * rx, qy * ry, 0, 0)
        assert abs(sx0 - x0 * rx) < 1e-9 and abs(sy0 - y0 * ry) < 1e-9, (
            f"{deg} deg at rx={rx:.4f} ry={ry:.4f}: shrinking the plane and turning it "
            f"gives ({sx0:.4f}, {sy0:.4f}), turning it and shrinking "
            f"({x0 * rx:.4f}, {y0 * ry:.4f})")

    # and a real rectangle has to contain its own turned corners
    x0, y0, x1, y1 = bounds(30.0, 20.0, 20.0, 1, 1, 4.0, 6.0, 10.0, 8.0)
    assert x1 - x0 > 10 and y1 - y0 > 8, "the box must cover the turned rectangle"
    print("  rotation: the browser turns a panel back the way scipy turned it")


def check_merge_within_one():
    """Merges sum bytes on the client and floats on the server, so they are close
    but not identical -- one level, and no more, is the documented tolerance."""
    if not HAVE_NODE:
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


def check_thumbnail_scene_hidden():
    """Zeiss LSM keeps a reduced RGB thumbnail beside every image, and bioio
    offers it as a second scene.  Pick it and the figure gets a 128x128 preview
    instead of the data, so imgio drops the scenes carrying an S axis -- unless
    that is all there is, as in a plain RGB file."""
    import imgio

    class Dims:
        def __init__(self, order): self.order = order
    class Fake:
        def __init__(self, orders): self.scenes = [f"Image:{i}" for i in range(len(orders))]; self._o = orders; self.i = 0
        def set_scene(self, i): self.i = i
        @property
        def dims(self): return Dims(self._o[self.i])

    assert imgio._real_scenes(Fake(["TCZYX", "TCZYXS"])) == [0]        # LSM: image + thumbnail
    assert imgio._real_scenes(Fake(["TCZYXS"])) == [0]                 # plain RGB: keep the only one
    assert imgio._real_scenes(Fake(["TCZYX", "TCZYX"])) == [0, 1]      # two real scenes, both kept
    assert imgio._real_scenes(Fake(["TCZYXS", "TCZYX"])) == [1]        # thumbnail need not be last
    print("  scenes: the LSM thumbnail is hidden, real scenes are not")


if __name__ == "__main__":
    print("MicroFig self-check")
    check_levels_match()
    check_tiles_match()
    check_rotation_frame()
    check_merge_within_one()
    check_flatten_background()
    check_svg_background()
    check_plane_clamp()
    check_thumbnail_scene_hidden()
    print("all checks passed")
