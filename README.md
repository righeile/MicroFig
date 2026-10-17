# MicroFig

A local web app for turning raw microscopy files into publication-ready figures:
pseudocolor, levels, scale-aware zoom cut-outs, scale bars, multi-panel layouts,
and vector SVG export.

The crop, the ROI and the levels are dragged rather than typed, and the scale comes
from the file's own metadata.

## Install

Python 3.9 or newer, and the packages in `requirements.txt`:

```bash
cd MicroFig
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt   # Windows: .venv\Scripts\python -m pip
```

Use `python -m pip` rather than `.venv/bin/pip` — moving the folder leaves the
`pip` script pointing at an interpreter that is no longer there, while `python -m pip`
always finds its own. An existing conda or system environment works too, as long as
it satisfies `requirements.txt`; the app imports nothing else.

`bioio` is what reads the microscope formats, one reader package per family —
`bioio-czi`, `bioio-tifffile` (also LSM), `bioio-ome-tiff`, `bioio-nd2`,
`bioio-lif`. All come from `requirements.txt`, but a reader that failed to build
does not announce itself: the format simply reports as unsupported. `python3 -c
"import bioio_czi"` says whether CZI is there.

If the launcher runs the system Python rather than the venv, put the venv first on
the path or start the app with `.venv/bin/python app.py`.

## Run

```bash
python3 app.py            # or .venv/bin/python app.py
```

It opens <http://127.0.0.1:5678> automatically. Nothing leaves your machine; the
server binds to localhost only. `run_mac.command` and `run_windows.bat` (double-clickable) do
the same, after stopping a copy still running on the port. `PORT=5679 python3 app.py`
moves it, and `--no-browser` starts it without opening a tab.

### Checking it works

```bash
python3 selftest.py
```

It checks the things that can silently render the wrong figure: that the levels
math in `static/app.js` still agrees with `render.py` (it runs the browser's own
`lutFor` under `node`, so a change to either side that drifts from the other fails
here), that a transparent canvas lands on the background you asked for rather than
on black, and that every preview resolution returns a usable plane. No test data
needed. The levels check is skipped if `node` is not installed.

## Formats

CZI, TIFF / OME-TIFF, LSM, ND2, LIF and ordinary PNG/JPG — anything `bioio` has a
reader package for. 16-bit data is kept at full depth all the way to export; only
the on-screen preview is downsampled.

`.oib`, `.oif`, `.zvi` and `.ims` are offered by the file browser but need
`bioio-bioformats`, which needs a JVM, so they do not open. `.sld` is not
supported: its reader is the one package in the bioio family still pinned to
numpy 1.

## The workflow

1. **Open images…** browses your drive directly (no upload), or drop files on the window.
   Multi-select with click / shift-click / *select all*. Every image you open becomes a
   row of one figure.
2. **Channels** — color, name, black/white point, gamma and gain per channel.
   Drag directly on the histogram to set the black and white points. Each channel also
   carries two scope tick-boxes, **merge** and **cut-outs**, so a channel can appear in
   one and not the other. Transmitted-light channels (`T PMT`, `phase`, `DIC`, …) start
   hidden; nuclear stains (`DAPI`, `Hoechst`, …) start **in the merge but out of the
   cut-outs**, which is almost always what you want.
3. **Layout** — pick a template, set the panel height, and place the zoom cut-outs.
4. **Scale** — the pixel size is read from the file metadata; scale bar lengths are
   chosen automatically per panel and can be overridden.
5. **Export SVG** — vector text and scale bars, images embedded at the DPI you ask for.

### Tools

| Tool | What dragging does |
|---|---|
| **Select** (`v`) | move a zoom ROI, resize it by its corner handles, or drag inside a zoom panel to slide the cut-out over the image; drag anywhere else pans the crop |
| **Crop** (`c`) | rubber-band a new crop (hold <kbd>shift</kbd> for square) |
| **Inset ROI** (`i`) | rubber-band a new zoom cut-out |

Double-click a panel to reset its crop to the full frame. `f` fits the figure to the window.

### Moving things by hand

- **Zoom cut-outs.** With the Select tool the ROI box on an overview panel carries four
  corner handles: drag inside it to move it, drag a handle to resize it (<kbd>shift</kbd>
  keeps it square). Dragging *inside the zoom panel itself* pans the cut-out over the
  source image, which is usually the quickest way to hunt for the right spot. The cursor
  tells you which of the three you are about to get.
- **Labels.** Every piece of text — channel titles, row labels, the figure title, scale
  bar captions, panel letters — can be dragged to wherever it reads best. Right-click a
  label to turn it 90° (click again to keep turning, <kbd>shift</kbd>+right-click goes
  back); with a label selected, `r` does the same and the arrow keys nudge it one unit at
  a time (<kbd>shift</kbd> for ten). <kbd>Esc</kbd> deselects. Placements are keyed to the
  label, not to a screen position, so they survive a change of template or panel size,
  and they are saved with the preset and used by the export. *Reset all label positions*
  in the Labels tab undoes the lot.
- **Apply moves and turns to every label of the same kind** (Labels tab, on by default)
  means one right-click stands *all* the row labels on end, and one drag moves *all* the
  channel titles by the same amount — which is also how you get them aligned with each
  other. Kinds are independent: turning the row labels leaves the channel titles alone.
  Untick it to place a single label on its own.

### Zoom, undo

| | |
|---|---|
| Pinch on the trackpad | zoom the canvas 5–800 %, anchored on the pointer |
| Two-finger scroll | pan, as usual |
| `f` / **Fit** | fit the whole figure in the window |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> | undo |
| <kbd>⇧⌘Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | redo |

Undo covers everything that changes the figure — levels, colors, crops, ROIs, layout,
label placement, even *Clear all*, which comes back with its images and their settings
intact. A slider drag lands as one step rather than one per pixel. Zoom and the guide
overlay are view settings and are deliberately not recorded.

## Channel scope and grayscale cut-outs

The usual figure idiom is a colored merge with grayscale single-channel zooms, and
nuclei shown only in the overview. Two controls give you that:

- **merge / cut-outs** tick-boxes on each channel card. Untick *cut-outs* on DAPI and it
  keeps contributing to every merge while producing no zoom panel of its own. In
  templates where channels are columns, the excluded channel leaves an empty slot rather
  than shifting the row, so columns stay aligned.
- **Single-channel panels → draw lone channels in** (Channels tab): *their own color*,
  *gray — cut-outs only*, or *gray — everywhere*. Merges are never affected; only panels
  showing exactly one channel. The gray is a color picker, so off-white also works.

### Color presets

The swatch buttons assign colors **by channel position**, so check the order matches
your file. The named palettes are the pure primaries and secondaries — cyan is
`#00FFFF`, magenta `#FF00FF`, yellow `#FFFF00`, blue `#0000FF`, red `#FF0000`, green
`#00FF00` — with nothing mixed in to brighten them; `Okabe-Ito` is the one exception, a
published color-blind-safe set whose whole point is its exact hexes. The colors guessed
from channel names (DAPI → blue, 488 → green, 555 → magenta) are pure too. Pure blue is
genuinely dark on a black background, which is the honest rendering of a blue channel; if
you want the nuclei to read more strongly, pick cyan for that channel rather than a
lightened "blue".

## Layout templates

| Template | Shape |
|---|---|
| `channels + merge` | one row per image: each channel, then the merge |
| `channels + merge, insets below` | as above with a second row of zoomed cut-outs |
| `merge + stacked insets` | compact: large merge, per-channel zooms stacked beside it |
| `merge + insets in a row` | merge followed by several zoom regions |
| `merge only` | just the merge — with *cells per row* this is the classic condition grid |
| `images as columns` | images across, channels down |

**Cells per row** (Layout tab) tiles the per-image blocks into a grid instead of one tall
column, and it applies to every template above except *images as columns*. So
`merge + stacked insets` with *cells per row* = 2 gives a two-across figure where each
cell is a merge plus its own stack of zooms.

## Zoom cut-outs and scale

A cut-out keeps its own magnification. Each panel's scale bar is computed from that
panel's own source region and displayed size, so the overview and the zoom get
correct — and different — bars (typically 20 µm and 5 µm). The **Scale** tab reports
the magnification factor between them.

**Cut-outs are never stretched.** A panel takes the aspect ratio of the region it is
showing and sits centered in whatever slot the grid gave it, so pulling a ROI out into a
2:1 rectangle produces a 2:1 panel rather than a squashed square. The same holds for the
overview when its crop is not square, and for a figure whose images have differently
shaped ROIs.

**W / H (src px)** in the Layout tab resize the cut-outs that already exist, each about
its own center so a ROI you have already aimed stays aimed. **Link cut-out size across
all images** (on by default) means resizing one — by handle or by typing — resizes every
cut-out in the figure to match, which is what you want when the panels are being
compared. Untick it to size one image on its own.

`Placement` chooses which panels are labeled. Overview panels and inset panels are
treated as separate groups, so *first panel of each row* puts one bar on the overview
and one on the zoom.

> Pixel size comes from the file rather than a constant. A fixed µm/px is only right
> for one zoom setting: `135/2048 = 0.0659 µm/px`, for example, does not fit the
> lysosensor stacks tested here, which report `0.0879 µm/px` in their metadata, so check
> the scale bar of any figure made with a fixed value against the file. If a file
> carries no calibration the app says so and skips the bar rather than inventing one;
> type the value in and use *Apply to all*.

## Whole figures and batch

Every image in the list is a row of one figure, so the normal export already produces
a complete multi-panel figure. Beyond that:

- **Auto-label from filename** turns `2_C3-488_..._D678A_T9_7.czi` into a row label —
  pick *token by _* with an index or give a regex.
- **Sort by label / by name**, drag rows to reorder, untick to exclude.
- **Apply to all** copies the active image's crop, rotation or pixel size to every image.
- **per-image levels** lets each image keep its own black/white points when brightness
  differs; leave it off to force one common setting across the figure — which is what
  you want when panels are compared to each other.
- **Batch export** (Export tab) renders the current template *separately for every
  image* and writes one file each, named after the source image.

### Design one cell, then repeat it

The intended flow is to get a single image looking right and then propagate it:

1. Open one image, set channel colors, levels, scopes and the template.
2. Drag the crop and the cut-out ROI on that image until the cell reads well.
3. **Apply to all** (Layout tab) copies the crop, the rotation and the cut-out *size* to
   every other image. A ROI you have already positioned keeps its position — only its
   size is matched — because the interesting spot is somewhere different in each image.
4. Add the rest of the images, drag each cut-out to its own region of interest.
5. Set **cells per row** and export one figure.

Channel settings are global by default, so step 1 already applies to everything; tick
**per-image levels** only when you deliberately want each image scaled on its own.
**Label the first cell only** (Labels tab) keeps the channel names on the first cell
instead of repeating them across all of them.

## Export

- **SVG** — panels embedded as PNG at the chosen DPI, everything else vector. Text is
  real `<text>` with live fonts, so labels stay editable in Illustrator and Inkscape.
  The file carries its physical size (`width="180mm"`), so it lands at the right size.
- **PNG / TIFF** at the same physical size and DPI, with the resolution tag set.
- **PDF** for quick circulation.

The canvas is white by default (*Layout ▸ Canvas*), and can be any color or
**transparent**. Transparency survives into SVG and PNG; TIFF and PDF have no alpha,
so those two are flattened onto white and say so here rather than quietly turning
black. Titles, row labels and the figure title are the text that sits on the canvas
rather than on an image, so changing the background flips them between black and
white — unless you have picked a color of your own, which is left alone.

Figure width presets are the usual journal columns: 85, 114 and 180 mm.

Rasters are never upsampled past the native pixels of the source region unless you
tick *allow upsampling* — a 220 px cut-out is embedded as 220 px rather than blown up
to 300 dpi, which keeps the file honest and small.

**Server render check** (Export tab) re-renders the figure through the export code
path and shows the result, so you can confirm the preview and the file agree.

## Presets

*Save* stores every setting except the images themselves into `presets/` as JSON.
Loading one applies the whole look — colors, levels, layout, scale bars, fonts — to
whatever images are open, which is how you keep a series of figures consistent.

## Sessions

A preset remembers a *look*; a **session** remembers a *figure in progress*. *Save*
under Session writes everything a preset does, plus the open images' file paths and
every per-image edit — crop, rotation, cut-outs, label placements, per-image levels —
into `sessions/` as JSON. Loading one re-reads those files from disk (they are read
fresh, not embedded, so nothing leaves your machine and the file stays small) and puts
the whole figure back exactly where you left it, ready to keep working rather than just
to look at. If a source file has since moved or been deleted, that one image is
reported missing and the rest of the session still loads.

## How it works

The browser resolves the layout into a flat list of drawing items and renders it on a
canvas. Export posts that same resolved geometry to the server, which re-renders it at
full resolution. The preview and the file are therefore the same figure, not two
implementations of it. The levels math is duplicated in `render.py` and `static/app.js`
and must stay in sync — it is the one place the two sides could drift.

```
app.py       Flask routes: browse, open, plane data, export, presets
imgio.py     file reading, metadata, channel statistics, LRU stack cache
render.py    levels, compositing, SVG and raster writers
static/      index.html, app.css, app.js  (no build step, no CDN)
selftest.py  runs the browser's own compositor against render.py's
```

Decoded stacks are cached in memory up to ~3.5 GB and evicted least-recently-used.
Preview planes are sent as raw 16-bit and composited in the browser, so moving a
slider re-renders every panel of the figure without touching the server.

The browser composites through a 65 536-entry lookup table per channel, packed one
RGBA word per level, so a single-channel panel is one lookup and one store per pixel.
It composites only what the panel actually shows. Each plane keeps halved copies of
itself, and a panel reads the coarsest one that still holds a sample per screen pixel,
then cuts out the rectangle it needs rather than the whole plane. A twelve-panel
figure at fit zoom composites 0.8 M pixels instead of 3.1 M, and redraws in 10 ms
instead of 59. Averaging the raw plane before applying levels is also what the server
does before it composites, so this moves the preview towards the export rather than
away from it: an off-edge cut-out now shows the same black margin on screen that comes
out in the file. A rotated image works the same way — the panel's rectangle is turned
back into the plane's own frame, and only that much is composited — so the corners a
turn exposes are the color the export gives them rather than the figure background
showing through.

Finished tiles are cached under a key that carries the color, levels, blend, invert,
resolution, rectangle and angle, which is why turning a channel off and on again is free, and
why panning slides through a tile instead of rebuilding one. Only a change of the plane
data itself — a reload, or a different preview resolution — throws that away.
Single-channel panels are byte-identical to the export; an additive merge sums
already-rounded bytes on the client and floats on the server, so it can differ by one
level out of 255. `selftest.py` holds both claims, and checks the halving and the
cut-out against the server's own code.
