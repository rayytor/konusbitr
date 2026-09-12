# Coordinates

Konusbitr has exactly one coordinate convention, and everything that produces or
consumes a bounding box obeys it:

> **PDF user-space points, origin top-left, y increasing downward, on the
> unrotated page.**

That sentence is the whole specification. The rest of this document explains
what it excludes, where the conversion happens, and why the conversion happens
*there* rather than somewhere more convenient.

## Why it matters more here than in most products

A citation is the product. When a user clicks a quoted sentence in an answer,
the viewer scrolls to a page and draws a rectangle around that sentence. A
rectangle that is off by the height of a line looks like a bug; a rectangle
drawn on the wrong page looks like a lie. Coordinates are therefore not a
rendering detail — they are the mechanism by which an answer can be checked,
and an unverifiable answer is worth very little.

Bounding boxes reach us from several places that disagree with each other. PDF
itself puts the origin at the **bottom** left. Docling can emit either origin
depending on the backend. OCR engines (Phase 12) work in pixels of a rendered
raster at whatever DPI they were handed. Every browser canvas is top-left with y
down. Left alone, each of those conventions leaks into whichever file first
touches it, and the viewer ends up with a pile of special cases nobody can
safely change.

## The definition, precisely

For a page of width `w` and height `h` (both in points, both stored on the
`pages` row):

- `x = 0` is the left edge of the page, `x = w` the right edge.
- `y = 0` is the **top** edge of the page, `y = h` the bottom edge.
- A bbox is `[x0, y0, x1, y1]` with `x0 <= x1` and `y0 <= y1`, so `y0` is the
  box's top and `y1` its bottom.
- Units are PDF points (1/72 inch), never pixels, never a normalized fraction.
- The page is the **unrotated** page: rotation recorded in the PDF's `/Rotate`
  entry has already been applied to the coordinates, and `w`/`h` are the
  dimensions of the page *as a reader sees it*.

That last point is the one that is easy to get wrong. A page authored in
landscape and stored as a portrait `MediaBox` with `/Rotate 90` has, in raw PDF
terms, width 612 and height 792 — but a person looking at it sees 792 wide by
612 tall, and that is what `pages.width` and `pages.height` hold. The worker
rotates each box into the same frame, so a bbox never needs to be interpreted
alongside a rotation flag. There is no rotation flag.

## Where the conversion happens

**In the worker, once, at normalization time** —
`services/worker/src/konusbitr_worker/parse/geometry.py`. Nothing downstream
converts anything:

```
Docling / OCR output  ──►  geometry.normalize_bbox()  ──►  parse artifact
  (any origin, any                (one place)               (this convention)
   rotation, page space)
```

The viewer in Phase 11 therefore applies a **scale factor and nothing else**:

```ts
const scale = renderedWidthPx / page.width;
const rect = { left: x0 * scale, top: y0 * scale,
               width: (x1 - x0) * scale, height: (y1 - y0) * scale };
```

If the viewer ever needs more than that — a flip, a rotation, an offset, a
per-document fudge — the bug is in the worker and the fix belongs in the worker.
Compensating in the viewer is how a rendering layer silently becomes a second,
undocumented coordinate system.

## The conversions, written out

Given Docling's page height `h_raw` and a box in Docling's own frame:

**Bottom-left origin → top-left origin.** Docling's `BOTTOMLEFT` boxes carry
`t` above `b` in value because y grows upward:

```
y0 = h_raw - max(t, b)
y1 = h_raw - min(t, b)
```

**Top-left origin.** Already correct; only sorted so `y0 <= y1`.

**Rotation**, applied after the origin flip, for a page whose `/Rotate` is `r`
degrees clockwise. With the unrotated-frame box `(x0, y0, x1, y1)` on a page
`w_raw × h_raw`, the visible page becomes `w × h` and the box maps to:

| `r`   | visible size    | mapped box                                          |
| ----- | --------------- | --------------------------------------------------- |
| `0`   | `w_raw × h_raw` | `(x0, y0, x1, y1)`                                  |
| `90`  | `h_raw × w_raw` | `(h_raw - y1, x0, h_raw - y0, x1)`                  |
| `180` | `w_raw × h_raw` | `(w_raw - x1, h_raw - y1, w_raw - x0, h_raw - y0)`  |
| `270` | `h_raw × w_raw` | `(y0, w_raw - x1, y1, w_raw - x0)`                  |

Rotations are normalized into `{0, 90, 180, 270}` first; PDFs in the wild carry
negative and out-of-range values, and `-90` must mean `270` rather than raise.

## Invariants the tests hold

`services/worker/tests/test_geometry.py` and `tests/test_parse_fixtures.py`
assert, on real fixture PDFs:

- every element in `contents` has a `page` in `[1, pageCount]` and a bbox;
- every bbox lies inside its page's `width`/`height`, with `y` measured from the
  top;
- a heading known to be near the top of the page has a small `y0` — the single
  assertion that catches a flipped axis, which is otherwise entirely plausible;
- a rotated fixture yields boxes in the rotated (visible) frame, and its page
  row records the rotated dimensions;
- a non-Letter fixture (A4) is not silently measured against 612×792.

## What is *not* in this convention

- **Pixels.** Thumbnails and, later, OCR rasters are rendered at a DPI the
  worker chooses; those pixel coordinates are converted to points before they
  are stored and never escape the module that produced them.
- **Normalized fractions.** Storing `0..1` would make a box unreadable without
  its page row and would quietly round away precision on large pages.
- **Percentages, CSS units, or device pixels.** Those are the viewer's business
  and are derived from a scale factor at render time.
