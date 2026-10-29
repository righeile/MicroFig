"""MicroFig -- a local web app for building publication figures from
microscopy images (CZI / TIFF / OME-TIFF / LSM / ND2 / ...).

Run:  python app.py     then open http://127.0.0.1:5678
"""
from __future__ import annotations

import io
import json
import os
import sys
import traceback
import webbrowser
from threading import Thread, Timer

import numpy as np
from flask import Flask, Response, jsonify, request, send_file, send_from_directory

from imgio import STORE, SUPPORTED_EXT, warm as warm_readers
from labkit import browse as LKB
import render as R

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PRESET_DIR = os.path.join(APP_DIR, "presets")
SESSION_DIR = os.path.join(APP_DIR, "sessions")
UPLOAD_DIR = os.path.join(APP_DIR, ".uploads")
os.makedirs(PRESET_DIR, exist_ok=True)
os.makedirs(SESSION_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 ** 3


@app.errorhandler(Exception)
def _on_error(err):
    from werkzeug.exceptions import HTTPException
    if isinstance(err, HTTPException):
        return err
    traceback.print_exc()
    return jsonify({"error": f"{type(err).__name__}: {err}"}), 500


@app.route("/favicon.ico")
def favicon():
    return Response(b"", mimetype="image/x-icon")


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# --------------------------------------------------------------------------
# file system browsing
# --------------------------------------------------------------------------

# The listing is labkit's, so this is the same dialog as in the other five
# tools.  The formats it shows are still this app's own -- SUPPORTED_EXT lives
# in imgio.py and is passed in rather than restated in JavaScript.
app.register_blueprint(LKB.flask_blueprint(default_extensions=SUPPORTED_EXT))


# --------------------------------------------------------------------------
# opening images
# --------------------------------------------------------------------------

@app.route("/api/open", methods=["POST"])
def open_images():
    body = request.get_json(force=True) or {}
    paths = body.get("paths") or []
    t = int(body.get("t", 0))
    z_mode = body.get("z_mode", "max")
    z_index = int(body.get("z_index", 0))
    scene = int(body.get("scene", 0))

    out, errors = [], []
    for p in paths:
        try:
            meta = STORE.load(p, t=t, z_mode=z_mode, z_index=z_index, scene=scene)
            out.append(meta.to_dict())
        except Exception as exc:
            errors.append({"path": p, "error": f"{type(exc).__name__}: {exc}"})
    return jsonify({"images": out, "errors": errors, "cache": STORE.stats()})


@app.route("/api/upload", methods=["POST"])
def upload():
    saved = []
    for f in request.files.getlist("files"):
        name = os.path.basename(f.filename or "upload.tif")
        dest = os.path.join(UPLOAD_DIR, name)
        f.save(dest)
        saved.append(dest)
    out, errors = [], []
    for p in saved:
        try:
            out.append(STORE.load(p).to_dict())
        except Exception as exc:
            errors.append({"path": p, "error": str(exc)})
    return jsonify({"images": out, "errors": errors})


@app.route("/api/image/<image_id>/plane/<int:channel>")
def plane(image_id: str, channel: int):
    """Raw uint16 little-endian plane, optionally downsampled, for canvas preview."""
    # a zero or silly size would downsample the plane out of existence and hand
    # the browser a 0 x 0 canvas to composite into
    max_size = max(64, min(int(request.args.get("max", 1400)), 8192))
    entry = STORE.get(image_id)
    if entry is None:
        return jsonify({"error": "image not loaded"}), 404
    data = entry.data
    if channel < 0 or channel >= data.shape[0]:
        return jsonify({"error": "bad channel"}), 400
    p = data[channel]
    h, w = p.shape
    factor = 1
    while max(h // factor, w // factor) > max_size:
        factor += 1
    if factor > 1:
        ny = (h // factor) * factor
        nx = (w // factor) * factor
        p = p[:ny, :nx].reshape(ny // factor, factor, nx // factor, factor).mean(axis=(1, 3))
        p = p.astype(np.uint16)
    p = np.ascontiguousarray(p, dtype="<u2")
    resp = Response(p.tobytes(), mimetype="application/octet-stream")
    resp.headers["X-Width"] = str(p.shape[1])
    resp.headers["X-Height"] = str(p.shape[0])
    resp.headers["X-Factor"] = str(factor)
    resp.headers["X-Source-Width"] = str(w)
    resp.headers["X-Source-Height"] = str(h)
    resp.headers["Cache-Control"] = "no-store"
    return resp


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------

def _ext(fmt: str) -> str:
    """File extension for a format -- the browser downloads TIFFs as .tif, so a
    copy saved to a folder is named the same way rather than .tiff."""
    return "tif" if fmt in ("tif", "tiff") else fmt


def _safe_name(name: str, ext: str) -> str:
    name = os.path.basename(str(name or "figure")).strip() or "figure"
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    if not name.lower().endswith("." + ext):
        name += "." + ext
    return name


@app.route("/api/export", methods=["POST"])
def export():
    body = request.get_json(force=True) or {}
    plan = body.get("plan") or {}
    fmt = (body.get("format") or "svg").lower()
    filename = _safe_name(body.get("filename") or "figure", _ext(fmt))
    out_dir = body.get("out_dir")

    if fmt == "svg":
        payload = R.build_svg(plan).encode("utf-8")
        mimetype = "image/svg+xml"
    elif fmt in ("png", "tif", "tiff"):
        img = R.build_raster(plan)
        buf = io.BytesIO()
        dpi = int(plan.get("dpi", 300))
        if fmt == "png":
            img.save(buf, format="PNG", dpi=(dpi, dpi))
            mimetype = "image/png"
        else:
            img = R.flatten_rgba(img, plan.get("background", "#000000"))
            img.save(buf, format="TIFF", dpi=(dpi, dpi), compression="tiff_lzw")
            mimetype = "image/tiff"
        payload = buf.getvalue()
    elif fmt == "pdf":
        img = R.flatten_rgba(R.build_raster(plan), plan.get("background", "#000000"))
        buf = io.BytesIO()
        img.save(buf, format="PDF", resolution=float(plan.get("dpi", 300)))
        payload, mimetype = buf.getvalue(), "application/pdf"
    else:
        return jsonify({"error": f"unsupported format {fmt}"}), 400

    if out_dir:
        out_dir = os.path.abspath(os.path.expanduser(out_dir))
        os.makedirs(out_dir, exist_ok=True)
        dest = os.path.join(out_dir, filename)
        with open(dest, "wb") as fh:
            fh.write(payload)
        return jsonify({"saved": dest, "bytes": len(payload)})

    return send_file(io.BytesIO(payload), mimetype=mimetype,
                     as_attachment=True, download_name=filename)


@app.route("/api/export/batch", methods=["POST"])
def export_batch():
    """Write many figures (one per plan) straight to disk."""
    body = request.get_json(force=True) or {}
    jobs = body.get("jobs") or []
    # No default: a batch that lands on the Desktop because nobody said where
    # is a folder of figures somebody has to tidy, and the page asks first.
    if not str(body.get("out_dir") or "").strip():
        return jsonify({"error": "say where the figures go: set an output folder"}), 400
    out_dir = os.path.abspath(os.path.expanduser(body["out_dir"]))
    fmt = (body.get("format") or "svg").lower()
    os.makedirs(out_dir, exist_ok=True)
    written, errors = [], []
    for job in jobs:
        try:
            plan = job.get("plan") or {}
            name = _safe_name(job.get("filename") or "figure", _ext(fmt))
            if fmt == "svg":
                payload = R.build_svg(plan).encode("utf-8")
            else:
                img = R.build_raster(plan)
                buf = io.BytesIO()
                dpi = int(plan.get("dpi", 300))
                if fmt == "png":
                    img.save(buf, format="PNG", dpi=(dpi, dpi))
                else:
                    R.flatten_rgba(img, plan.get("background", "#000000")).save(
                        buf, format="TIFF", dpi=(dpi, dpi), compression="tiff_lzw")
                payload = buf.getvalue()
            dest = os.path.join(out_dir, name)
            with open(dest, "wb") as fh:
                fh.write(payload)
            written.append(dest)
        except Exception as exc:
            errors.append({"filename": job.get("filename"), "error": f"{type(exc).__name__}: {exc}"})
    return jsonify({"written": written, "errors": errors, "out_dir": out_dir})


@app.route("/api/preview", methods=["POST"])
def preview():
    """Server-side render of a plan (used for the high-fidelity preview check)."""
    body = request.get_json(force=True) or {}
    plan = body.get("plan") or {}
    scale = body.get("scale")
    img = R.build_raster(plan, scale=float(scale) if scale else None)
    buf = io.BytesIO()
    R.flatten_rgba(img, plan.get("background", "#000000")).save(buf, format="PNG")
    return Response(buf.getvalue(), mimetype="image/png")


# --------------------------------------------------------------------------
# presets
# --------------------------------------------------------------------------

@app.route("/api/presets", methods=["GET"])
def list_presets():
    names = []
    for f in sorted(os.listdir(PRESET_DIR)):
        if f.endswith(".json"):
            names.append(f[:-5])
    return jsonify({"presets": names, "dir": PRESET_DIR})


@app.route("/api/presets/<name>", methods=["GET", "PUT", "DELETE"])
def preset(name: str):
    safe = _safe_name(name, "json")
    path = os.path.join(PRESET_DIR, safe)
    if request.method == "PUT":
        with open(path, "w") as fh:
            json.dump(request.get_json(force=True), fh, indent=1)
        return jsonify({"saved": safe})
    if request.method == "DELETE":
        if os.path.exists(path):
            os.remove(path)
        return jsonify({"deleted": safe})
    if not os.path.exists(path):
        return jsonify({"error": "not found"}), 404
    with open(path) as fh:
        return jsonify(json.load(fh))


@app.route("/api/sessions", methods=["GET"])
def list_sessions():
    names = []
    for f in sorted(os.listdir(SESSION_DIR)):
        if f.endswith(".json"):
            names.append(f[:-5])
    return jsonify({"sessions": names, "dir": SESSION_DIR})


@app.route("/api/sessions/<name>", methods=["GET", "PUT", "DELETE"])
def session(name: str):
    # Same shape as a preset -- a named JSON blob -- but it also carries the
    # open images' paths and their per-image edits, so loading one re-reads
    # the files from disk and puts the whole figure back where it was.
    safe = _safe_name(name, "json")
    path = os.path.join(SESSION_DIR, safe)
    if request.method == "PUT":
        with open(path, "w") as fh:
            json.dump(request.get_json(force=True), fh, indent=1)
        return jsonify({"saved": safe})
    if request.method == "DELETE":
        if os.path.exists(path):
            os.remove(path)
        return jsonify({"deleted": safe})
    if not os.path.exists(path):
        return jsonify({"error": "not found"}), 404
    with open(path) as fh:
        return jsonify(json.load(fh))


@app.route("/api/status")
def status():
    return jsonify({"ok": True, "cache": STORE.stats(), "cwd": os.getcwd()})


def main():
    # PORT first, then the app-specific name: same order as the other tools,
    # so one env var starts whichever of them you meant.
    port = int(os.environ.get("PORT") or os.environ.get("MICROFIG_PORT") or 5678)
    url = f"http://127.0.0.1:{port}"
    Thread(target=warm_readers, daemon=True).start()
    if "--no-browser" not in sys.argv:
        Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"\n  MicroFig running at {url}\n  Ctrl-C to stop\n")
    app.run(host="127.0.0.1", port=port, debug="--debug" in sys.argv, threaded=True)


if __name__ == "__main__":
    main()
