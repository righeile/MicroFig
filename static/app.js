/* MicroFig -- client.
   The layout engine here is the single source of truth: the preview draws it on a
   canvas, and export posts the very same resolved geometry to the server, which
   re-renders it at full resolution.  Levels math mirrors render.py exactly. */
'use strict';

// ===================================================================== state
const S = {
  images: [],            // {id, meta, label, enabled, crop, rotation, insets[], levels?}
  activeId: null,
  channels: [],          // global per-index channel settings
  perImageLevels: false,
  blend: 'add',
  invert: false,
  layout: {
    template: 'channels_merge', panelSize: 300, gap: 6, gridCols: 1, outerPad: 10,
    insetCount: 1, insetSize: 200, insetSizeH: 200, linkInsetSize: true,
    insetBox: true, insetLeader: false,
    insetColor: '#ffffff', insetStroke: 1.5, insetBorder: true,
    mono: 'none', monoColor: '#ffffff',
    bg: '#ffffff', bgTransparent: false,
  },
  scale: {
    on: true, len: 20, auto: true, lenInset: 5, autoInset: true,
    where: 'first', corner: 'br', thick: 4, margin: 10,
    color: '#ffffff', label: false, labelSize: 11, units: 'um',
  },
  labels: {
    font: 'Arial',
    titleMode: 'top', titleSize: 12, titleColor: '#000000', titleBold: false, titleByChannel: true,
    linkLabels: true,
    rowMode: 'left', rowSize: 12, rowWidth: 70, rowRotate: false,
    rowColor: '#000000', rowItalic: false,
    figTitle: '', figTitleSize: 14, figTitleColor: '#000000',
    letters: 'none', letterSize: 13, titleFirstOnly: false,
  },
  exp: { widthMm: 180, dpi: 300, upsample: false, name: 'figure', dir: '', format: 'svg' },
  src: { zMode: 'max', zIndex: 0, t: 0, scene: 0, previewMax: 1000 },
  textOffsets: {},   // label key -> {dx, dy, rot}: hand placement, survives a relayout
  tool: 'select', zoom: 1, showGuides: true,
};

let selText = null;  // key of the label picked up by the last click

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const NICE = [0.1,0.2,0.5,1,2,2.5,5,10,20,25,50,100,200,250,500,1000,2000,5000];

/* Named palettes use the pure primaries/secondaries -- cyan is 00FFFF, not a
   tinted approximation.  Only Okabe-Ito is deliberately off-primary: it is a
   published color-blind-safe set whose whole point is its exact hexes. */
const PALETTES = [
  { name: 'cyan/magenta/yellow/blue', colors: ['#00FFFF', '#FF00FF', '#FFFF00', '#0000FF'] },
  { name: 'green/magenta', colors: ['#00FF00', '#FF00FF', '#00FFFF', '#FFFF00'] },
  { name: 'magenta/green', colors: ['#FF00FF', '#00FF00', '#0000FF', '#FFFFFF'] },
  { name: 'classic RGB', colors: ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF'] },
  { name: 'cyan/yellow/magenta', colors: ['#00FFFF', '#FFFF00', '#FF00FF', '#FFFFFF'] },
  { name: 'Okabe-Ito', colors: ['#56B4E9', '#E69F00', '#009E73', '#CC79A7'] },
  { name: 'all gray', colors: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF'] },
];

function busy(on, text) {
  $('busy').classList.toggle('hidden', !on);
  if (text) $('busy-text').textContent = text;
}
function status(msg) { $('status').textContent = msg; }

async function jget(url) { const r = await fetch(url); return r.json(); }
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                               body: JSON.stringify(body) });
  return r.json();
}

// ============================================================ image plumbing
const planes = new Map();      // `${imgId}:${ch}` -> {data:Uint16Array, w, h, factor}

async function loadPlane(imgId, ch) {
  const key = `${imgId}:${ch}`;
  if (planes.has(key)) return planes.get(key);
  const r = await fetch(`/api/image/${imgId}/plane/${ch}?max=${S.src.previewMax}`);
  if (!r.ok) throw new Error('plane fetch failed');
  const buf = await r.arrayBuffer();
  const rec = {
    data: new Uint16Array(buf),
    w: +r.headers.get('X-Width'), h: +r.headers.get('X-Height'),
    factor: +r.headers.get('X-Factor') || 1,
  };
  planes.set(key, rec);
  return rec;
}

function clearPlanes() { planes.clear(); mips.clear(); }

async function ensurePlanes(img) {
  // In flight together: the browser caps its own connections, and the server is
  // threaded, so this is round-trips in parallel rather than one after another.
  const jobs = [];
  for (let c = 0; c < img.meta.n_channels; c++) jobs.push(loadPlane(img.id, c));
  await Promise.all(jobs);
}

function chanSettings(img) {
  return (S.perImageLevels && img && img.levels) ? img.levels : S.channels;
}

function visibleChannels(img) {
  return chanSettings(img).filter(c => c.visible);
}

// ------------------------------------------------------- composite LUT cache
const lutCache = new Map();
function lutFor(c) {
  const key = `${c.color}|${c.black}|${c.white}|${c.gamma}|${c.gain}`;
  let l = lutCache.get(key);
  if (l) return l;
  const N = 65536, R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
  const P = new Uint32Array(N);   // same values packed as one RGBA word per level
  const hex = c.color.replace('#', '');
  const cr = parseInt(hex.slice(0, 2), 16), cg = parseInt(hex.slice(2, 4), 16),
        cb = parseInt(hex.slice(4, 6), 16);
  let black = +c.black, white = +c.white;
  if (white <= black) white = black + 1e-6;
  const invSpan = 1 / (white - black), invGamma = 1 / (+c.gamma > 0 ? +c.gamma : 1);
  const gain = +c.gain;
  for (let v = 0; v < N; v++) {
    let t = (v - black) * invSpan;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (invGamma !== 1) t = Math.pow(t, invGamma);
    if (gain !== 1) { t *= gain; if (t > 1) t = 1; }
    // +0.5 because a Uint8Array store truncates while render.py rounds; without it
    // every preview pixel sits up to one level below the exported one
    R[v] = t * cr + 0.5; G[v] = t * cg + 0.5; B[v] = t * cb + 0.5;
    // ponytail: little-endian byte order, as every machine this runs on is
    P[v] = (255 << 24 | B[v] << 16 | G[v] << 8 | R[v]) >>> 0;
  }
  l = { R, G, B, P };
  if (lutCache.size > 200) lutCache.clear();
  lutCache.set(key, l);
  return l;
}

/* ---- plane pyramid ----
   A panel almost always shows fewer pixels than the plane holds: a 300-unit
   panel at 40% zoom is about 250 device pixels of a 1000-pixel plane, so
   compositing all 1,000,000 of them to draw 62,000 was most of the work in a
   redraw.  Each plane therefore keeps halved copies and the compositor reads
   the coarsest one that still has a sample per device pixel.  Averaging the raw
   plane and only then applying levels is also what render.py does before it
   composites, so this moves the preview towards the export, not away from it. */
const mips = new Map();               // `${imgId}:${ch}:${k}` -> {data, w, h}

function reduceHalf(data, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Uint16Array(nw * nh);
  const dy = h > 1 ? w : 0, dx = w > 1 ? 1 : 0;
  for (let y = 0; y < nh; y++) {
    const r0 = (y << 1) * w, r1 = r0 + dy;
    for (let x = 0, i = y * nw; x < nw; x++, i++) {
      const c0 = x << 1, c1 = c0 + dx;
      out[i] = (data[r0 + c0] + data[r0 + c1] + data[r1 + c0] + data[r1 + c1] + 2) >> 2;
    }
  }
  return { data: out, w: nw, h: nh };
}

function planeLevel(imgId, ch, k) {
  const base = planes.get(`${imgId}:${ch}`);
  if (!base || k <= 1) return base || null;
  const key = `${imgId}:${ch}:${k}`;
  let m = mips.get(key);
  if (!m) {
    const prev = planeLevel(imgId, ch, k >> 1);
    if (!prev) return null;
    m = reduceHalf(prev.data, prev.w, prev.h);
    mips.set(key, m);
  }
  return m;
}

// --------------------------------------------------- per-panel composite tiles
const compCache = new Map();          // key -> {canvas, px}
let compCachePixels = 0;
const COMP_CACHE_MAX_PX = 24e6;
const COMP_CACHE_MAX_N = 240;
// Tile origins snap to this grid so that panning slides through a tile rather
// than rebuilding one every frame; it costs up to 64 pixels of margin per side.
const TILE_GRID = 32;

function compKey(img, chList, k, x0, y0, tw, th) {
  const sig = chList.map(c => `${c.index}:${c.color}:${c.black}:${c.white}:${c.gamma}:${c.gain}`).join(',');
  return `${img.id}|${sig}|${S.blend}|${S.invert}|${k}|${x0},${y0},${tw},${th}`;
}

/* Cut tw x th out of a plane at (x0, y0), zero outside it -- the same zero
   padding render.py's _crop_stack uses, so a cut-out hanging off the edge of
   the image looks on screen the way it comes out in the file. */
function tileFrom(lvl, x0, y0, tw, th) {
  const out = new Uint16Array(tw * th);
  const sx0 = Math.max(0, x0), sx1 = Math.min(lvl.w, x0 + tw);
  const sy0 = Math.max(0, y0), sy1 = Math.min(lvl.h, y0 + th);
  if (sx1 > sx0) {
    for (let y = sy0; y < sy1; y++)
      out.set(lvl.data.subarray(y * lvl.w + sx0, y * lvl.w + sx1), (y - y0) * tw + (sx0 - x0));
  }
  return out;
}

/* The pixel loop, kept free of the DOM so selftest.py can run it against
   render.py's compositor.  `out` is RGBA, four bytes per pixel. */
function compositePixels(ds, ls, n, blend, invert, out) {
  const m = ds.length;
  if (m === 1 && !invert) {
    // One channel is the same picture under every blend, so the packed LUT can
    // go straight out as whole pixels -- the path most panels in a figure take.
    const o32 = new Uint32Array(out.buffer, out.byteOffset, n), d = ds[0], P = ls[0].P;
    for (let i = 0; i < n; i++) o32[i] = P[d[i]];
  } else if (blend === 'screen') {
    const acc = new Float32Array(n * 3);
    for (let ci = 0; ci < m; ci++) {
      const d = ds[ci], { R, G, B } = ls[ci];
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const v = d[i];
        acc[j] = 255 - (255 - acc[j]) * (255 - R[v]) / 255;
        acc[j + 1] = 255 - (255 - acc[j + 1]) * (255 - G[v]) / 255;
        acc[j + 2] = 255 - (255 - acc[j + 2]) * (255 - B[v]) / 255;
      }
    }
    for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
      let r = acc[j], g = acc[j + 1], b = acc[j + 2];
      if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
      out[k] = invert ? 255 - r : r;
      out[k + 1] = invert ? 255 - g : g;
      out[k + 2] = invert ? 255 - b : b;
      out[k + 3] = 255;
    }
  } else {
    const mx = blend === 'max';
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      let r = 0, g = 0, b = 0;
      for (let ci = 0; ci < m; ci++) {
        const p = ls[ci].P[ds[ci][i]], x = p & 255, y = (p >> 8) & 255, z = (p >> 16) & 255;
        if (mx) { if (x > r) r = x; if (y > g) g = y; if (z > b) b = z; }
        else { r += x; g += y; b += z; }
      }
      if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
      out[k] = invert ? 255 - r : r;
      out[k + 1] = invert ? 255 - g : g;
      out[k + 2] = invert ? 255 - b : b;
      out[k + 3] = 255;
    }
  }
}

function compositeTile(img, chList, k, x0, y0, tw, th) {
  const key = compKey(img, chList, k, x0, y0, tw, th);
  const hit = takeTile(key);
  if (hit) return hit;

  const ds = [], ls = [];
  for (const c of chList) {
    const lvl = planeLevel(img.id, c.index, k);
    if (!lvl) continue;
    ds.push(tileFrom(lvl, x0, y0, tw, th)); ls.push(lutFor(c));
  }
  const tile = document.createElement('canvas');
  tile.width = tw; tile.height = th;
  const ctx = tile.getContext('2d', { willReadFrequently: false });
  const id = ctx.createImageData(tw, th);
  compositePixels(ds, ls, tw * th, S.blend, S.invert, id.data);
  ctx.putImageData(id, 0, 0);

  return cacheTile(key, tile);
}

/* A hit moves back to the end of the Map, so the entry cacheTile drops is the
   one nothing has asked for in longest.  Dropping the oldest instead throws
   away a tile that is about to be drawn again the moment a figure needs more
   tiles than the cache holds. */
function takeTile(key) {
  const hit = compCache.get(key);
  if (!hit) return null;
  compCache.delete(key); compCache.set(key, hit);
  return hit.canvas;
}

function cacheTile(key, canvas) {
  const px = canvas.width * canvas.height;
  compCachePixels += px;
  compCache.set(key, { canvas, px });
  while ((compCachePixels > COMP_CACHE_MAX_PX || compCache.size > COMP_CACHE_MAX_N) &&
         compCache.size > 1) {
    const cold = compCache.keys().next().value;
    compCachePixels -= compCache.get(cold).px;
    compCache.delete(cold);
  }
  return canvas;
}

/* A rotated panel shows a rectangle of the *turned* plane, so the pixels it
   needs are that rectangle's four corners turned back into the plane's own
   frame.  Compositing their bounding box and turning that is the same picture
   as turning the whole plane and cutting the rectangle out, for a fraction of
   the pixels once the panel is a cut-out or a zoom.

   The box is clipped to the plane, and the corners the turn exposes are filled
   with the color a raw zero comes out as -- which is what the server paints
   there too, since it rotates the raw planes with cval=0 and composites
   afterwards.  Those corners used to be left transparent and show the figure
   background instead. */
function rotatedTile(img, chList, k, pl, deg, sx, sy, w, h) {
  const ow = Math.max(1, Math.ceil(w)), oh = Math.max(1, Math.ceil(h));
  const key = compKey(img, chList, k, sx, sy, ow, oh) + `|r${deg}`;
  const hit = takeTile(key);
  if (hit) return hit;

  const lvl = planeLevel(img.id, chList[0].index, k);
  const rx = lvl.w / pl.w, ry = lvl.h / pl.h;
  // scipy turns the plane about the center of its pixel grid, at (n - 1) / 2, and
  // it is the server's turn that the panel's coordinates were cut out of
  const ox = (pl.w - 1) / 2 * rx, oy = (pl.h - 1) / 2 * ry;
  const [x0, y0, x1, y1] = rotatedBounds(deg, ox, oy, rx, ry, sx, sy, ow, oh);
  const a = deg * Math.PI / 180;
  // a pixel of margin so the interpolation along the edge has a neighbor to read
  const tx = clamp(Math.floor((x0 - 1) / TILE_GRID) * TILE_GRID, 0, lvl.w);
  const ty = clamp(Math.floor((y0 - 1) / TILE_GRID) * TILE_GRID, 0, lvl.h);
  const tw = clamp(Math.ceil((x1 + 1) / TILE_GRID) * TILE_GRID - tx, 0, lvl.w - tx);
  const th = clamp(Math.ceil((y1 + 1) / TILE_GRID) * TILE_GRID - ty, 0, lvl.h - ty);

  const out = document.createElement('canvas');
  out.width = ow; out.height = oh;
  const c = out.getContext('2d');
  c.fillStyle = zeroColor(chList);
  c.fillRect(0, 0, ow, oh);
  if (tw > 0 && th > 0) {
    c.translate(-sx, -sy);
    c.translate(ox, oy); c.scale(rx, ry);           // rotatedBounds' map, forwards
    c.rotate(-a);
    c.scale(1 / rx, 1 / ry); c.translate(-ox, -oy);
    c.drawImage(compositeTile(img, chList, k, tx, ty, tw, th), tx, ty);
  }
  return cacheTile(key, out);
}

/* Where a rectangle of the turned plane comes from in the plane's own frame:
   the bounding box of its four corners, turned back.  Kept to plain arithmetic
   so selftest.py can check which way round it turns against the server's. */
function rotatedBounds(deg, ox, oy, rx, ry, sx, sy, w, h) {
  const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [qx, qy] of [[sx, sy], [sx + w, sy], [sx, sy + h], [sx + w, sy + h]]) {
    // out to the plane's own frame, turn there, back again: halving 600 x 450
    // twice gives 150 x 112, and turning in *that* frame shears the picture
    const u = (qx - ox) / rx, v = (qy - oy) / ry;
    const px = ox + (u * ca - v * sa) * rx, py = oy + (u * sa + v * ca) * ry;
    if (px < x0) x0 = px; if (px > x1) x1 = px;
    if (py < y0) y0 = py; if (py > y1) y1 = py;
  }
  return [x0, y0, x1, y1];
}

/* What a raw zero looks like once the levels, the blend and invert are through
   with it -- one pixel of the real compositor rather than a second guess. */
function zeroColor(chList) {
  const one = new Uint16Array(1), rgba = new Uint8ClampedArray(4);
  compositePixels(chList.map(() => one), chList.map(lutFor), 1, S.blend, S.invert, rgba);
  return `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`;
}

/* Only for a change of the plane data itself (a reload, a different preview
   resolution, images closed).  Color, levels, blend and invert are all part of
   compKey, so clearing the cache for those just throws away cached panels that
   are about to be asked for again. */
function invalidateComposites() { compCache.clear(); compCachePixels = 0; }

// ================================================================== geometry
function imgById(id) { return S.images.find(i => i.id === id); }
function activeImage() { return imgById(S.activeId) || S.images[0] || null; }
function figureImages() { return S.images.filter(i => i.enabled); }

function fullCrop(img) {
  const c = img.crop;
  if (c && c.w > 0 && c.h > 0) return c;
  return { x: 0, y: 0, w: img.meta.width, h: img.meta.height };
}

function insetRect(img, k) {
  const list = img.insets || [];
  if (list[k]) return list[k];
  const crop = fullCrop(img);
  const sw = Math.min(S.layout.insetSize, crop.w);
  const sh = Math.min(S.layout.insetSizeH || S.layout.insetSize, crop.h);
  return { x: crop.x + crop.w * 0.5 - sw / 2 + k * sw * 0.15,
           y: crop.y + crop.h * 0.5 - sh / 2 + k * sh * 0.15, w: sw, h: sh };
}

/* Resize cut-outs to a given source-pixel box, each about its own center so a
   ROI the user has already aimed stays aimed.  With "link across images" on
   this is how one resize reaches the whole figure. */
function applyInsetSize(w, h, opts) {
  const o = opts || {};
  const n = Math.max(1, Math.round(S.layout.insetCount) || 1);
  const targets = o.only ? [o.only] : S.images.filter(i => !o.except || i.id !== o.except.id);
  targets.forEach(img => {
    for (let k = 0; k < n; k++) {
      const r = insetRect(img, k);
      img.insets[k] = { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
    }
  });
}

function pixelSizeOf(img) {
  if (img.pixelSize != null) return img.pixelSize;
  return img.meta.pixel_size_um || null;
}

function niceBar(umWide, frac) {
  const target = umWide * frac;
  let best = NICE[0];
  for (const n of NICE) if (n <= target) best = n;
  return best;
}

/* ---- which channels apply where ----
   visible  = used at all
   inMerge  = contributes to a merge composite
   inInsets = appears in zoomed cut-outs (nuclei are usually off here) */
function chansAll(img) { return chanSettings(img).filter(c => c.visible); }
function chansMerge(img, source) {
  return chanSettings(img).filter(c => c.visible && c.inMerge !== false &&
    (source !== 'inset' || c.inInsets !== false));
}
function chansInsets(img) {
  return chanSettings(img).filter(c => c.visible && c.inInsets !== false);
}

/* ---- build the cell list for one image, per template ----
   A null entry keeps a column slot empty so rows stay aligned when a channel
   is excluded from the cut-outs. */
function cellsForImage(img) {
  const L = S.layout;
  const all = chansAll(img);
  const zoomable = chansInsets(img);
  const hasMerge = chansMerge(img, 'full').length > 1;
  const mk = (kind, channel, source, insetIndex, title) =>
    ({ imageId: img.id, kind, channel, source, insetIndex, title });
  const mergeTitle = 'Merge';

  switch (L.template) {
    case 'channels_merge': {
      const row = all.map(c => mk('channel', c.index, 'full', 0, c.name));
      if (hasMerge) row.push(mk('merge', null, 'full', 0, mergeTitle));
      return [row];
    }
    case 'channels_over_insets': {
      const top = all.map(c => mk('channel', c.index, 'full', 0, c.name));
      const bot = all.map(c => (c.inInsets === false) ? null
                                : mk('channel', c.index, 'inset', 0, c.name));
      if (hasMerge) {
        top.push(mk('merge', null, 'full', 0, mergeTitle));
        bot.push(mk('merge', null, 'inset', 0, mergeTitle));
      }
      return [top, bot];
    }
    case 'merge_inset_row': {
      const row = [mk('merge', null, 'full', 0, mergeTitle)];
      for (let k = 0; k < L.insetCount; k++)
        row.push(mk('merge', null, 'inset', k, `Zoom ${k + 1}`));
      return [row];
    }
    case 'merge_inset_stack': {
      const row = [mk('merge', null, 'full', 0, mergeTitle)];
      zoomable.forEach(c => row.push(mk('channel', c.index, 'inset', 0, c.name)));
      return [row];
    }
    case 'grid':
      return [[mk('merge', null, 'full', 0, img.label || img.meta.name)]];
    case 'channels_columns': {
      const col = all.map(c => mk('channel', c.index, 'full', 0, c.name));
      if (hasMerge) col.push(mk('merge', null, 'full', 0, mergeTitle));
      return [col];
    }
  }
  return [[]];
}

function cellSource(img, cell) {
  return cell.source === 'inset' ? insetRect(img, cell.insetIndex) : fullCrop(img);
}

/* ---- resolve the whole figure into placed rectangles ----
   Each image becomes a self-contained block; blocks are tiled into a grid of
   L.gridCols columns, so "design one cell, repeat it" works for every template. */
function computeLayout() {
  const L = S.layout, LB = S.labels;
  const imgs = figureImages();
  const out = { width: 0, height: 0, panels: [], rows: [], headerCells: [] };
  if (!imgs.length) { out.width = 400; out.height = 200; return out; }

  const pad = L.outerPad, gap = L.gap, H = L.panelSize;
  const gutter = (LB.rowMode === 'left' && L.template !== 'grid') ? LB.rowWidth : 0;
  const titleTop = LB.titleMode === 'top' ? LB.titleSize + 6 : 0;
  const titleEach = LB.titleMode === 'each' ? LB.titleSize + 4 : 0;
  const figTop = LB.figTitle ? LB.figTitleSize + 8 : 0;
  const top0 = pad + figTop + titleTop;
  const cols = Math.max(1, Math.round(L.gridCols) || 1);
  const colGap = gap * 3, rowGap = gap * 2;
  const aspect = (img, cell) => { const s = cellSource(img, cell); return s.w / s.h; };
  /* A panel never stretches what it shows.  The grid hands out a slot; the panel
     takes its own source aspect inside it and sits centered, so a cut-out that is
     no longer square comes out as a rectangle rather than a squashed square. */
  const fit = (img, cell, x, y, slotW, slotH) => {
    const a = aspect(img, cell);
    let w = slotH * a, h = slotH;
    if (w > slotW + 1e-6) { w = slotW; h = slotW / a; }
    return { x: x + (slotW - w) / 2, y: y + (slotH - h) / 2, w, h };
  };

  // ---- images as columns: a single shared grid rather than per-image blocks ----
  if (L.template === 'channels_columns') {
    const grid = imgs.map(img => cellsForImage(img)[0]);
    const nRows = Math.max(...grid.map(g => g.length));
    const cw = grid.map((cells, ci) => {
      let w = 0; cells.forEach(c => { if (c) w = Math.max(w, H * aspect(imgs[ci], c)); });
      return w;
    });
    let x = pad + gutter;
    grid.forEach((cells, ci) => {
      cells.forEach((cell, ri) => {
        if (!cell) return;
        const b = fit(imgs[ci], cell, x, top0 + ri * (H + gap), cw[ci], H);
        out.panels.push({ img: imgs[ci], cell, x: b.x, y: b.y, w: b.w, h: b.h,
                          row: ri, subrow: 0, col: ci,
                          first: ci === 0, last: ci === grid.length - 1 });
      });
      out.headerCells.push({ cell: { title: imgs[ci].label || imgs[ci].meta.name, kind: 'merge' },
                             x, w: cw[ci], key: `hdr/${imgs[ci].id}` });
      x += cw[ci] + gap;
    });
    for (let ri = 0; ri < nRows; ri++) {          // the gutter names channels here
      const c = grid[0][ri];
      out.rows.push({ img: imgs[0], y: top0 + ri * (H + gap), h: H, row: ri,
                      label: c ? c.title : '', labelX: pad + gutter - 8 });
    }
    out.width = pad * 2 + gutter + cw.reduce((a, b) => a + b, 0) + (cw.length - 1) * gap;
    out.height = top0 + nRows * (H + gap) - gap + pad;
    return out;
  }

  // ---- one block per image ----
  const blocks = imgs.map(img => cellsForImage(img));
  let place, blockW = 0, blockH = 0, colX = null, colW = null;

  if (L.template === 'merge_inset_stack') {
    let n = 1;
    blocks.forEach(b => { n = Math.max(n, b[0].length - 1); });
    const insetH = (H - (n - 1) * gap) / n;
    let mergeW = 0, insetW = 0;
    imgs.forEach(img => {
      mergeW = Math.max(mergeW, H * aspect(img, { source: 'full' }));
      insetW = Math.max(insetW, insetH * aspect(img, { source: 'inset', insetIndex: 0 }));
    });
    blockW = mergeW + gap + insetW;
    blockH = H;
    place = (img, rows, bx, by, bi) => {
      const cells = rows[0];
      const m = fit(img, cells[0], bx, by, mergeW, H);
      out.panels.push({ img, cell: cells[0], x: m.x, y: m.y, w: m.w, h: m.h,
                        row: bi, subrow: 0, col: 0, first: true, last: false });
      cells.slice(1).forEach((cell, k) => {
        const b = fit(img, cell, bx + mergeW + gap, by + k * (insetH + gap), insetW, insetH);
        out.panels.push({ img, cell, x: b.x, y: b.y, w: b.w, h: b.h,
                          row: bi, subrow: 0, col: 1 + k,
                          first: false, last: k === cells.length - 2 });
      });
    };
  } else {
    const nCols = Math.max(...blocks.map(b => Math.max(...b.map(r => r.length))));
    colW = new Array(nCols).fill(0);
    blocks.forEach((rows, bi) => rows.forEach(cells => cells.forEach((cell, ci) => {
      if (cell) colW[ci] = Math.max(colW[ci], H * aspect(imgs[bi], cell));
    })));
    colX = []; let acc = 0;
    for (let c = 0; c < nCols; c++) { colX.push(acc); acc += colW[c] + gap; }
    blockW = acc - gap;
    const nRows = Math.max(...blocks.map(b => b.length));
    blockH = nRows * (H + titleEach) + (nRows - 1) * gap;
    place = (img, rows, bx, by, bi) => {
      rows.forEach((cells, ri) => {
        const rowY = by + ri * (H + titleEach + gap) + titleEach;
        cells.forEach((cell, ci) => {
          if (!cell) return;
          const b = fit(img, cell, bx + colX[ci], rowY, colW[ci], H);
          out.panels.push({ img, cell, x: b.x, y: b.y, w: b.w, h: b.h,
                            row: bi, subrow: ri, col: ci,
                            first: ci === 0 && ri === 0, last: ci === cells.length - 1 });
        });
      });
    };
  }

  const cellW = gutter + blockW;
  const nGridRows = Math.ceil(imgs.length / cols);
  imgs.forEach((img, bi) => {
    const gc = bi % cols, gr = (bi / cols) | 0;
    const bx = pad + gc * (cellW + colGap) + gutter;
    const by = top0 + gr * (blockH + rowGap);
    place(img, blocks[bi], bx, by, bi);
    out.rows.push({ img, y: by, h: blockH, row: bi,
                    label: img.label || img.meta.name, labelX: bx - 8 });
  });

  const usedCols = Math.min(cols, imgs.length);
  out.width = pad * 2 + usedCols * cellW + (usedCols - 1) * colGap;
  out.height = top0 + nGridRows * (blockH + rowGap) - rowGap + pad;

  if (LB.titleMode === 'top' && colX) {
    for (let gc = 0; gc < usedCols; gc++) {
      const bx = pad + gc * (cellW + colGap) + gutter;
      blocks[gc][0].forEach((cell, ci) => {
        if (cell) out.headerCells.push({ cell, x: bx + colX[ci], w: colW[ci],
                                         key: `hdr/${gc}/${cellKey(cell)}` });
      });
    }
  }
  return out;
}

// ============================================================== render plan
function chanSpec(img, c) {
  return { index: c.index, color: c.color, black: +c.black, white: +c.white,
           gamma: +c.gamma, gain: +c.gain };
}

function monoApplies(cell) {
  const m = S.layout.mono;
  return m === 'all' || (m === 'insets' && cell.source === 'inset');
}

function panelChannels(img, cell) {
  let out;
  if (cell.kind === 'channel') {
    const c = chanSettings(img).find(x => x.index === cell.channel);
    out = c ? [chanSpec(img, c)] : [];
  } else {
    out = chansMerge(img, cell.source).map(c => chanSpec(img, c));
  }
  // a lone channel can be drawn in gray instead of its own color
  if (out.length === 1 && monoApplies(cell)) {
    out = [Object.assign({}, out[0], { color: S.layout.monoColor })];
  }
  return out;
}

function letterFor(i, style) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const s = A[i % 26] + (i >= 26 ? String(i / 26 | 0) : '');
  return style.startsWith('lower') ? s.toLowerCase() : s;
}

/* ---- hand-placed labels ----
   Every text item carries a stable key, and S.textOffsets[key] holds the nudge it
   was dragged by plus its rotation, so hand placement survives a relayout. */
function cellKey(cell) {
  return `${cell.kind}${cell.channel ?? ''}/${cell.source}/${cell.insetIndex || 0}`;
}
function textItem(key, it) {
  const o = S.textOffsets[key];
  if (o) {
    it.x += o.dx || 0;
    it.y += o.dy || 0;
    if (o.rot) it.rotate = (it.rotate || 0) + o.rot;
  }
  it.key = key;
  return it;
}
function labelOffset(key) {
  let o = S.textOffsets[key];
  if (!o) o = S.textOffsets[key] = { dx: 0, dy: 0, rot: 0 };
  return o;
}

/* Every label of the same kind -- all row labels, all channel titles, all scale
   captions -- so one turn or one nudge lands on the whole figure and they stay
   aligned with each other.  Untick "apply to every label of the same kind" to
   place one on its own. */
function labelPeers(key) {
  if (!S.labels.linkLabels || !lastPlan) return [key];
  const kind = key.split('/')[0];
  const set = new Set([key]);
  lastPlan.items.forEach(i => {
    if (i.type === 'text' && i.key && i.key.split('/')[0] === kind) set.add(i.key);
  });
  return [...set];
}
function setLabelOffset(key, patch) {
  labelPeers(key).forEach(k => Object.assign(labelOffset(k), patch));
}

function buildPlan() {
  const L = S.layout, LB = S.labels, SC = S.scale;
  const lay = computeLayout();
  const items = [];
  const bg = L.bgTransparent ? 'none' : L.bg;
  const fontFamily = LB.font;
  let letterIdx = 0;

  // figure title
  if (LB.figTitle) {
    items.push(textItem('fig', { type: 'text', x: lay.width / 2, y: L.outerPad + LB.figTitleSize,
                 text: LB.figTitle, fill: LB.figTitleColor, size: LB.figTitleSize,
                 family: fontFamily, weight: 'bold', anchor: 'middle', baseline: 'alphabetic' }));
  }

  // column headers
  if (LB.titleMode === 'top' && lay.headerCells.length) {
    const yTitle = L.outerPad + (LB.figTitle ? LB.figTitleSize + 8 : 0) + LB.titleSize;
    lay.headerCells.forEach(hc => {
      items.push(textItem(hc.key, { type: 'text', x: hc.x + hc.w / 2, y: yTitle,
                   text: hc.cell.title || '',
                   fill: LB.titleByChannel ? titleColorOf(hc.cell) : LB.titleColor,
                   size: LB.titleSize, family: fontFamily,
                   weight: LB.titleBold ? 'bold' : 'normal',
                   anchor: 'middle', baseline: 'alphabetic' }));
    });
  }

  // row labels
  const rowMode = (L.template === 'grid' && LB.rowMode === 'left') ? 'inside' : LB.rowMode;
  if (rowMode === 'left') {
    lay.rows.forEach(r => {
      const label = r.label != null ? r.label : (r.img.label || r.img.meta.name);
      const rk = `row/${r.img.id}/${r.row}`;
      if (LB.rowRotate) {
        items.push(textItem(rk, { type: 'text',
                     x: (r.labelX != null ? r.labelX - 2 : L.outerPad), y: r.y + r.h / 2,
                     text: label, fill: LB.rowColor, size: LB.rowSize, family: fontFamily,
                     weight: 'normal', italic: LB.rowItalic, anchor: 'middle',
                     baseline: 'alphabetic', rotate: -90 }));
      } else {
        items.push(textItem(rk, { type: 'text',
                     x: (r.labelX != null ? r.labelX : L.outerPad + LB.rowWidth - 8),
                     y: r.y + r.h / 2, text: label, fill: LB.rowColor, size: LB.rowSize,
                     family: fontFamily, weight: 'normal', italic: LB.rowItalic,
                     anchor: 'end', baseline: 'middle' }));
      }
    });
  }

  // panels + overlays
  lay.panels.forEach(p => {
    const img = p.img, cell = p.cell, src = cellSource(img, cell);
    items.push({
      type: 'panel', id: `${img.meta.name}-${cell.kind}${cell.channel ?? ''}-${cell.source}`,
      x: p.x, y: p.y, w: p.w, h: p.h,
      image_id: img.id, rotation: img.rotation || 0,
      src: { x: src.x, y: src.y, w: src.w, h: src.h },
      channels: panelChannels(img, cell), blend: S.blend, invert: S.invert,
      background: L.bgTransparent ? '#000000' : L.bg,
    });

    if (cell.source === 'inset' && L.insetBorder) {
      items.push({ type: 'rect', x: p.x, y: p.y, w: p.w, h: p.h, fill: 'none',
                   stroke: L.insetColor, stroke_width: L.insetStroke });
    }
    if (LB.titleMode === 'each') {
      items.push(textItem(`te/${img.id}/${cellKey(cell)}`,
                 { type: 'text', x: p.x + p.w / 2, y: p.y - 4, text: cell.title || '',
                   fill: LB.titleByChannel ? titleColorOf(cell) : LB.titleColor,
                   size: LB.titleSize, family: fontFamily,
                   weight: LB.titleBold ? 'bold' : 'normal', anchor: 'middle',
                   baseline: 'alphabetic' }));
    }
    if (LB.titleMode === 'inside' && !(LB.titleFirstOnly && p.row !== 0)) {
      items.push(textItem(`ti/${img.id}/${cellKey(cell)}`,
                 { type: 'text', x: p.x + 6, y: p.y + LB.titleSize + 3, text: cell.title || '',
                   fill: LB.titleByChannel ? titleColorOf(cell) : LB.titleColor,
                   size: LB.titleSize, family: fontFamily,
                   weight: LB.titleBold ? 'bold' : 'normal', anchor: 'start',
                   baseline: 'alphabetic' }));
    }
    if (rowMode === 'inside' && p.first) {
      items.push(textItem(`ri/${img.id}`,
                 { type: 'text', x: p.x + 6, y: p.y + p.h - 6,
                   text: img.label || img.meta.name, fill: LB.rowColor, size: LB.rowSize,
                   family: fontFamily, italic: LB.rowItalic, weight: 'bold',
                   anchor: 'start', baseline: 'alphabetic' }));
    }
  });

  // ROI boxes + leader lines drawn on the parent panels
  if (L.insetBox) {
    lay.panels.filter(p => p.cell.source === 'full').forEach(p => {
      const img = p.img, crop = fullCrop(img);
      const targets = lay.panels.filter(q => q.img.id === img.id && q.cell.source === 'inset');
      const seen = new Set();
      targets.forEach(q => {
        if (seen.has(q.cell.insetIndex)) return;
        seen.add(q.cell.insetIndex);
        const r = insetRect(img, q.cell.insetIndex);
        const sx = p.x + (r.x - crop.x) / crop.w * p.w;
        const sy = p.y + (r.y - crop.y) / crop.h * p.h;
        const sw = r.w / crop.w * p.w, sh = r.h / crop.h * p.h;
        items.push({ type: 'rect', x: sx, y: sy, w: sw, h: sh, fill: 'none',
                     stroke: L.insetColor, stroke_width: L.insetStroke });
        if (L.insetLeader && q.x > p.x) {
          items.push({ type: 'line', x1: sx + sw, y1: sy, x2: q.x, y2: q.y,
                       stroke: L.insetColor, stroke_width: L.insetStroke * 0.7, dash: '3 3' });
          items.push({ type: 'line', x1: sx + sw, y1: sy + sh, x2: q.x, y2: q.y + q.h,
                       stroke: L.insetColor, stroke_width: L.insetStroke * 0.7, dash: '3 3' });
        }
      });
    });
  }

  // scale bars
  if (SC.on) {
    const chosen = pickScalebarPanels(lay);
    chosen.forEach(p => {
      const px = pixelSizeOf(p.img);
      if (!px) return;
      const src = cellSource(p.img, p.cell);
      const isInset = p.cell.source === 'inset';
      const umWide = src.w * px;
      const barUm = isInset
        ? (SC.autoInset ? niceBar(umWide, 0.3) : SC.lenInset)
        : (SC.auto ? niceBar(umWide, 0.25) : SC.len);
      if (!barUm || barUm <= 0) return;
      const barLen = barUm / umWide * p.w;
      const m = SC.margin, th = SC.thick;
      const right = SC.corner.endsWith('r');
      const bottom = SC.corner.startsWith('b');
      const bx = right ? p.x + p.w - m - barLen : p.x + m;
      const by = bottom ? p.y + p.h - m - th : p.y + m;
      items.push({ type: 'rect', x: bx, y: by, w: barLen, h: th,
                   fill: SC.color, stroke: 'none', stroke_width: 0 });
      if (SC.label) {
        const txt = SC.units === 'nm' ? `${Math.round(barUm * 1000)} nm`
                                      : `${formatNum(barUm)} µm`;
        items.push(textItem(`sb/${p.img.id}/${cellKey(p.cell)}`,
                   { type: 'text', x: bx + barLen / 2,
                     y: bottom ? by - 3 : by + th + SC.labelSize + 1,
                     text: txt, fill: SC.color, size: SC.labelSize, family: fontFamily,
                     weight: 'normal', anchor: 'middle', baseline: 'alphabetic' }));
      }
    });
  }

  // panel letters
  if (LB.letters !== 'none') {
    const perPanel = LB.letters === 'upper_all';
    lay.panels.forEach(p => {
      if (!perPanel && !p.first) return;
      items.push(textItem(`ltr/${p.img.id}/${cellKey(p.cell)}`,
                 { type: 'text', x: p.x + 4, y: p.y + LB.letterSize + 1,
                   text: letterFor(letterIdx++, LB.letters), fill: '#ffffff',
                   size: LB.letterSize, family: fontFamily, weight: 'bold',
                   anchor: 'start', baseline: 'alphabetic' }));
    });
  }

  return {
    width: lay.width, height: lay.height, background: bg, dpi: S.exp.dpi,
    physical_width_mm: S.exp.widthMm, allow_upsample: S.exp.upsample,
    font_family: fontFamily, items, _layout: lay,
  };
}

function formatNum(v) { return (Math.round(v * 100) / 100).toString(); }

function titleColorOf(cell) {
  if (cell.kind === 'merge') return S.labels.titleColor;
  const c = chanSettings(activeImage()).find(x => x.index === cell.channel);
  return c ? c.color : S.labels.titleColor;
}

/* Titles, row labels and the figure title sit on the canvas rather than on an
   image, so they have to contrast with it: white text on a white background is
   the one setting that makes a figure look empty.  Only pure black and pure
   white are moved, so a color actually picked in the color well survives. */
const ON_BACKGROUND = [['titleColor', 'title-color'], ['rowColor', 'rowlabel-color'],
                       ['figTitleColor', 'fig-title-color']];
function contrastLabelsWithBg() {
  const raw = String(S.layout.bg).replace('#', '');
  const h = raw.length === 3 ? raw.replace(/./g, ch => ch + ch) : raw;   // as render.py reads it
  // an unparseable color reads as NaN, falls through as light, and gets dark
  // labels -- the same way hex_to_rgb falls back to white on the server
  const luma = parseInt(h.slice(0, 2), 16) * 0.299 + parseInt(h.slice(2, 4), 16) * 0.587 +
               parseInt(h.slice(4, 6), 16) * 0.114;
  // the transparency checkerboard is dark, so treat it as a dark background
  const want = (S.layout.bgTransparent || luma < 128) ? '#ffffff' : '#000000';
  ON_BACKGROUND.forEach(([prop, id]) => {
    const cur = String(S.labels[prop]).toLowerCase();
    if (cur !== '#ffffff' && cur !== '#000000') return;
    S.labels[prop] = want;
    const el = $(id);
    if (el) el.value = want;
  });
}

function pickScalebarPanels(lay) {
  const w = S.scale.where;
  if (w === 'all') return lay.panels;
  if (w === 'once') return lay.panels.slice(0, 1);
  const byRow = new Map();
  lay.panels.forEach(p => {
    const key = `${p.row}|${p.subrow ?? 0}|${p.cell.source}`;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(p);
  });
  const out = [];
  byRow.forEach(list => {
    list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    out.push(w === 'last' ? list[list.length - 1] : list[0]);
  });
  return out;
}

// =============================================================== canvas draw
const cv = $('fig'), cx = cv.getContext('2d');
let lastPlan = null;
let textBoxes = [];       // on-canvas footprint of every label, refilled each draw

let curDpr = 1;                  // device pixel ratio of the last draw

function drawPreview() {
  const plan = buildPlan();
  lastPlan = plan;
  const dpr = curDpr = Math.min(window.devicePixelRatio || 1, 2);
  const z = S.zoom;
  const bw = Math.max(1, Math.round(plan.width * z * dpr));
  const bh = Math.max(1, Math.round(plan.height * z * dpr));
  // assigning width/height reallocates and clears the backing store even when the
  // value is unchanged, and clearRect below covers the canvas anyway
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  cv.style.width = (plan.width * z) + 'px';
  cv.style.height = (plan.height * z) + 'px';
  cx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';

  cx.clearRect(0, 0, plan.width, plan.height);
  if (plan.background !== 'none') {
    cx.fillStyle = plan.background;
    cx.fillRect(0, 0, plan.width, plan.height);
  } else {
    drawChecker(plan.width, plan.height);
  }

  textBoxes = [];
  for (const it of plan.items) drawItem(it);
  if (S.showGuides) drawGuides(plan);
  drawSelection();
  updateStageInfo(plan);
}

function drawChecker(w, h) {
  const s = 8;
  cx.fillStyle = '#2a2a2a'; cx.fillRect(0, 0, w, h);
  cx.fillStyle = '#343434';
  for (let y = 0; y < h; y += s)
    for (let x = 0; x < w; x += s)
      if (((x / s | 0) + (y / s | 0)) % 2) cx.fillRect(x, y, s, s);
}

function drawItem(it) {
  switch (it.type) {
    case 'panel': return drawPanelItem(it);
    case 'rect': {
      if (it.fill && it.fill !== 'none') { cx.fillStyle = it.fill; cx.fillRect(it.x, it.y, it.w, it.h); }
      if (it.stroke && it.stroke !== 'none' && it.stroke_width > 0) {
        cx.strokeStyle = it.stroke; cx.lineWidth = it.stroke_width;
        cx.setLineDash(it.dash ? it.dash.split(/[\s,]+/).map(Number) : []);
        cx.strokeRect(it.x + it.stroke_width / 2, it.y + it.stroke_width / 2,
                      it.w - it.stroke_width, it.h - it.stroke_width);
        cx.setLineDash([]);
      }
      return;
    }
    case 'line': {
      cx.strokeStyle = it.stroke; cx.lineWidth = it.stroke_width;
      cx.setLineDash(it.dash ? it.dash.split(/[\s,]+/).map(Number) : []);
      cx.beginPath(); cx.moveTo(it.x1, it.y1); cx.lineTo(it.x2, it.y2); cx.stroke();
      cx.setLineDash([]);
      return;
    }
    case 'text': {
      cx.save();
      cx.fillStyle = it.fill;
      cx.font = `${it.italic ? 'italic ' : ''}${it.weight || 'normal'} ${it.size}px ${it.family}, sans-serif`;
      cx.textAlign = it.anchor === 'middle' ? 'center' : it.anchor === 'end' ? 'right' : 'left';
      cx.textBaseline = it.baseline === 'middle' || it.baseline === 'central' ? 'middle'
                       : it.baseline === 'hanging' ? 'top' : 'alphabetic';
      if (it.key) recordTextBox(it);
      if (it.rotate) { cx.translate(it.x, it.y); cx.rotate(it.rotate * Math.PI / 180); cx.fillText(it.text, 0, 0); }
      else cx.fillText(it.text, it.x, it.y);
      cx.restore();
      return;
    }
  }
}

function drawPanelItem(it) {
  const img = imgById(it.image_id);
  if (!img) return;
  const chList = it.channels.map(c => {
    const full = chanSettings(img).find(x => x.index === c.index);
    return Object.assign({}, full, c);
  });
  if (!chList.length) { cx.fillStyle = '#111'; cx.fillRect(it.x, it.y, it.w, it.h); return; }
  const pl = planes.get(`${img.id}:${chList[0].index}`);
  if (!pl) {
    cx.fillStyle = '#181b20'; cx.fillRect(it.x, it.y, it.w, it.h);
    cx.fillStyle = '#555'; cx.font = '10px sans-serif'; cx.textAlign = 'center';
    cx.fillText('loading…', it.x + it.w / 2, it.y + it.h / 2);
    return;
  }
  const f = pl.factor;
  // the coarsest pyramid level that still holds a sample per device pixel --
  // render.py's own rule for the same decision, one panel at a time
  const dw = Math.max(1, it.w * S.zoom * curDpr), dh = Math.max(1, it.h * S.zoom * curDpr);
  const sw = it.src.w / f, sh = it.src.h / f;
  let k = 1;
  while (k < 16 && sw >= dw * k * 2 && sh >= dh * k * 2) k <<= 1;
  const lvl = planeLevel(img.id, chList[0].index, k);
  const rx = lvl.w / pl.w, ry = lvl.h / pl.h;     // exact even when a level is odd-sized
  const sx = it.src.x / f * rx, sy = it.src.y / f * ry;
  const swk = sw * rx, shk = sh * ry;

  cx.save();
  cx.beginPath(); cx.rect(it.x, it.y, it.w, it.h); cx.clip();
  if (img.rotation) {
    cx.drawImage(rotatedTile(img, chList, k, pl, img.rotation, sx, sy, swk, shk),
                 0, 0, swk, shk, it.x, it.y, it.w, it.h);
  } else {
    const x0 = Math.floor(sx / TILE_GRID) * TILE_GRID, y0 = Math.floor(sy / TILE_GRID) * TILE_GRID;
    const tw = clamp(Math.ceil((sx + swk) / TILE_GRID) * TILE_GRID - x0, 1, 4096);
    const th = clamp(Math.ceil((sy + shk) / TILE_GRID) * TILE_GRID - y0, 1, 4096);
    cx.drawImage(compositeTile(img, chList, k, x0, y0, tw, th),
                 sx - x0, sy - y0, swk, shk, it.x, it.y, it.w, it.h);
  }
  cx.restore();
}

/* Remember where a label ended up on the canvas so it can be picked up and
   dragged.  measureText already accounts for textAlign/textBaseline, so this
   runs right after the context is set up and before the fill. */
function recordTextBox(it) {
  if (!it.text) return;
  const m = cx.measureText(it.text);
  const size = +it.size || 12;
  const l = -(m.actualBoundingBoxLeft ?? 0), r = m.actualBoundingBoxRight ?? m.width;
  const t = -(m.actualBoundingBoxAscent ?? size * 0.8), b = m.actualBoundingBoxDescent ?? size * 0.2;
  const pad = 3;
  const th = (it.rotate || 0) * Math.PI / 180, co = Math.cos(th), si = Math.sin(th);
  const xs = [], ys = [];
  [[l - pad, t - pad], [r + pad, t - pad], [r + pad, b + pad], [l - pad, b + pad]]
    .forEach(([px, py]) => { xs.push(it.x + px * co - py * si); ys.push(it.y + px * si + py * co); });
  textBoxes.push({ key: it.key, item: it,
                   x0: Math.min(...xs), x1: Math.max(...xs),
                   y0: Math.min(...ys), y1: Math.max(...ys) });
}

function textAt(pt) {
  for (let i = textBoxes.length - 1; i >= 0; i--) {
    const b = textBoxes[i];
    if (pt.x >= b.x0 && pt.x <= b.x1 && pt.y >= b.y0 && pt.y <= b.y1) return b;
  }
  return null;
}

function drawSelection() {
  if (!selText) return;
  const b = textBoxes.find(x => x.key === selText);
  if (!b) return;
  cx.strokeStyle = 'rgba(255,196,64,.95)';
  cx.lineWidth = 1 / S.zoom;
  cx.setLineDash([3 / S.zoom, 2 / S.zoom]);
  cx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  cx.setLineDash([]);
}

// ---- cut-out ROI, as it appears on an overview panel -----------------------
function roiScreenRect(p, k) {
  const crop = fullCrop(p.img), r = insetRect(p.img, k);
  return { x: p.x + (r.x - crop.x) / crop.w * p.w, y: p.y + (r.y - crop.y) / crop.h * p.h,
           w: r.w / crop.w * p.w, h: r.h / crop.h * p.h };
}
function insetIndicesInUse(lay, imgId) {
  const s = new Set();
  lay.panels.forEach(q => {
    if (q.img.id === imgId && q.cell.source === 'inset') s.add(q.cell.insetIndex || 0);
  });
  return [...s];
}
const HANDLE_PX = 7;
const CORNERS = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]];
function roiHandleAt(p, pt) {
  if (!lastPlan) return null;
  const h = HANDLE_PX / S.zoom;
  for (const k of insetIndicesInUse(lastPlan._layout, p.img.id)) {
    const r = roiScreenRect(p, k);
    for (const [name, fx, fy] of CORNERS) {
      if (Math.abs(pt.x - (r.x + fx * r.w)) <= h && Math.abs(pt.y - (r.y + fy * r.h)) <= h)
        return { k, corner: name };
    }
  }
  return null;
}

function drawGuides(plan) {
  const act = activeImage();
  if (!act) return;
  plan._layout.panels.forEach(p => {
    if (p.img.id !== act.id) return;
    cx.strokeStyle = 'rgba(90,169,255,.85)';
    cx.lineWidth = 1 / S.zoom;
    cx.setLineDash([4 / S.zoom, 3 / S.zoom]);
    cx.strokeRect(p.x, p.y, p.w, p.h);
    cx.setLineDash([]);
    // grab handles on the cut-out box, so it can be moved and resized by hand
    if (p.cell.source !== 'full') return;
    const h = HANDLE_PX / S.zoom;
    insetIndicesInUse(plan._layout, act.id).forEach(k => {
      const r = roiScreenRect(p, k);
      cx.fillStyle = 'rgba(90,169,255,.95)';
      cx.strokeStyle = 'rgba(0,0,0,.7)';
      cx.lineWidth = 1 / S.zoom;
      CORNERS.forEach(([, fx, fy]) => {
        const hx = r.x + fx * r.w - h / 2, hy = r.y + fy * r.h - h / 2;
        cx.fillRect(hx, hy, h, h); cx.strokeRect(hx, hy, h, h);
      });
    });
  });
}

const MM_PER_INCH = 25.4;   // matches render.py, so this readout matches the export exactly
function updateStageInfo(plan) {
  const act = activeImage();
  const mmW = S.exp.widthMm;
  const mmH = plan.width ? mmW * plan.height / plan.width : mmW;
  const pxW = Math.round(mmW / MM_PER_INCH * S.exp.dpi);
  const pxH = Math.round(mmH / MM_PER_INCH * S.exp.dpi);
  let txt = `${formatNum(mmW)} × ${formatNum(mmH)} mm · ${pxW} × ${pxH} px @ ${S.exp.dpi} dpi · ` +
            `${plan._layout.panels.length} panels`;
  if (act) {
    const px = pixelSizeOf(act);
    txt += ` · ${act.meta.name}` + (px ? ` · ${px.toFixed(4)} µm/px` : ' · no pixel size!');
  }
  $('stage-info').textContent = txt;
}

// ==================================================================== UI glue
let redrawRaf = 0;
function refresh(immediate) {
  scheduleHistory();
  if (immediate) {
    if (redrawRaf) { cancelAnimationFrame(redrawRaf); redrawRaf = 0; }
    drawPreview();
    return;
  }
  // One draw per frame that still lands: a trailing debounce re-armed by every
  // slider event never draws until the drag stops.
  if (redrawRaf) return;
  redrawRaf = requestAnimationFrame(() => { redrawRaf = 0; drawPreview(); });
}

function bind(id, prop, target, cast, onChange) {
  const el = $(id);
  if (!el) return;
  const set = () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (cast === Number) v = parseFloat(v) || 0;
    target[prop] = v;
    if (onChange) onChange(v);
    refresh();
  };
  el.addEventListener('input', set);
  el.addEventListener('change', set);
  el._sync = () => {
    if (el.type === 'checkbox') el.checked = !!target[prop];
    else el.value = target[prop];
  };
  el._sync();
}

function syncAll() { document.querySelectorAll('[id]').forEach(el => el._sync && el._sync()); }

// ------------------------------------------------------------- channel cards
function isTransmitted(name) {
  return /phase|dic|trans|pmt|bright|\bbf\b/i.test(name || '');
}

// nuclear stains normally belong in the overview but not in the zoomed cut-outs
function isNuclear(name) {
  return /dapi|hoechst|draq|nucle/i.test(name || '');
}

function initChannels(meta) {
  S.channels = meta.channels.map(c => ({
    index: c.index, name: cleanName(c.name), color: c.color,
    black: Math.round(c.lo), white: Math.round(c.hi), gamma: 1, gain: 1,
    visible: !isTransmitted(c.name), inMerge: true, inInsets: !isNuclear(c.name),
  }));
}

function cleanName(n) {
  return String(n || '').replace(/-T\d+$/, '').replace(/^Ch\d+\s*/, '').trim() || n;
}

/* Dragging the black/white handles has to follow the mouse off the histogram, so
   it listens on the window -- but once, not once per card: the cards are rebuilt
   on every image switch, palette and Auto, and a pair each time is an unbounded
   leak that also pins every retired canvas. */
let histDrag = null;
function histDragTo(e) {
  if (!histDrag) return;
  const { hc, c, m, card, ranges, nums, which } = histDrag;
  const rect = hc.getBoundingClientRect();
  const val = Math.round(histValAt(m, clamp((e.clientX - rect.left) / rect.width, 0, 1)));
  if (which === 'black') c.black = Math.min(val, c.white - 1);
  else c.white = Math.max(val, c.black + 1);
  const ri = which === 'black' ? 0 : 1;
  ranges[ri].value = c[which]; nums[ri].value = c[which];
  drawHist(card, c, m); refresh();
}
window.addEventListener('mousemove', histDragTo);
window.addEventListener('mouseup', () => { histDrag = null; });

function renderChannelCards() {
  const host = $('channel-list');
  host.innerHTML = '';
  const act = activeImage();
  const list = chanSettings(act);
  const meta = act ? act.meta : null;
  list.forEach((c, i) => {
    const m = meta && meta.channels[c.index];
    const card = document.createElement('div');
    card.className = 'ch-card';
    card.innerHTML = `
      <div class="ch-head">
        <input type="checkbox" ${c.visible ? 'checked' : ''} title="show in merge">
        <input type="color" value="${c.color}">
        <input type="text" value="${escapeHtml(c.name)}" title="channel title shown in the figure">
      </div>
      <div class="ch-scope">
        <label title="include this channel in merge panels"><input type="checkbox" class="sc-m" ${c.inMerge !== false ? 'checked' : ''}> merge</label>
        <label title="include this channel in the zoomed cut-outs"><input type="checkbox" class="sc-z" ${c.inInsets !== false ? 'checked' : ''}> cut-outs</label>
      </div>
      <canvas class="hist" width="260" height="44"></canvas>
      <div class="ch-grid">
        <span>black</span><input type="range" min="0" max="65535" value="${c.black}">
        <input type="number" value="${c.black}" step="1">
        <span>white</span><input type="range" min="1" max="65535" value="${c.white}">
        <input type="number" value="${c.white}" step="1">
        <span>gamma</span><input type="range" min="0.2" max="4" step="0.05" value="${c.gamma}">
        <input type="number" value="${c.gamma}" step="0.05">
        <span>gain</span><input type="range" min="0.1" max="6" step="0.05" value="${c.gain}">
        <input type="number" value="${c.gain}" step="0.05">
      </div>
      <div class="row" style="margin:6px 0 0">
        <button class="btn small auto">Auto</button>
        <button class="btn small full">Full range</button>
        <span class="dim mono" style="flex:1;text-align:right">${m ? `${Math.round(m.dmin)}–${Math.round(m.dmax)}` : ''}</span>
      </div>`;
    host.appendChild(card);

    const [vis, col, nam] = card.querySelectorAll('.ch-head > *');
    const ranges = card.querySelectorAll('.ch-grid input[type=range]');
    const nums = card.querySelectorAll('.ch-grid input[type=number]');
    const keys = ['black', 'white', 'gamma', 'gain'];

    vis.onchange = () => { c.visible = vis.checked; refresh(); };
    card.querySelector('.sc-m').onchange = (e) => {
      c.inMerge = e.target.checked; refresh();
    };
    card.querySelector('.sc-z').onchange = (e) => {
      c.inInsets = e.target.checked; refresh();
    };
    col.oninput = () => { c.color = col.value; refresh(); };
    nam.oninput = () => { c.name = nam.value; refresh(); };

    keys.forEach((k, ki) => {
      const apply = (v) => {
        c[k] = (k === 'gamma' || k === 'gain') ? parseFloat(v) : Math.round(parseFloat(v));
        ranges[ki].value = c[k]; nums[ki].value = c[k];
        drawHist(card, c, m); refresh();
      };
      ranges[ki].oninput = () => apply(ranges[ki].value);
      nums[ki].oninput = () => apply(nums[ki].value);
    });

    card.querySelector('.auto').onclick = () => {
      if (m) { c.black = Math.round(m.lo); c.white = Math.round(m.hi); }
      c.gamma = 1; c.gain = 1;
      renderChannelCards(); refresh();
    };
    card.querySelector('.full').onclick = () => {
      if (m) { c.black = Math.round(m.dmin); c.white = Math.round(m.dmax); }
      renderChannelCards(); refresh();
    };

    const hc = card.querySelector('.hist');
    drawHist(card, c, m);
    hc.addEventListener('mousedown', (e) => {
      const rect = hc.getBoundingClientRect();
      const val = histValAt(m, (e.clientX - rect.left) / rect.width);
      histDrag = { hc, c, m, card, ranges, nums,
                   which: Math.abs(val - c.black) < Math.abs(val - c.white) ? 'black' : 'white' };
      histDragTo(e);
    });
  });
}

function histValAt(m, frac) {
  if (!m) return frac * 65535;
  return m.hist_min + frac * (m.hist_max - m.hist_min);
}

function drawHist(card, c, m) {
  const hc = card.querySelector('.hist'), g = hc.getContext('2d');
  const W = hc.width, H = hc.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0d0f12'; g.fillRect(0, 0, W, H);
  if (m && m.histogram && m.histogram.length) {
    const hist = m.histogram, n = hist.length;
    const mx = Math.max(...hist.slice(1)) || 1;
    g.fillStyle = c.color + '99';
    for (let i = 0; i < n; i++) {
      const v = Math.log1p(hist[i]) / Math.log1p(mx);
      const bh = v * (H - 2);
      g.fillRect(i / n * W, H - bh, Math.ceil(W / n), bh);
    }
  }
  const span = m ? (m.hist_max - m.hist_min) : 65535, lo = m ? m.hist_min : 0;
  const fx = (v) => clamp((v - lo) / span, 0, 1) * W;
  g.strokeStyle = '#000'; g.lineWidth = 3;
  [c.black, c.white].forEach(v => { g.beginPath(); g.moveTo(fx(v), 0); g.lineTo(fx(v), H); g.stroke(); });
  g.strokeStyle = '#5aa9ff'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(fx(c.black), 0); g.lineTo(fx(c.black), H); g.stroke();
  g.strokeStyle = '#ffffff';
  g.beginPath(); g.moveTo(fx(c.white), 0); g.lineTo(fx(c.white), H); g.stroke();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// -------------------------------------------------------------- image list
function renderImageList() {
  const host = $('image-list');
  host.innerHTML = '';
  $('img-count').textContent = S.images.length;
  $('empty-hint').classList.toggle('hidden', S.images.length > 0);
  S.images.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'img-item' + (img.id === S.activeId ? ' active' : '');
    el.draggable = true;
    el.innerHTML = `<span class="drag">⠿</span>
      <input type="checkbox" ${img.enabled ? 'checked' : ''} title="include in figure">
      <span class="nm" title="${escapeHtml(img.meta.path)}">${escapeHtml(img.meta.name)}</span>
      <span class="lb" title="row label">${escapeHtml(img.label || '')}</span>
      <span class="x" title="remove">✕</span>`;
    host.appendChild(el);
    el.querySelector('input').onchange = (e) => {
      img.enabled = e.target.checked; refresh(); e.stopPropagation();
    };
    el.querySelector('.x').onclick = (e) => {
      e.stopPropagation();
      S.images.splice(i, 1);
      if (S.activeId === img.id) S.activeId = S.images.length ? S.images[0].id : null;
      renderImageList(); renderChannelCards(); refresh();
    };
    el.querySelector('.lb').onclick = (e) => {
      e.stopPropagation();
      const v = prompt('Row label for ' + img.meta.name, img.label || '');
      if (v !== null) { img.label = v; renderImageList(); refresh(); }
    };
    el.onclick = () => setActive(img.id);
    el.ondragstart = (e) => { e.dataTransfer.setData('text/idx', String(i)); };
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('dragover'); };
    el.ondragleave = () => el.classList.remove('dragover');
    el.ondrop = (e) => {
      e.preventDefault(); el.classList.remove('dragover');
      const from = +e.dataTransfer.getData('text/idx');
      if (Number.isInteger(from) && from !== i) {
        const [m] = S.images.splice(from, 1);
        S.images.splice(i, 0, m);
        renderImageList(); refresh();
      }
    };
  });
}

function setActive(id) {
  S.activeId = id;
  const img = imgById(id);
  if (img) {
    const c = fullCrop(img);
    $('crop-x').value = Math.round(c.x); $('crop-y').value = Math.round(c.y);
    $('crop-w').value = Math.round(c.w); $('crop-h').value = Math.round(c.h);
    $('rotation').value = img.rotation || 0;
    const px = pixelSizeOf(img);
    $('pixel-size').value = px != null ? px : 0;
    $('pixel-src').textContent = px
      ? `${img.meta.pixel_size_source === 'metadata' ? 'from file metadata' : img.meta.pixel_size_source}`
      : 'no pixel size in file — type it in, or scale bars are skipped';
  }
  renderImageList(); renderChannelCards(); updateMagInfo(); refresh();
}

function updateMagInfo() {
  const img = activeImage();
  if (!img) { $('mag-info').textContent = ''; return; }
  const px = pixelSizeOf(img);
  const crop = fullCrop(img), ins = insetRect(img, 0);
  const lay = computeLayout();
  const full = lay.panels.find(p => p.img.id === img.id && p.cell.source === 'full');
  const inset = lay.panels.find(p => p.img.id === img.id && p.cell.source === 'inset');
  let t = `Crop ${Math.round(crop.w)}×${Math.round(crop.h)} px`;
  if (px) t += ` = ${(crop.w * px).toFixed(1)}×${(crop.h * px).toFixed(1)} µm`;
  if (inset && full) {
    const mag = (inset.w / ins.w) / (full.w / crop.w);
    t += `. Inset ${Math.round(ins.w)} px wide` + (px ? ` = ${(ins.w * px).toFixed(2)} µm` : '') +
         `, shown ${mag.toFixed(1)}× larger than the overview.`;
  }
  $('mag-info').textContent = t;
}

// ---------------------------------------------------------------- open files
/* The dialog is labkit's, so opening images here works exactly as it does in
   the stitcher and pHerret: folders on the left, the images
   actually in them on the right, select-all and shift for a run. */
async function openBrowser(mode) {
  const paths = await LK.browse({
    // No `exts`: the server filters by imgio.SUPPORTED_EXT, which is the one
    // list that knows what this app can actually read.
    mode: 'files',
    title: mode === 'add' ? 'Add images to figure' : 'Open images',
    hint: 'Pick the channels for one field — ⌘-click for several, shift for a run.',
  });
  if (paths && paths.length) await doOpen(paths, mode === 'open');
}

async function doOpen(paths, replace) {
  if (!paths.length) return;
  busy(true, `loading ${paths.length} image${paths.length > 1 ? 's' : ''}…`);
  try {
    const r = await jpost('/api/open', {
      paths, t: S.src.t, z_mode: S.src.zMode, z_index: S.src.zIndex, scene: S.src.scene,
    });
    if (replace) { S.images = []; clearPlanes(); invalidateComposites(); }
    const fresh = !S.channels.length;
    (r.images || []).forEach(meta => {
      if (S.images.some(i => i.meta.path === meta.path && i.meta.id === meta.id)) return;
      S.images.push({
        id: meta.id, meta, label: '', enabled: true,
        crop: null, rotation: 0, insets: [], pixelSize: null,
      });
    });
    if (fresh && S.images.length) initChannels(S.images[0].meta);
    if (!S.activeId && S.images.length) S.activeId = S.images[0].id;
    await Promise.all(S.images.map(im => ensurePlanes(im)));
    if (r.errors && r.errors.length) {
      alert('Could not open:\n' + r.errors.map(e => `${e.path}\n  ${e.error}`).join('\n'));
    }
    applyAutoLabels();
    setActive(S.activeId);
    fitZoom();
    // channel settings are global, so an image with more channels than the first
    // one loses the extras -- say so instead of dropping them silently
    const over = S.images.filter(i => i.meta.n_channels > S.channels.length).length;
    if (over) status(`${over} image${over > 1 ? 's have' : ' has'} more channels than the ` +
                     `first — only the first ${S.channels.length} are used`);
  } finally { busy(false); }
}

function applyAutoLabels() {
  const mode = $('autolabel-mode').value;
  if (mode === 'none') return;
  S.images.forEach(img => {
    const stem = img.meta.name.replace(/\.[^.]+$/, '');
    if (mode === 'stem') img.label = stem;
    else if (mode === 'token') {
      const parts = stem.split('_');
      const i = parseInt($('autolabel-token').value, 10);
      img.label = parts[i] != null ? parts[i] : stem;
    } else if (mode === 'regex') {
      try {
        const m = stem.match(new RegExp($('autolabel-regex').value));
        img.label = m ? (m[1] != null ? m[1] : m[0]) : stem;
      } catch { img.label = stem; }
    }
  });
  renderImageList();
}

/* ==================================================================== history
   Everything that changes the figure goes through refresh(), so history commits
   piggyback on it with a debounce: one entry per gesture, not per slider pixel.
   Snapshots hold only the mutable half of an image -- ImageMeta (histograms and
   all) lives in metaRegistry, which never forgets, so undoing "Clear all" can
   rebuild the list without re-reading the files. */
const HIST_MAX = 60;
const HIST_KEYS = ['images', 'channels', 'perImageLevels', 'blend', 'invert',
                   'layout', 'scale', 'labels', 'exp', 'src', 'textOffsets', 'activeId'];
const undoStack = [], redoStack = [];
const metaRegistry = new Map();
let histCurrent = null, histTimer = null;

function histSnapshot() {
  const o = {};
  HIST_KEYS.forEach(k => { o[k] = S[k]; });
  S.images.forEach(i => metaRegistry.set(i.id, i.meta));
  o.images = S.images.map(i => ({ id: i.id, label: i.label, enabled: i.enabled, crop: i.crop,
                                  rotation: i.rotation, insets: i.insets, pixelSize: i.pixelSize,
                                  levels: i.levels }));
  return JSON.stringify(o);
}

function pushHistory() {
  if (drag) return;                       // never commit mid-gesture
  const snap = histSnapshot();
  if (snap === histCurrent) return;
  if (histCurrent !== null) {
    undoStack.push(histCurrent);
    if (undoStack.length > HIST_MAX) undoStack.shift();
  }
  histCurrent = snap;
  redoStack.length = 0;
  updateUndoButtons();
}

function scheduleHistory() {
  clearTimeout(histTimer);
  histTimer = setTimeout(pushHistory, 350);
}

function applySnapshot(snap) {
  const d = JSON.parse(snap);
  HIST_KEYS.forEach(k => {
    if (d[k] === undefined || k === 'images') return;
    if (k === 'channels' || k === 'activeId' || k === 'textOffsets') S[k] = d[k];
    else if (S[k] && typeof S[k] === 'object') Object.assign(S[k], d[k]);
    else S[k] = d[k];
  });
  S.images = d.images
    .map(r => Object.assign({}, r, { meta: metaRegistry.get(r.id) }))
    .filter(r => r.meta);
  histCurrent = snap;
  selText = null;
  invalidateComposites();
  syncAll(); setActive(S.activeId); drawPreview();
  // an image that came back from the dead needs its preview planes again
  S.images.forEach(img => {
    if (!planes.has(`${img.id}:0`)) ensurePlanes(img).then(() => drawPreview()).catch(() => {});
  });
  updateUndoButtons();
}

function undo() {
  clearTimeout(histTimer);
  pushHistory();                          // fold in anything not yet committed
  if (!undoStack.length) { status('nothing to undo'); return; }
  redoStack.push(histCurrent);
  applySnapshot(undoStack.pop());
  status(`undo · ${undoStack.length} step${undoStack.length === 1 ? '' : 's'} back available`);
}
function redo() {
  clearTimeout(histTimer);
  if (!redoStack.length) { status('nothing to redo'); return; }
  undoStack.push(histCurrent);
  applySnapshot(redoStack.pop());
  status(`redo · ${redoStack.length} step${redoStack.length === 1 ? '' : 's'} forward available`);
}
function updateUndoButtons() {
  const u = $('btn-undo'), r = $('btn-redo');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

// ======================================================= canvas interaction
function canvasPoint(e) {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
}
function panelAt(pt) {
  if (!lastPlan) return null;
  const ps = lastPlan._layout.panels;
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    if (pt.x >= p.x && pt.x <= p.x + p.w && pt.y >= p.y && pt.y <= p.y + p.h) return p;
  }
  return null;
}
/* pt -> source pixels of a panel.  Pass srcOverride with the rect frozen at
   mousedown: panning mutates the very rect the mapping is built from, and
   reading it live turns the drag into a feedback loop. */
function toSource(p, pt, srcOverride) {
  const src = srcOverride || cellSource(p.img, p.cell);
  return { x: src.x + (pt.x - p.x) / p.w * src.w, y: src.y + (pt.y - p.y) / p.h * src.h };
}

const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

function roiUnder(p, sp) {                 // index of the cut-out box the point is in
  if (!lastPlan) return -1;
  for (const k of insetIndicesInUse(lastPlan._layout, p.img.id)) {
    const r = insetRect(p.img, k);
    if (sp.x >= r.x && sp.x <= r.x + r.w && sp.y >= r.y && sp.y <= r.y + r.h) return k;
  }
  return -1;
}

function hoverCursor(pt) {
  if (textAt(pt)) return 'move';
  const p = panelAt(pt);
  if (!p) return 'default';
  if (p.cell.source === 'inset') return 'grab';
  if (S.tool !== 'select') return 'crosshair';
  const h = roiHandleAt(p, pt);
  if (h) return CURSOR[h.corner];
  return roiUnder(p, toSource(p, pt)) >= 0 ? 'move' : 'grab';
}

let drag = null;
cv.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const pt = canvasPoint(e);

  // labels sit on top of everything and are grabbed first
  const tb = textAt(pt);
  if (tb) {
    selText = tb.key;
    const o = labelOffset(tb.key);
    drag = { mode: 'move-text', key: tb.key, start: pt, base: { dx: o.dx || 0, dy: o.dy || 0 } };
    const n = labelPeers(tb.key).length;
    status(`drag to place · right-click to turn 90° · arrows nudge · Esc deselects` +
           (n > 1 ? ` · moving all ${n} labels of this kind` : ''));
    refresh(true);
    e.preventDefault();
    return;
  }
  if (selText) { selText = null; refresh(true); }

  const p = panelAt(pt);
  if (!p) return;
  if (p.img.id !== S.activeId) setActive(p.img.id);
  const img = p.img, sp = toSource(p, pt);
  // freeze the rect the panel is showing: several modes mutate it as they go
  const srcRef = Object.assign({}, cellSource(img, p.cell));

  if (p.cell.source === 'inset') {
    // dragging inside a zoom panel slides the cut-out over the source image
    const k = p.cell.insetIndex || 0;
    drag = { mode: 'pan-inset', p, img, srcRef, k, start: sp, rect0: srcRef };
  } else if (S.tool === 'crop') {
    drag = { mode: 'crop', p, img, srcRef, start: sp };
  } else if (S.tool === 'inset') {
    drag = { mode: 'inset', p, img, srcRef, start: sp, k: 0 };
  } else {
    const h = roiHandleAt(p, pt);
    const hit = h ? h.k : roiUnder(p, sp);
    if (h) {
      drag = { mode: 'resize-inset', p, img, srcRef, k: h.k, corner: h.corner,
               rect0: Object.assign({}, insetRect(img, h.k)) };
    } else if (hit >= 0) {
      const r = insetRect(img, hit);
      drag = { mode: 'move-inset', p, img, srcRef, k: hit,
               off: { x: sp.x - r.x, y: sp.y - r.y } };
    } else {
      drag = { mode: 'pan-crop', p, img, srcRef, start: sp, crop0: srcRef };
    }
  }
  e.preventDefault();
});

/* the W/H boxes resize the cut-outs that already exist -- on their own they only
   ever seeded the default rect, which is why typing in them looked inert */
function resizeInsetsFromFields() {
  const act = activeImage();
  if (!act) return;
  const w = Math.max(8, +S.layout.insetSize || 8);
  const h = Math.max(8, +S.layout.insetSizeH || w);
  applyInsetSize(w, h, S.layout.linkInsetSize ? {} : { only: act });
  updateMagInfo();
}

function setInsetSizeFields(w, h) {
  S.layout.insetSize = Math.round(w);
  S.layout.insetSizeH = Math.round(h);
  $('inset-size').value = Math.round(w);
  $('inset-size-h').value = Math.round(h);
}

window.addEventListener('mousemove', (e) => {
  const pt = canvasPoint(e);
  if (!drag) {
    if (lastPlan && e.target === cv) cv.style.cursor = hoverCursor(pt);
    return;
  }
  if (drag.mode === 'move-text') {
    setLabelOffset(drag.key, { dx: drag.base.dx + (pt.x - drag.start.x),
                               dy: drag.base.dy + (pt.y - drag.start.y) });
    refresh(true);
    return;
  }
  const img = drag.img;
  const sp = toSource(drag.p, pt, drag.srcRef);
  if (drag.mode === 'crop' || drag.mode === 'inset') {
    const x = Math.min(drag.start.x, sp.x), y = Math.min(drag.start.y, sp.y);
    let w = Math.abs(sp.x - drag.start.x), h = Math.abs(sp.y - drag.start.y);
    if (e.shiftKey) { const s = Math.max(w, h); w = s; h = s; }
    if (w < 4 || h < 4) return;
    if (drag.mode === 'crop') img.crop = { x, y, w, h };
    else {
      img.insets[drag.k] = { x, y, w, h };
      setInsetSizeFields(w, h);
      if (S.layout.linkInsetSize) applyInsetSize(w, h, { except: img });
    }
  } else if (drag.mode === 'move-inset') {
    const r = insetRect(img, drag.k);
    img.insets[drag.k] = { x: sp.x - drag.off.x, y: sp.y - drag.off.y, w: r.w, h: r.h };
  } else if (drag.mode === 'pan-inset') {
    const r = drag.rect0;
    img.insets[drag.k] = { x: r.x - (sp.x - drag.start.x), y: r.y - (sp.y - drag.start.y),
                           w: r.w, h: r.h };
  } else if (drag.mode === 'resize-inset') {
    const r0 = drag.rect0;
    const ax = drag.corner.includes('e') ? r0.x : r0.x + r0.w;   // the corner that stays put
    const ay = drag.corner.includes('s') ? r0.y : r0.y + r0.h;
    let w = Math.max(8, Math.abs(sp.x - ax)), h = Math.max(8, Math.abs(sp.y - ay));
    if (e.shiftKey) { const s = Math.max(w, h); w = s; h = s; }
    img.insets[drag.k] = { x: sp.x < ax ? ax - w : ax, y: sp.y < ay ? ay - h : ay, w, h };
    setInsetSizeFields(w, h);
    if (S.layout.linkInsetSize) applyInsetSize(w, h, { except: img });
  } else if (drag.mode === 'pan-crop') {
    const c = drag.crop0;
    img.crop = { x: c.x - (sp.x - drag.start.x), y: c.y - (sp.y - drag.start.y), w: c.w, h: c.h };
  }
  refresh(true);
});

window.addEventListener('mouseup', () => {
  if (drag) {
    if (drag.img) { setActive(drag.img.id); updateMagInfo(); }
    drag = null;
    pushHistory();
  }
});

// right-click turns a label a quarter turn; shift goes the other way
cv.addEventListener('contextmenu', (e) => {
  const tb = textAt(canvasPoint(e));
  if (!tb) return;
  e.preventDefault();
  selText = tb.key;
  rotateLabel(tb.key, e.shiftKey ? 90 : -90);
});

function rotateLabel(key, deg) {
  const rot = ((labelOffset(key).rot || 0) + deg) % 360;
  const n = labelPeers(key).length;
  setLabelOffset(key, { rot });
  refresh(true);
  pushHistory();
  status(`${n > 1 ? n + ' labels' : 'label'} at ${rot}° — right-click again to keep turning, ` +
         'shift+right-click reverses');
}
function nudgeLabel(key, dx, dy) {
  const o = labelOffset(key);
  setLabelOffset(key, { dx: (o.dx || 0) + dx, dy: (o.dy || 0) + dy });
  refresh(true);
  scheduleHistory();
}

cv.addEventListener('dblclick', () => {
  const img = activeImage();
  if (img) { img.crop = null; setActive(img.id); }
});

// ------------------------------------------------------------------- zoom
function setZoom(z, evt) {
  z = clamp(z, 0.05, 8);
  if (Math.abs(z - S.zoom) < 1e-4) return;
  const wrap = $('canvas-wrap');
  let px = 0, py = 0, anchored = false;
  if (evt) {                              // keep the point under the cursor put
    const r = cv.getBoundingClientRect();
    px = (evt.clientX - r.left) / S.zoom;
    py = (evt.clientY - r.top) / S.zoom;
    anchored = true;
  }
  S.zoom = z;
  $('zoom').value = Math.round(z * 100);
  $('zoom-val').textContent = Math.round(z * 100) + '%';
  drawPreview();
  if (anchored) {
    const r2 = cv.getBoundingClientRect();
    wrap.scrollLeft += (r2.left + px * z) - evt.clientX;
    wrap.scrollTop += (r2.top + py * z) - evt.clientY;
  }
}

function fitZoom() {
  drawPreview();                 // refresh() is debounced -- make sure lastPlan is current
  if (!lastPlan) return;
  const wrap = $('canvas-wrap');
  // shrink first: while a big canvas is in the box the wrap reports the canvas size
  cv.style.width = '0px'; cv.style.height = '0px';
  const availW = wrap.clientWidth - 44, availH = wrap.clientHeight - 44;
  if (availW < 20 || availH < 20) { refresh(true); return; }   // window too narrow to measure
  const z = Math.min(availW / lastPlan.width, availH / lastPlan.height, 3);
  S.zoom = clamp(z, 0.05, 8);
  $('zoom').value = Math.round(S.zoom * 100);
  $('zoom-val').textContent = Math.round(S.zoom * 100) + '%';
  refresh(true);
}

// ==================================================================== export
function planForExport() {
  const p = buildPlan();
  delete p._layout;
  return p;
}

async function exportFigure(fmt) {
  fmt = fmt || $('export-format').value;
  const dir = $('exp-dir').value.trim();
  const name = $('exp-name').value.trim() || 'figure';
  busy(true, `rendering ${fmt.toUpperCase()}…`);
  try {
    const body = { plan: planForExport(), format: fmt, filename: name };
    if (dir) body.out_dir = dir;
    const r = await fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) { alert('Export failed: ' + (await r.text()).slice(0, 400)); return; }
    if (dir) {
      const j = await r.json();
      status('saved ' + (j.saved || '?') + (j.bytes ? ` (${(j.bytes / 1048576).toFixed(2)} MB)` : ''));
    } else {
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name + '.' + (fmt === 'tiff' ? 'tif' : fmt);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      status(`exported ${a.download} (${(blob.size / 1048576).toFixed(2)} MB)`);
    }
  } finally { busy(false); }
}

async function batchExport() {
  const dir = $('batch-dir').value.trim();
  if (!dir) { alert('Set an output folder for the batch export.'); return; }
  const fmt = $('export-format').value;
  const saved = S.images.map(i => i.enabled);
  const jobs = [], taken = new Set();
  for (let i = 0; i < S.images.length; i++) {
    if (!saved[i]) continue;
    S.images.forEach((im, k) => { im.enabled = (k === i); });
    const plan = buildPlan(); delete plan._layout;
    // two folders can hold the same file name; without this the second one
    // silently overwrites the first in the output folder
    // .ome.tif loses both halves -- a figure called probe.ome.png reads like a mistake
    const stem = S.images[i].meta.name.replace(/\.[^.]+$/, '').replace(/\.ome$/i, '');
    let name = stem;
    for (let k = 2; taken.has(name); k++) name = `${stem}_${k}`;
    taken.add(name);
    jobs.push({ plan, filename: name });
  }
  S.images.forEach((im, k) => { im.enabled = saved[k]; });
  refresh(true);
  if (!jobs.length) { alert('No images enabled.'); return; }
  busy(true, `exporting ${jobs.length} files…`);
  try {
    const r = await jpost('/api/export/batch', { jobs, out_dir: dir, format: fmt });
    status(`batch: ${(r.written || []).length} files → ${r.out_dir}`);
    if (r.errors && r.errors.length) alert('Some files failed:\n' + r.errors.map(e => e.filename + ': ' + e.error).join('\n'));
    else alert(`Wrote ${(r.written || []).length} files to\n${r.out_dir}`);
  } finally { busy(false); }
}

// =================================================================== presets
function presetPayload() {
  const { images, activeId, zoom, ...rest } = S;
  return JSON.parse(JSON.stringify(rest));
}
async function loadPresetList(sel) {
  const r = await jget('/api/presets');
  const el = $('preset-select');
  el.innerHTML = '<option value="">—</option>' +
    (r.presets || []).map(p => `<option${p === sel ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('');
}

// ==================================================================== sessions
/* A preset is a reusable *look*; a session is a figure *in progress* -- it
   also remembers which images were open (by path) and every per-image edit,
   so loading one puts the whole figure back rather than just the style. */
function sessionPayload() {
  const o = presetPayload();
  o.images = S.images.map(i => ({
    path: i.meta.path, label: i.label, enabled: i.enabled,
    crop: i.crop, rotation: i.rotation, insets: i.insets,
    pixelSize: i.pixelSize, levels: i.levels,
  }));
  const active = activeImage();
  o.activePath = active ? active.meta.path : null;
  return o;
}

async function loadSessionList(sel) {
  const r = await jget('/api/sessions');
  const el = $('session-select');
  el.innerHTML = '<option value="">—</option>' +
    (r.sessions || []).map(s => `<option${s === sel ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
}

async function applySession(d) {
  const paths = (d.images || []).map(im => im.path);
  if (d.src) Object.assign(S.src, d.src);   // doOpen reads S.src for t/z/scene
  S.channels = []; S.activeId = null;
  clearPlanes(); invalidateComposites();
  await doOpen(paths, true);

  const byPath = new Map((d.images || []).map(im => [im.path, im]));
  S.images.forEach(img => {
    const saved = byPath.get(img.meta.path);
    if (!saved) return;
    img.label = saved.label || '';
    img.enabled = saved.enabled !== false;
    img.crop = saved.crop || null;
    img.rotation = saved.rotation || 0;
    img.insets = saved.insets || [];
    img.pixelSize = saved.pixelSize != null ? saved.pixelSize : null;
    img.levels = saved.levels || null;
  });

  // everything else is a full restore, not a merge onto whatever is current
  Object.keys(d).forEach(k => {
    if (k === 'images' || k === 'activePath' || S[k] === undefined) return;
    if (k === 'textOffsets') { S.textOffsets = d.textOffsets || {}; selText = null; return; }
    if (Array.isArray(S[k])) S[k] = JSON.parse(JSON.stringify(d[k] || []));
    else if (S[k] && typeof S[k] === 'object') Object.assign(S[k], d[k] || {});
    else S[k] = d[k];
  });

  const found = d.activePath && S.images.find(i => i.meta.path === d.activePath);
  S.activeId = found ? found.id : (S.images[0] ? S.images[0].id : null);

  renderImageList(); syncAll(); renderChannelCards(); setActive(S.activeId);
  refresh(true); fitZoom();
}

// ====================================================================== init
function initUI() {
  // palettes
  const ph = $('palette-presets');
  PALETTES.forEach(p => {
    const b = document.createElement('button');
    b.className = 'btn small'; b.title = p.name;
    b.innerHTML = p.colors.map(c => `<span style="display:inline-block;width:9px;height:9px;background:${c};border-radius:2px;margin-right:2px"></span>`).join('') + ' ';
    b.onclick = () => {
      chanSettings(activeImage()).forEach((c, i) => { c.color = p.colors[i % p.colors.length]; });
      renderChannelCards(); refresh();
    };
    ph.appendChild(b);
  });

  // tabs
  $('tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tabpage').forEach(x =>
      x.classList.toggle('hidden', x.dataset.page !== b.dataset.tab));
    if (b.dataset.tab === 'scale') updateMagInfo();
  };
  $('tool-seg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.tool = b.dataset.tool;
    document.querySelectorAll('#tool-seg button').forEach(x => x.classList.toggle('active', x === b));
    cv.style.cursor = S.tool === 'select' ? 'default' : 'crosshair';
  };

  // stage
  $('zoom').oninput = (e) => {
    S.zoom = clamp(+e.target.value / 100, 0.05, 8);
    $('zoom-val').textContent = e.target.value + '%';
    refresh(true);
  };
  $('btn-fit').onclick = fitZoom;
  $('show-guides').onchange = (e) => { S.showGuides = e.target.checked; refresh(true); };
  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;

  /* Trackpad pinch arrives as a wheel event with ctrlKey set (Chrome/Edge/
     Firefox); Safari sends gesture* instead.  Plain two-finger scroll is left
     alone so the canvas still pans. */
  const wrap = $('canvas-wrap');
  wrap.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(S.zoom * Math.exp(-e.deltaY * 0.012), e);
  }, { passive: false });
  let gestureZoom0 = 1;
  wrap.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureZoom0 = S.zoom; });
  wrap.addEventListener('gesturechange', (e) => { e.preventDefault(); setZoom(gestureZoom0 * e.scale, e); });
  wrap.addEventListener('gestureend', (e) => e.preventDefault());

  $('btn-labels-reset').onclick = () => {
    S.textOffsets = {}; selText = null;
    refresh(true); pushHistory();
    status('label positions and rotations reset');
  };

  // layout / labels / scale / export bindings
  const B = [
    ['template', 'template', S.layout], ['panel-size', 'panelSize', S.layout, Number],
    ['gap', 'gap', S.layout, Number], ['grid-cols', 'gridCols', S.layout, Number],
    ['outer-pad', 'outerPad', S.layout, Number],
    ['inset-count', 'insetCount', S.layout, Number],
    ['inset-size', 'insetSize', S.layout, Number, resizeInsetsFromFields],
    ['inset-size-h', 'insetSizeH', S.layout, Number, resizeInsetsFromFields],
    ['link-inset-size', 'linkInsetSize', S.layout], ['link-labels', 'linkLabels', S.labels],
    ['inset-box', 'insetBox', S.layout], ['inset-leader', 'insetLeader', S.layout],
    ['inset-color', 'insetColor', S.layout], ['inset-stroke', 'insetStroke', S.layout, Number],
    ['inset-border', 'insetBorder', S.layout],
    ['mono-mode', 'mono', S.layout], ['mono-color', 'monoColor', S.layout],
    ['title-first-only', 'titleFirstOnly', S.labels],
    ['bg-color', 'bg', S.layout, null, contrastLabelsWithBg],
    ['bg-transparent', 'bgTransparent', S.layout, null, contrastLabelsWithBg],
    ['sb-on', 'on', S.scale], ['sb-len', 'len', S.scale, Number], ['sb-auto', 'auto', S.scale],
    ['sb-len-inset', 'lenInset', S.scale, Number], ['sb-auto-inset', 'autoInset', S.scale],
    ['sb-where', 'where', S.scale], ['sb-corner', 'corner', S.scale],
    ['sb-thick', 'thick', S.scale, Number], ['sb-margin', 'margin', S.scale, Number],
    ['sb-color', 'color', S.scale], ['sb-label', 'label', S.scale],
    ['sb-label-size', 'labelSize', S.scale, Number], ['sb-units', 'units', S.scale],
    ['font-family', 'font', S.labels],
    ['title-mode', 'titleMode', S.labels], ['title-size', 'titleSize', S.labels, Number],
    ['title-color', 'titleColor', S.labels], ['title-bold', 'titleBold', S.labels],
    ['title-color-by-channel', 'titleByChannel', S.labels],
    ['rowlabel-mode', 'rowMode', S.labels], ['rowlabel-size', 'rowSize', S.labels, Number],
    ['rowlabel-width', 'rowWidth', S.labels, Number], ['rowlabel-rotate', 'rowRotate', S.labels],
    ['rowlabel-color', 'rowColor', S.labels], ['rowlabel-italic', 'rowItalic', S.labels],
    ['fig-title', 'figTitle', S.labels], ['fig-title-size', 'figTitleSize', S.labels, Number],
    ['fig-title-color', 'figTitleColor', S.labels],
    ['panel-letters', 'letters', S.labels], ['letter-size', 'letterSize', S.labels, Number],
    ['exp-width-mm', 'widthMm', S.exp, Number], ['exp-dpi', 'dpi', S.exp, Number],
    ['exp-upsample', 'upsample', S.exp], ['exp-name', 'name', S.exp],
    ['export-format', 'format', S.exp], ['exp-dir', 'dir', S.exp],
  ];
  B.forEach(([id, prop, obj, cast, onChange]) => bind(id, prop, obj, cast, onChange));

  $('blend-mode').onchange = (e) => { S.blend = e.target.value; refresh(); };
  $('invert-lut').onchange = (e) => { S.invert = e.target.checked; refresh(); };

  $('per-image-levels').onchange = (e) => {
    S.perImageLevels = e.target.checked;
    if (S.perImageLevels) {
      S.images.forEach(img => { if (!img.levels) img.levels = JSON.parse(JSON.stringify(S.channels)); });
    }
    renderChannelCards(); refresh();
  };
  $('btn-auto-all').onclick = () => {
    const img = activeImage(); if (!img) return;
    chanSettings(img).forEach(c => {
      const m = img.meta.channels[c.index];
      if (m) { c.black = Math.round(m.lo); c.white = Math.round(m.hi); }
      c.gamma = 1; c.gain = 1;
    });
    renderChannelCards(); refresh();
  };

  // crop fields
  ['crop-x', 'crop-y', 'crop-w', 'crop-h'].forEach(id => {
    $(id).oninput = () => {
      const img = activeImage(); if (!img) return;
      img.crop = { x: +$('crop-x').value, y: +$('crop-y').value,
                   w: Math.max(1, +$('crop-w').value), h: Math.max(1, +$('crop-h').value) };
      updateMagInfo(); refresh();
    };
  });
  $('rotation').oninput = () => {
    const img = activeImage(); if (!img) return;
    img.rotation = +$('rotation').value; refresh();
  };
  $('btn-crop-reset').onclick = () => {
    const img = activeImage(); if (!img) return;
    img.crop = null; setActive(img.id);
  };
  $('btn-crop-all').onclick = () => {
    const img = activeImage(); if (!img) return;
    const c = fullCrop(img), rot = img.rotation || 0;
    S.images.forEach(o => {
      if (o.id === img.id) return;
      o.crop = { x: c.x, y: c.y, w: Math.min(c.w, o.meta.width), h: Math.min(c.h, o.meta.height) };
      o.rotation = rot;
      // copy the cut-out geometry too, but keep a ROI the user already placed --
      // only its size is forced to match, since the interesting spot differs per image
      for (let k = 0; k < Math.max(1, S.layout.insetCount); k++) {
        const src = insetRect(img, k), own = (o.insets || [])[k];
        // a ROI the user already aimed keeps its center; only its size is matched
        const mx = own ? own.x + own.w / 2 : src.x + src.w / 2;
        const my = own ? own.y + own.h / 2 : src.y + src.h / 2;
        o.insets[k] = { x: mx - src.w / 2, y: my - src.h / 2, w: src.w, h: src.h };
      }
    });
    updateMagInfo(); refresh();
    status('crop, rotation and cut-out size copied to all images');
  };

  // pixel size
  $('pixel-size').oninput = () => {
    const img = activeImage(); if (!img) return;
    img.pixelSize = parseFloat($('pixel-size').value) || null;
    updateMagInfo(); refresh();
  };
  $('btn-px-from-meta').onclick = () => {
    const img = activeImage(); if (!img) return;
    img.pixelSize = null; setActive(img.id);
  };
  $('btn-px-all').onclick = () => {
    const img = activeImage(); if (!img) return;
    const px = pixelSizeOf(img);
    S.images.forEach(o => { o.pixelSize = px; });
    status('pixel size applied to all images'); refresh();
  };

  // labels
  $('autolabel-mode').onchange = () => {
    const m = $('autolabel-mode').value;
    $('autolabel-token-row').classList.toggle('hidden', m !== 'token');
    $('autolabel-regex-row').classList.toggle('hidden', m !== 'regex');
    applyAutoLabels(); refresh();
  };
  $('btn-apply-labels').onclick = () => { applyAutoLabels(); refresh(); };
  $('autolabel-token').onchange = () => { applyAutoLabels(); refresh(); };
  $('autolabel-regex').onchange = () => { applyAutoLabels(); refresh(); };
  $('btn-sort-label').onclick = () => {
    S.images.sort((a, b) => (a.label || '').localeCompare(b.label || '') ||
                            a.meta.name.localeCompare(b.meta.name));
    renderImageList(); refresh();
  };
  $('btn-sort-name').onclick = () => {
    S.images.sort((a, b) => a.meta.name.localeCompare(b.meta.name, undefined, { numeric: true }));
    renderImageList(); refresh();
  };
  $('btn-clear').onclick = () => {
    if (!confirm('Remove all images from the figure?')) return;
    S.images = []; S.activeId = null; clearPlanes(); invalidateComposites();
    renderImageList(); renderChannelCards(); refresh(true);
  };

  // source
  bind('z-mode', 'zMode', S.src); bind('z-index', 'zIndex', S.src, Number);
  bind('t-index', 't', S.src, Number); bind('scene-index', 'scene', S.src, Number);
  $('preview-quality')._sync = () => { $('preview-quality').value = S.src.previewMax; };
  $('preview-quality').onchange = async () => {
    S.src.previewMax = +$('preview-quality').value;
    clearPlanes(); invalidateComposites();
    busy(true, 'reloading previews…');
    try { await Promise.all(S.images.map(im => ensurePlanes(im))); } finally { busy(false); }
    refresh(true);
  };
  $('btn-reload').onclick = async () => {
    const paths = S.images.map(i => i.meta.path);
    const labels = new Map(S.images.map(i => [i.meta.path, i.label]));
    clearPlanes(); invalidateComposites();
    S.images = []; S.activeId = null;
    await doOpen(paths, true);
    S.images.forEach(im => { im.label = labels.get(im.meta.path) || im.label; });
    renderImageList(); refresh(true);
  };

  // browser
  $('btn-open').onclick = () => openBrowser('open');
  $('btn-add').onclick = () => openBrowser('add');

  // export
  $('btn-export-svg').onclick = () => exportFigure('svg');
  $('btn-export-2').onclick = () => exportFigure();
  $('btn-export-batch').onclick = () => {
    document.querySelector('#tabs button[data-tab=export]').click();
    $('batch-dir').focus();
  };
  $('btn-batch-run').onclick = batchExport;
  document.querySelectorAll('[data-mm]').forEach(b => {
    b.onclick = () => { S.exp.widthMm = +b.dataset.mm; $('exp-width-mm').value = b.dataset.mm; refresh(); };
  });
  $('btn-server-preview').onclick = async () => {
    busy(true, 'server render…');
    try {
      const r = await fetch('/api/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planForExport(), scale: 1.5 }),
      });
      const blob = await r.blob();
      $('server-preview').innerHTML = '';
      const im = new Image(); im.src = URL.createObjectURL(blob);
      $('server-preview').appendChild(im);
    } finally { busy(false); }
  };

  // presets
  $('btn-preset-save').onclick = async () => {
    const name = prompt('Preset name', $('preset-select').value || 'my-figure');
    if (!name) return;
    await fetch('/api/presets/' + encodeURIComponent(name), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(presetPayload()),
    });
    await loadPresetList(name);
    status('preset saved: ' + name);
  };
  $('btn-preset-del').onclick = async () => {
    const name = $('preset-select').value;
    if (!name || !confirm('Delete preset ' + name + '?')) return;
    await fetch('/api/presets/' + encodeURIComponent(name), { method: 'DELETE' });
    await loadPresetList();
  };
  $('preset-select').onchange = async () => {
    const name = $('preset-select').value;
    if (!name) return;
    const d = await jget('/api/presets/' + encodeURIComponent(name));
    if (d.error) return;
    Object.keys(d).forEach(k => {
      if (k === 'channels') {
        // keep channel count of the current image, adopt colors/levels where they line up
        d.channels.forEach((c, i) => { if (S.channels[i]) Object.assign(S.channels[i], c); });
      } else if (k === 'textOffsets') {
        S.textOffsets = d.textOffsets || {};   // replace: merging would keep stale placements
        selText = null;
      } else if (S[k] && typeof S[k] === 'object') Object.assign(S[k], d[k]);
      else S[k] = d[k];
    });
    syncAll(); renderChannelCards(); refresh(true);
    status('preset loaded: ' + name);
  };

  // sessions -- a whole figure in progress, not just a look
  $('btn-session-save').onclick = async () => {
    const name = prompt('Session name', $('session-select').value || 'session');
    if (!name) return;
    await fetch('/api/sessions/' + encodeURIComponent(name), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionPayload()),
    });
    await loadSessionList(name);
    status('session saved: ' + name);
  };
  $('btn-session-del').onclick = async () => {
    const name = $('session-select').value;
    if (!name || !confirm('Delete session ' + name + '?')) return;
    await fetch('/api/sessions/' + encodeURIComponent(name), { method: 'DELETE' });
    await loadSessionList();
  };
  $('session-select').onchange = async () => {
    const name = $('session-select').value;
    if (!name) return;
    const d = await jget('/api/sessions/' + encodeURIComponent(name));
    if (d.error) { alert(d.error); return; }
    busy(true, 'loading session…');
    try { await applySession(d); } finally { busy(false); }
    status('session loaded: ' + name);
  };

  // drag & drop upload
  const ov = $('drop-overlay');
  window.addEventListener('dragover', (e) => { e.preventDefault(); ov.classList.remove('hidden'); });
  window.addEventListener('dragleave', (e) => { if (e.clientX === 0 && e.clientY === 0) ov.classList.add('hidden'); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); ov.classList.add('hidden');
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    busy(true, `uploading ${files.length} file(s)…`);
    try {
      const r = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
      (r.images || []).forEach(meta => {
        S.images.push({ id: meta.id, meta, label: '', enabled: true,
                        crop: null, rotation: 0, insets: [], pixelSize: null });
      });
      if (!S.channels.length && S.images.length) initChannels(S.images[0].meta);
      if (!S.activeId && S.images.length) S.activeId = S.images[0].id;
      await Promise.all(S.images.map(im => ensurePlanes(im)));
      applyAutoLabels(); setActive(S.activeId); fitZoom();
    } finally { busy(false); }
  });

  window.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    const t = e.target;
    const isEl = (sel) => !!(t && t.matches && t.matches(sel));
    // inside a text field the browser's own undo is the more useful one
    if (mod && (key === 'z' || key === 'y')) {
      if (isEl('input[type=text],input[type=search],textarea')) return;
      e.preventDefault();
      (key === 'y' || e.shiftKey) ? redo() : undo();
      return;
    }
    if (mod || isEl('input,select,textarea')) return;
    if (key === 'v') document.querySelector('[data-tool=select]').click();
    if (key === 'c') document.querySelector('[data-tool=crop]').click();
    if (key === 'i') document.querySelector('[data-tool=inset]').click();
    if (key === 'f') fitZoom();
    if (e.key === 'Escape' && selText) { selText = null; refresh(true); }
    if (!selText) return;
    if (key === 'r') { rotateLabel(selText, e.shiftKey ? 90 : -90); e.preventDefault(); }
    const step = e.shiftKey ? 10 : 1;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0],
                    ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (nudge) { nudgeLabel(selText, nudge[0], nudge[1]); e.preventDefault(); }
  });
  window.addEventListener('resize', () => refresh());

  $('autolabel-mode').value = 'none';
  $('autolabel-token-row').classList.add('hidden');
  loadPresetList();
  loadSessionList();
  refresh(true);
  pushHistory();                       // seed the baseline undo state
  updateUndoButtons();
  status('ready — open some images to start');
}

initUI();


/* One toggle, the same place in every tool, and the choice is remembered for
   the machine rather than for the app -- switching tools should not switch
   look.  Dark is the default: a microscope room is not a bright place. */
LK.mountThemeToggle('.topbar');
