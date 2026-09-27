"""Image loading, metadata extraction and caching for MicroFigure.

Supports CZI, (OME-)TIFF, LSM, PNG/JPG and anything else aicsimageio can open.
Everything is normalised to a (C, Y, X) uint16 array plus a metadata record.
"""
from __future__ import annotations

import os
import threading
import uuid
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Tuple

import numpy as np

RASTER_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".gif"}
SUPPORTED_EXT = {
    ".czi", ".tif", ".tiff", ".ome.tif", ".ome.tiff", ".lsm", ".nd2",
    ".lif", ".oib", ".oif", ".zvi", ".ims", ".sld",
} | RASTER_EXT

# Fallback colours cycled through when a file gives us no colour hints.
DEFAULT_COLORS = ["#00FF00", "#FF00FF", "#00FFFF", "#FFFF00", "#FF0000", "#FFFFFF"]

# Emission-wavelength -> display colour, used when the channel name carries a dye
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
        from aicsimageio import AICSImage  # noqa: F401
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


def _read_bioformat(path: str, t: int, z_mode: str, z_index: int, scene: int):
    from aicsimageio import AICSImage
    img = AICSImage(path)
    try:
        scenes = list(img.scenes)
    except Exception:
        scenes = ["0"]
    if len(scenes) > 1:
        img.set_scene(min(max(scene, 0), len(scenes) - 1))

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
    # TIFFs written by ImageJ/Fiji keep the calibration in the resolution tags.
    if os.path.splitext(path)[1].lower() in (".tif", ".tiff"):
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


STORE = ImageStore()
