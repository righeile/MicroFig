"""Image loading, metadata extraction and caching for MicroFig.

Supports CZI, (OME-)TIFF, LSM, ND2, LIF, DeltaVision, Slidebook, PNG/JPG --
anything bioio can open -- plus the ones it reaches only through a JVM: Leica
LOF/XLEF, Olympus OIB/OIF/OIR, Abberior OBF/MSR, Imaris, Zeiss ZVI, TILLvisION.
Everything is normalized to a (C, Y, X) uint16 array plus a metadata record.
"""
from __future__ import annotations

import os
import threading
import uuid
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Tuple

import numpy as np

RASTER_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".gif"}
# bioio reads these through bioio-bioformats only, which needs a JVM, so they
# have readers of their own below, each on a pure-Python library.
LEICA_EXT = {".lof", ".xlef", ".xlif", ".xlcf"}     # .lif stays with bioio-lif
OWN_EXT = {".vws", ".zvi", ".oib", ".oif", ".oir", ".ims", ".obf", ".msr"} | LEICA_EXT
# tifffile reads these, bioio-tifffile just does not claim the extension
TIFF_EXT = {".stk", ".btf", ".tf8"}
SUPPORTED_EXT = {
    ".czi", ".tif", ".tiff", ".ome.tif", ".ome.tiff", ".lsm", ".nd2",
    ".lif", ".dv", ".r3d", ".sldy",
} | OWN_EXT | TIFF_EXT | RASTER_EXT

# Fallback colors cycled through when a file gives us no color hints.
DEFAULT_COLORS = ["#00FF00", "#FF00FF", "#00FFFF", "#FFFF00", "#FF0000", "#FFFFFF"]

# Emission-wavelength -> display color, used when the channel name carries a dye
# or laser line (very common in CZI channel names such as "Alexa 488").
_DYE_HINTS: List[Tuple[Tuple[str, ...], str]] = [
    (("dapi", "hoechst", "405", "bfp", "cfp"), "#0000FF"),
    (("488", "gfp", "alexa 488", "fitc", "egfp", "atto488"), "#00FF00"),
    (("555", "561", "tritc", "cy3", "rfp", "dsred", "mcherry", "594", "568"), "#FF00FF"),
    (("633", "647", "cy5", "alexa 647", "atto647", "far red", "farred", "660"), "#FF0000"),
    (("phase", "dic", "trans", "t pmt", "brightfield", "bf"), "#FFFFFF"),
]


def guess_color(name: str, index: int) -> str:
    low = (name or "").lower()
    for keys, color in _DYE_HINTS:
        if any(k in low for k in keys):
            return color
    return DEFAULT_COLORS[index % len(DEFAULT_COLORS)]


@dataclass
class ChannelMeta:
    index: int
    name: str
    color: str
    lo: float          # low autoscale suggestion (raw units)
    hi: float          # high autoscale suggestion (raw units)
    dmin: float        # actual data minimum
    dmax: float        # actual data maximum
    histogram: List[int] = field(default_factory=list)
    hist_min: float = 0.0
    hist_max: float = 65535.0


@dataclass
class ImageMeta:
    id: str
    path: str
    name: str
    width: int
    height: int
    n_channels: int
    n_z: int
    n_t: int
    n_scenes: int
    dtype: str
    bit_depth: int
    pixel_size_um: Optional[float]
    pixel_size_source: str
    channels: List[ChannelMeta]

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


class _Entry:
    __slots__ = ("meta", "data", "nbytes", "rotated_cache")

    def __init__(self, meta: ImageMeta, data: np.ndarray):
        self.meta = meta
        self.data = data
        self.nbytes = int(data.nbytes)
        self.rotated_cache: Dict[float, np.ndarray] = {}


class ImageStore:
    """In-memory LRU cache of decoded stacks, capped by total bytes."""

    def __init__(self, max_bytes: int = 3_500_000_000):
        self.max_bytes = max_bytes
        self._entries: Dict[str, _Entry] = {}
        self._order: List[str] = []
        self._by_key: Dict[str, str] = {}
        self._lock = threading.RLock()

    def _evict(self) -> None:
        total = sum(e.nbytes for e in self._entries.values())
        while total > self.max_bytes and len(self._order) > 1:
            victim = self._order.pop(0)
            entry = self._entries.pop(victim, None)
            if entry is not None:
                total -= entry.nbytes
                self._by_key = {k: v for k, v in self._by_key.items() if v != victim}

    def _touch(self, image_id: str) -> None:
        if image_id in self._order:
            self._order.remove(image_id)
        self._order.append(image_id)

    def load(self, path: str, t: int = 0, z_mode: str = "max", z_index: int = 0,
             scene: int = 0) -> ImageMeta:
        key = f"{os.path.abspath(path)}|{os.path.getmtime(path)}|{t}|{z_mode}|{z_index}|{scene}"
        with self._lock:
            if key in self._by_key:
                image_id = self._by_key[key]
                if image_id in self._entries:
                    self._touch(image_id)
                    return self._entries[image_id].meta

        data, meta_kwargs = _read_file(path, t=t, z_mode=z_mode, z_index=z_index, scene=scene)
        image_id = uuid.uuid4().hex[:12]
        channels = _describe_channels(data, meta_kwargs.pop("channel_names"))
        meta = ImageMeta(
            id=image_id,
            path=os.path.abspath(path),
            name=os.path.basename(path),
            width=int(data.shape[2]),
            height=int(data.shape[1]),
            n_channels=int(data.shape[0]),
            channels=channels,
            **meta_kwargs,
        )
        with self._lock:
            self._entries[image_id] = _Entry(meta, data)
            self._by_key[key] = image_id
            self._touch(image_id)
            self._evict()
        return meta

    def get(self, image_id: str) -> Optional[_Entry]:
        with self._lock:
            entry = self._entries.get(image_id)
            if entry is not None:
                self._touch(image_id)
            return entry

    def array(self, image_id: str, rotation: float = 0.0) -> Optional[np.ndarray]:
        entry = self.get(image_id)
        if entry is None:
            return None
        if not rotation:
            return entry.data
        key = round(float(rotation) % 360.0, 4)
        if key == 0.0:
            return entry.data
        cached = entry.rotated_cache.get(key)
        if cached is None:
            cached = _rotate_stack(entry.data, key)
            entry.rotated_cache.clear()          # only keep the current angle
            entry.rotated_cache[key] = cached
        return cached

    def stats(self) -> dict:
        with self._lock:
            return {
                "images": len(self._entries),
                "bytes": sum(e.nbytes for e in self._entries.values()),
                "max_bytes": self.max_bytes,
            }


def _rotate_stack(data: np.ndarray, angle: float) -> np.ndarray:
    from scipy.ndimage import rotate as ndrotate
    out = ndrotate(data, angle, axes=(2, 1), reshape=False, order=1,
                   mode="constant", cval=0, prefilter=False)
    return np.clip(out, 0, 65535).astype(np.uint16)


def _describe_channels(data: np.ndarray, names: List[str]) -> List[ChannelMeta]:
    channels = []
    for i in range(data.shape[0]):
        plane = data[i]
        # Subsample large planes for the statistics; results are indistinguishable
        # and it keeps loading snappy on 2k x 2k stacks.
        sample = plane[::2, ::2] if plane.size > 4_000_000 else plane
        dmin = float(sample.min())
        dmax = float(sample.max())
        lo, hi = np.percentile(sample, [0.35, 99.85])
        lo, hi = float(lo), float(hi)
        if hi <= lo:
            hi = lo + 1.0
        hist_max = max(dmax, hi, 1.0)
        counts, _ = np.histogram(sample, bins=256, range=(dmin, hist_max + 1e-6))
        name = names[i] if i < len(names) and names[i] else f"Channel {i + 1}"
        channels.append(ChannelMeta(
            index=i, name=str(name), color=guess_color(str(name), i),
            lo=lo, hi=hi, dmin=dmin, dmax=dmax,
            histogram=[int(c) for c in counts], hist_min=dmin, hist_max=hist_max + 1e-6,
        ))
    return channels


def _to_uint16(arr: np.ndarray) -> np.ndarray:
    if arr.dtype == np.uint16:
        return arr
    if arr.dtype == np.uint8:
        return arr.astype(np.uint16)
    arr = arr.astype(np.float64)
    lo, hi = float(np.nanmin(arr)), float(np.nanmax(arr))
    if hi <= lo:
        return np.zeros(arr.shape, dtype=np.uint16)
    return ((arr - lo) / (hi - lo) * 65535.0).astype(np.uint16)


def _project(stack: np.ndarray, z_mode: str, z_index: int) -> np.ndarray:
    """stack is (C, Z, Y, X) -> (C, Y, X)."""
    if stack.shape[1] == 1:
        return stack[:, 0]
    if z_mode == "max":
        return stack.max(axis=1)
    if z_mode == "mean":
        return stack.mean(axis=1)
    if z_mode == "sum":
        return np.clip(stack.astype(np.float64).sum(axis=1), 0, 65535)
    return stack[:, min(max(z_index, 0), stack.shape[1] - 1)]


def warm() -> None:
    """Import the bioformat reader up front.  It costs ~1 s, and paying it at
    startup rather than inside the first open is the difference between a figure
    that appears and one that appears after a stall."""
    try:
        from bioio import BioImage  # noqa: F401
    except Exception:
        pass


def _read_file(path: str, t: int, z_mode: str, z_index: int, scene: int):
    ext = os.path.splitext(path)[1].lower()
    if ext in RASTER_EXT:
        return _read_raster(path)
    return _read_bioformat(path, t=t, z_mode=z_mode, z_index=z_index, scene=scene)


def _read_raster(path: str):
    from PIL import Image
    img = Image.open(path)
    arr = np.array(img)
    if arr.ndim == 2:
        arr = arr[None, ...]
        names = ["Gray"]
    else:
        arr = np.transpose(arr[..., :3], (2, 0, 1))
        names = ["Red", "Green", "Blue"]
    arr = _to_uint16(arr)
    return arr, dict(
        channel_names=names, n_z=1, n_t=1, n_scenes=1,
        dtype=str(arr.dtype), bit_depth=8,
        pixel_size_um=None, pixel_size_source="none",
    )


def _real_scenes(img) -> List[int]:
    """Indices of the scenes that are actually images.

    Zeiss LSM stores a reduced RGB thumbnail next to every image, and bioio
    offers it as a second scene -- pick it and you get a 128x128 preview where
    your data should be.  The thumbnail is the scene carrying an S (samples)
    axis.  A plain RGB file has S too, but then it is the only scene, so the
    `or` below hands it back rather than leaving nothing to open.

    Probing is free: set_scene costs 0.01 ms and reads no pixels.
    """
    keep = []
    for i in range(len(img.scenes)):
        img.set_scene(i)
        if "S" not in str(img.dims.order):
            keep.append(i)
    img.set_scene(0)
    return keep or list(range(len(img.scenes)))


def _open(path: str):
    ext = os.path.splitext(path)[1].lower()
    own = {".vws": _till, ".zvi": _zvi, ".oib": _oif, ".oif": _oif, ".ims": _ims,
           ".oir": _oir, ".obf": _obf, ".msr": _obf}.get(ext)
    if ext in LEICA_EXT:
        own = _leica
    if own:
        return own(path)
    from bioio import BioImage
    if ext in (".dv", ".r3d"):
        # bioio-imageio claims .dv too (DV video), so name the reader
        import bioio_dv
        return BioImage(path, reader=bioio_dv.Reader)
    if ext in TIFF_EXT:
        import bioio_tifffile
        return BioImage(path, reader=bioio_tifffile.Reader)
    return BioImage(path)


def _read_bioformat(path: str, t: int, z_mode: str, z_index: int, scene: int):
    img = _open(path)
    try:
        scenes = _real_scenes(img)
    except Exception:
        scenes = [0]
    img.set_scene(scenes[min(max(scene, 0), len(scenes) - 1)])

    dims = img.dims
    n_t = int(getattr(dims, "T", 1) or 1)
    n_z = int(getattr(dims, "Z", 1) or 1)
    t = min(max(t, 0), n_t - 1)

    stack = img.get_image_data("CZYX", T=t)
    stack = _to_uint16(np.asarray(stack))
    planes = _project(stack, z_mode, z_index)
    planes = np.ascontiguousarray(planes.astype(np.uint16))

    try:
        names = [str(n) for n in (img.channel_names or [])]
    except Exception:
        names = []
    if len(names) < planes.shape[0]:
        names += [f"Channel {i + 1}" for i in range(len(names), planes.shape[0])]

    px, src = _physical_pixel_size(img, path)
    bit_depth = _guess_bit_depth(planes)
    return planes, dict(
        channel_names=names, n_z=n_z, n_t=n_t, n_scenes=len(scenes),
        dtype=str(planes.dtype), bit_depth=bit_depth,
        pixel_size_um=px, pixel_size_source=src,
    )


def _guess_bit_depth(planes: np.ndarray) -> int:
    peak = int(planes.max()) if planes.size else 0
    for depth in (8, 10, 12, 14, 16):
        if peak < (1 << depth):
            return depth
    return 16


def _physical_pixel_size(img, path: str) -> Tuple[Optional[float], str]:
    try:
        pps = img.physical_pixel_sizes
        x = getattr(pps, "X", None)
        if x and float(x) > 0:
            return float(x), "metadata"
    except Exception:
        pass
    ext = os.path.splitext(path)[1].lower()
    # Zeiss keeps the LSM calibration in CZ_LSM_INFO, in metres, and no bioio
    # reader looks there -- without this every LSM loads uncalibrated.
    if ext == ".lsm":
        try:
            import tifffile
            with tifffile.TiffFile(path) as tf:
                vx = (tf.lsm_metadata or {}).get("VoxelSizeX")
            if vx and float(vx) > 0:
                return float(vx) * 1e6, "lsm-metadata"
        except Exception:
            pass
    # TIFFs written by ImageJ/Fiji keep the calibration in the resolution tags.
    if ext in (".tif", ".tiff"):
        try:
            import tifffile
            with tifffile.TiffFile(path) as tf:
                page = tf.pages[0]
                res = page.tags.get("XResolution")
                unit = str(page.tags.get("ResolutionUnit").value) if page.tags.get("ResolutionUnit") else ""
                ij = getattr(tf, "imagej_metadata", None) or {}
                if res is not None:
                    num, den = res.value
                    if num:
                        per_unit = den / num
                        ijunit = str(ij.get("unit", "")).lower()
                        if ijunit in ("micron", "um", "µm", "micrometer"):
                            return float(per_unit), "tiff-imagej"
                        if "CENTIMETER" in unit.upper():
                            return float(per_unit) * 10_000.0, "tiff-resolution"
        except Exception:
            pass
    return None, "none"


# ---- formats bioio has no JVM-free reader for --------------------------------

class _Frames:
    """The slice of BioImage that _read_bioformat reads, for the formats below:
    `frame(t)` hands back one time point as (C, Z, Y, X)."""
    scenes = ("Image:0",)

    def __init__(self, frame, n_t: int, n_z: int, names: List[str], px=None):
        from types import SimpleNamespace
        self.get_image_data = lambda order, T=0: frame(T)
        self.channel_names = names
        self.dims = SimpleNamespace(T=n_t, Z=n_z, order="TCZYX")
        self.physical_pixel_sizes = SimpleNamespace(X=px)

    def set_scene(self, i: int) -> None:
        pass


class _Scenes:
    """Several _Frames behind one file, picked with set_scene: the images of a
    Leica project, the stack groups of an Abberior file."""

    def __init__(self, frames: List[_Frames]):
        if not frames:
            raise ValueError("the file holds no images")
        self.scenes = tuple(f"Image:{i}" for i in range(len(frames)))
        self._all, self._cur = frames, frames[0]

    def set_scene(self, i: int) -> None:
        self._cur = self._all[i]

    def __getattr__(self, key):
        return getattr(self._cur, key)


def _labelled(objs: list, to_um: float) -> _Frames:
    """liffile, oirfile and obffile all describe an image the same way: ordered
    `sizes`, `coords` and `asarray()` in that order, nothing read until asked.
    Several objects of one shape become the channels of one image (an OBF file
    keeps each channel as a stack of its own).  Without a channel axis, RGB
    samples or the bands of a lambda scan stand in as channels.  An axis
    MicroFig has no use for -- mosaic tiles, phase -- is cut to its first entry."""
    first = objs[0]
    spare = None if "C" in first.sizes else next((d for d in "SL" if d in first.sizes), None)
    dims = ["C" if d == spare else d for d in first.sizes]
    n = dict(zip(dims, first.sizes.values()))
    co = first.coords
    x = np.asarray(co.get("X", []), dtype=float)
    px = abs(x[-1] - x[0]) / (len(x) - 1) * to_um if len(x) > 1 else None
    if px and px > 1e4:
        px = None             # an uncalibrated image counts in pixels: a 1 m pixel
    names = []
    for o in objs:
        c = o.coords.get("C", o.coords.get(spare))
        nc = n.get("C", 1)
        if c is not None and len(c) == nc:
            names += [f"{float(v):g} nm" if spare == "L" else str(v) for v in c]
        else:
            names += [str(o.name)] if nc == 1 and len(objs) > 1 else \
                     [f"Channel {len(names) + i + 1}" for i in range(nc)]
    cache = {}

    def frame(t):
        if "a" not in cache:
            parts = []
            for o in objs:
                # ponytail: reads the whole image once; a long time series pays
                # that on every time-point change.  Read per frame if it hurts.
                a, d = np.asarray(o.asarray()), list(dims)
                for ax in [k for k in d if k not in "TCZYX"]:
                    a = a.take(0, axis=d.index(ax))
                    d.remove(ax)
                for ax in "TCZ":
                    if ax not in d:
                        a, d = a[None], [ax] + d
                parts.append(a.transpose([d.index(k) for k in "TCZYX"]))
            cache["a"] = np.concatenate(parts, axis=1)
        return cache["a"][t]

    return _Frames(frame, n.get("T", 1), n.get("Z", 1), names, px)


def _leica(path: str) -> _Scenes:
    """Leica LAS X LOF, XLEF, XLIF, XLCF, through liffile.  A project holds many
    images, one scene each; lengths are in metres."""
    import functools
    from urllib.parse import unquote
    import liffile

    class Lif(liffile.LifFile):
        # liffile opens every file a project links to, all or nothing, so one
        # missing histogram (absent even from the OME sample project) or one
        # member not copied along loses the whole project.  Skip what is missing.
        @functools.cached_property
        def children(self):
            kids = []
            for ref in self.xml_element.findall("./Element/Children/Reference"):
                if ref.attrib.get("File"):
                    name = os.path.normpath(unquote(ref.attrib["File"])).replace("\\", "/")
                    try:
                        kids.append(Lif(liffile.liffile.case_sensitive_path(
                            os.path.join(self.dirname, name)), _parent=self))
                    except (OSError, ValueError):
                        pass
            return tuple(kids)

    lif = Lif(path)                      # left open: the scenes read from it later
    return _Scenes([_labelled([im], 1e6) for im in lif.images])


def _oir(path: str) -> _Frames:
    """Olympus/Evident FluoView OIR (FV3000, FV4000), through oirfile;
    lengths are in micrometres."""
    import oirfile
    return _labelled([oirfile.OirFile(path)], 1.0)


def _obf(path: str) -> _Scenes:
    """Abberior Imspector OBF and MSR, through obffile.  Each channel and mode
    is a stack of its own; the stacks of one shape were acquired together, so
    they become the channels of one scene.  Lengths are in metres."""
    import obffile
    try:
        obf = obffile.ObfFile(path)
    except obffile.ObfFileError:
        # ponytail: Imspector also saves .msr as a serialized document ("CDataStack"
        # near the top), which only Bio-Formats' ImspectorReader parses
        raise ValueError("this .msr is an Imspector document, not OBF: "
                         "save it as .obf from Imspector") from None
    groups: Dict[tuple, list] = {}
    for st in obf.stacks:
        groups.setdefault(tuple(st.sizes.items()), []).append(st)
    return _Scenes([_labelled(g, 1e6) for g in groups.values()])


def _ole_values(b: bytes) -> list:
    """Walk a Zeiss property stream: a 2-byte VARIANT type, then its value.  Stops
    at the first type it does not know, which is where the pixels start."""
    import struct
    out, i = [], 0
    while i + 2 <= len(b):
        vt, = struct.unpack_from("<H", b, i)
        i += 2
        if vt in (2, 11):
            v, = struct.unpack_from("<h", b, i); i += 2
        elif vt in (3, 19):
            v, = struct.unpack_from("<i", b, i); i += 4
        elif vt in (5, 7):
            v, = struct.unpack_from("<d", b, i); i += 8
        elif vt == 8:
            n, = struct.unpack_from("<i", b, i); i += 4
            v = b[i:i + n].decode("utf-16-le", "replace").rstrip("\0"); i += n
        elif vt in (0, 1):
            v = None
        else:
            break
        out.append(v)
    return out


def _till(path: str) -> _Frames:
    """TILL Photonics TILLvisION.  The .vws is only the workspace; the pixels sit
    beside it in <name>.pst/, one raw .pst plus a text .inf per recording, always
    16-bit (Datatype=4 in all 86,800 headers on this machine).  A folder mixes a
    time series with single snapshots of other wavelengths, so a channel with
    fewer frames holds its last one -- the snapshot shows at every time point.
    A workspace with no folder (4 % here) either was renamed after recording and
    still names its old folder, or kept unsaved snapshots inside itself."""
    import configparser
    import glob
    import re
    try:
        import olefile
        ws = olefile.OleFileIO(path).openstream("Contents").read()
    except Exception:
        ws = b""
    here = os.path.dirname(path)
    folder = os.path.splitext(path)[0] + ".pst"
    if not glob.glob(os.path.join(folder, "*.inf")):
        # the name is length-prefixed, and the prefix byte can be printable:
        # take the first suffix that is a folder.  Anchored on the literal end:
        # pixel bytes run printable for 65 kB, and a leading [^...]+ scanned
        # them quadratically -- 4 s a workspace
        for m in re.finditer(rb"\.pst\\\w+\.pst", ws):
            name = re.search(rb"[^\x00-\x1f\\]*$", ws[max(0, m.start() - 255):m.start()])
            name = name.group().decode("latin-1") + ".pst"
            hit = next((name[k:] for k in range(len(name))
                        if os.path.isdir(os.path.join(here, name[k:]))), None)
            if hit:
                folder = os.path.join(here, hit)
                break
    infs = sorted(glob.glob(os.path.join(folder, "*.inf")))
    if not infs:
        chans = _till_embedded(ws)
        if not chans:
            raise ValueError(f"no pixels: TILLvisION keeps them in {os.path.basename(folder)}/ "
                             "next to the workspace, and it is not there")
        names = [f"snapshot {k + 1}" for k in range(len(chans))]
    else:
        chans = []
        for inf in infs:
            c = configparser.ConfigParser()
            c.read(inf)
            w, h, n = (int(c["Info"][k]) for k in ("Width", "Height", "Frames"))
            # a .pst deleted under its .inf reads as an empty recording
            pst = inf[:-4] + ".pst"
            raw = np.fromfile(pst, "<u2") if os.path.exists(pst) else np.zeros(0, "<u2")
            n = min(n, raw.size // (w * h))          # an aborted recording stops short
            chans.append(raw[:n * w * h].reshape(n, h, w))
        wl = _till_names(ws)
        names = [wl.get(os.path.basename(i)[:-4], os.path.basename(i)[:-4])
                 for i, c in zip(infs, chans) if len(c)]
        chans = [c for c in chans if len(c)]
        if not chans:
            raise ValueError("every recording in this TILLvisION workspace is empty")
    return _Frames(lambda t: np.stack([c[min(t, len(c) - 1)] for c in chans])[:, None],
                   max(len(c) for c in chans), 1, names)


def _till_embedded(ws: bytes) -> List[np.ndarray]:
    """Snapshots inside the workspace: the six numbers of an .inf header as
    int32s (width, height, bands 1, slices, frames, datatype 4), then a path,
    then the byte count twice, then the pixels."""
    import re
    import struct
    out = []
    for m in re.finditer(rb"(?s)(.{4})(.{4})\x01\0\0\0(.{4})(.{4})\x04\0\0\0", ws):
        w, h, sl, fr = (int.from_bytes(g, "little") for g in m.groups())
        if not (8 <= w <= 8192 and 8 <= h <= 8192 and 1 <= sl * fr <= 100_000):
            continue
        n = w * h * sl * fr
        j = ws.find(struct.pack("<2I", 2 * n, 2 * n), m.end(), m.end() + 400)
        if j >= 0 and j + 8 + 2 * n <= len(ws):
            out.append(np.frombuffer(ws, "<u2", n, j + 8).reshape(sl * fr, h, w))
    return [a for a in out if a.shape[1:] == out[0].shape[1:]]


def _till_names(ws: bytes) -> Dict[str, str]:
    """Each recording's excitation wavelength, out of the workspace: the
    monochromator line comes just before the .pst file it belongs to."""
    import re
    names, last = {}, None
    for m in re.finditer(rb"Monochromator wavelength \[nm\]: (\d+)|\\(\w+)\.pst", ws):
        if m.group(1):
            last = m.group(1).decode() + " nm"
        elif last:
            names[m.group(2).decode()] = last
    return names


def _zvi(path: str) -> _Frames:
    """Zeiss AxioVision ZVI: an OLE document with one Image/Item(n) stream per
    plane.  The plane ends its stream, after a block header of a 0x10002000 marker
    and six int32s (width, height, depth, bytes per pixel, format, valid bits).
    Planes are grouped into channels by their channel-name tag (1284) and kept
    in file order as time points."""
    import olefile
    import struct
    ole = olefile.OleFileIO(path)
    items = sorted(int(e[1][5:-1]) for e in ole.listdir()
                   if len(e) == 3 and e[1].startswith("Item(") and e[2] == "Contents")
    chans: Dict[str, list] = {}
    for k in items:
        b = ole.openstream(f"Image/Item({k})/Contents").read()
        i = b.find(b"\x00\x20\x00\x10")
        w, h, _, bpp, _, _ = struct.unpack_from("<6i", b, i + 4)
        # ponytail: grayscale only (1 or 2 bytes a pixel); a BGR ZVI raises here
        if bpp not in (1, 2):
            raise ValueError(f"color ZVI ({bpp} bytes a pixel) is not supported")
        plane = np.frombuffer(b, "<u2" if bpp == 2 else "u1", w * h, i + 28).reshape(h, w)
        tag = f"Image/Item({k})/Tags/Contents"
        v = _ole_values(ole.openstream(tag).read()) if ole.exists(tag) else []
        name = {v[j + 1]: v[j] for j in range(2, len(v) - 2, 3)}.get(1284) or "Channel 1"
        chans.setdefault(str(name), []).append(plane)
    # ponytail: Z and T both arrive as frames -- every ZVI here is a time series;
    # split on the index tags (2820/2821) if a z-stack ever turns up
    stacks = [np.stack(p) for p in chans.values()]
    n_t = min(len(s) for s in stacks)
    px = None
    if ole.exists("Image/Scaling/Contents"):
        v = _ole_values(ole.openstream("Image/Scaling/Contents").read())
        if len(v) > 4 and v[4] == 76 and v[3]:   # unit code 76 is micrometres
            px = float(v[3])
    return _Frames(lambda t: np.stack([s[t] for s in stacks])[:, None],
                   n_t, 1, list(chans), px)


def _oif(path: str) -> _Frames:
    """Olympus FluoView OIB (one OLE file) and OIF (a text file plus a folder of
    TIFFs), through oiffile.  Read whole: FluoView stacks are small enough."""
    import re
    import oiffile
    with oiffile.OifFile(path) as f:
        a, axes, m = f.asarray(), f.axes, f.mainfile
    for ax in [x for x in axes if x not in "TCZYX"]:      # lambda, line scans ...
        a, axes = a.take(0, axis=axes.index(ax)), axes.replace(ax, "")
    for ax in "TCZ":
        if ax not in axes:
            a, axes = a[None], ax + axes
    a = a.transpose([axes.index(x) for x in "TCZYX"])
    ref = m.get("Reference Image Parameter", {})
    px = ref.get("WidthConvertValue") if str(ref.get("WidthUnit", "")).lower() == "um" else None
    # a German FluoView writes "0,207.0": the leading number, comma as the point
    px = re.match(r"\d+(?:[.,]\d+)?", str(px or ""))
    px = float(px.group().replace(",", ".")) if px else None
    names = [str(m.get(f"Channel {c + 1} Parameters", {}).get("DyeName") or f"Channel {c + 1}")
             for c in range(a.shape[1])]
    return _Frames(lambda t: a[t], a.shape[0], a.shape[2], names, px)


def _ims(path: str) -> _Frames:
    """Imaris (.ims), which is HDF5: DataSet/ResolutionLevel 0/TimePoint t/
    Channel c/Data holds (Z, Y, X), padded out to whole chunks -- the true size
    is in DataSetInfo/Image, whose attributes are arrays of single bytes."""
    import h5py
    import hdf5plugin  # noqa: F401 -- registers LZ4 and friends, which Imaris 9+ writes
    f = h5py.File(path, "r")

    def attr(group, key, default=""):
        a = f[group].attrs.get(key) if group in f else None
        return a.tobytes().decode() if a is not None else default

    info = "DataSetInfo/Image"
    X, Y, Z = (int(attr(info, k)) for k in "XYZ")
    px = None
    if attr(info, "Unit", "um").lower() in ("um", "µm", "micron"):
        px = (float(attr(info, "ExtMax0", "0")) - float(attr(info, "ExtMin0", "0"))) / X or None
    res = f["DataSet/ResolutionLevel 0"]
    n_c = len(res["TimePoint 0"])
    names = [attr(f"DataSetInfo/Channel {c}", "Name") or f"Channel {c + 1}" for c in range(n_c)]
    return _Frames(lambda t: np.stack([res[f"TimePoint {t}/Channel {c}/Data"][:Z, :Y, :X]
                                       for c in range(n_c)]),
                   len(res), Z, names, px)


STORE = ImageStore()
