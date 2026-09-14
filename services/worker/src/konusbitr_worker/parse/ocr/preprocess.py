"""Making a degraded scan legible, without losing track of where anything is.

Four operations, in a fixed order, each of which earns its place on a different
kind of bad input:

1. **DPI normalisation.** A fax-resolution scan embedded at 150 DPI renders a
   10pt line about twenty pixels tall. Both engines are trained on text roughly
   twice that, and recognition falls off sharply below it, so a page under
   :data:`MIN_OCR_DPI` is upscaled with Lanczos before anything else touches it.
2. **Deskew.** A page fed through a sheet feeder at two degrees produces text
   lines that no line-grouping heuristic can assemble, and both engines drop
   accuracy steeply past about one degree. The angle is measured on the whole
   page and the page is rotated back.
3. **Denoise.** Bilateral filtering rather than a Gaussian blur, because a
   Gaussian removes paper grain and character edges with equal enthusiasm.
4. **Binarisation.** Sauvola: a local threshold computed from the mean and
   standard deviation in a window, which is what handles the shadow across the
   gutter of a photographed book. Otsu picks one threshold for the whole page
   and throws away everything in the shadow.

**The part that is easy to get wrong is step 2.** Rotating the bitmap moves
every pixel, so a word box found in the deskewed image is in a frame that does
not exist in the document. Every step therefore records its transform, and
:meth:`Preprocessed.to_source` maps a point back into the original raster —
which is the frame `docs/coordinates.md` is defined against. Skipping that
puts every highlight on a scanned page off by the skew angle, which is subtle
enough at the top of the page to look like a rounding error and obvious enough
at the bottom to look like a bug.

Binarisation is kept as a *second* product rather than replacing the first.
PP-OCRv4 is trained on photographs and greyscale and reads a hard black-and-white
page slightly worse than the original; Tesseract binarises internally anyway and
does better when it is handed a good threshold than when it computes its own.
So the primary engine gets the denoised image and the fallback gets the binary
one, and because both come out of the same geometric pipeline a single
:meth:`to_source` covers them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from konusbitr_worker.log import get_logger

__all__ = [
    "MAX_DESKEW_DEGREES",
    "MIN_DESKEW_DEGREES",
    "MIN_OCR_DPI",
    "Preprocessed",
    "preprocess",
]

logger = get_logger("konusbitr.worker.parse.ocr.preprocess")

#: Below this, the page is upscaled before recognition.
MIN_OCR_DPI = 300.0

#: Skew smaller than this is left alone. Rotating a bitmap resamples every
#: pixel, and half a degree costs more in interpolation blur than it recovers in
#: line straightness.
MIN_DESKEW_DEGREES = 0.5

#: Skew larger than this is not skew. A page at 60 degrees is a page that was
#: scanned sideways or a detector that locked onto a table rule, and "correcting"
#: it turns a readable page into an unreadable one. Quarter turns are the PDF's
#: own `/Rotate` and were applied before this module ever saw the bitmap.
MAX_DESKEW_DEGREES = 45.0

#: Sauvola's window, in pixels at 300 DPI. Roughly one and a half lines of body
#: text: wide enough to contain both ink and paper, narrow enough that a shadow
#: across the page is a different threshold at each end of it.
_SAUVOLA_WINDOW = 41

#: Sauvola's `k`. The standard value from the 2000 paper; lower keeps more faint
#: ink and more noise with it, higher drops both.
_SAUVOLA_K = 0.2


@dataclass(slots=True)
class Preprocessed:
    """The images an engine reads, and the map back to where they came from."""

    #: Denoised, deskewed, upscaled. RGB. What the primary engine reads.
    image: Any
    #: The same page, binarised. Single-channel. What the fallback reads.
    binary: Any
    #: Degrees the page was rotated by, positive counter-clockwise. Diagnostic.
    deskew_degrees: float
    #: Factor the page was upscaled by, 1.0 when it was already big enough.
    upscale: float
    #: The 2x3 affine that maps a point in `image` back into the source raster.
    _inverse: Any

    def to_source(self, x: float, y: float) -> tuple[float, float]:
        """Map one point from the preprocessed frame back to the source raster."""
        m = self._inverse
        return (
            float(m[0][0] * x + m[0][1] * y + m[0][2]),
            float(m[1][0] * x + m[1][1] * y + m[1][2]),
        )

    def box_to_source(
        self, box: tuple[float, float, float, float]
    ) -> tuple[float, float, float, float]:
        """Map an axis-aligned box back, as the box that encloses its four corners.

        Un-rotating a rectangle produces a rectangle at an angle, and the
        artifact stores axis-aligned boxes — so the enclosing box is what comes
        back. It is slightly larger than the ink at the page's skew angle, which
        is the honest trade: a highlight a little loose around a word is
        correct, and a tight box in the wrong frame is not.
        """
        x0, y0, x1, y1 = box
        corners = [
            self.to_source(x0, y0),
            self.to_source(x1, y0),
            self.to_source(x1, y1),
            self.to_source(x0, y1),
        ]
        xs = [point[0] for point in corners]
        ys = [point[1] for point in corners]
        return (min(xs), min(ys), max(xs), max(ys))


def preprocess(image: Any, *, dpi: float, deskew_enabled: bool = True) -> Preprocessed:
    """Run the whole chain over one page bitmap. Synchronous and CPU-bound."""
    import cv2
    import numpy as np

    source_height, source_width = image.shape[:2]

    upscale = 1.0
    working = image
    if dpi > 0 and dpi < MIN_OCR_DPI:
        upscale = MIN_OCR_DPI / dpi
        working = cv2.resize(
            image,
            (round(source_width * upscale), round(source_height * upscale)),
            # Lanczos rather than linear: upscaling text is exactly the case
            # where a sharper kernel is worth its ringing, because the thing
            # being preserved is the edge between a stroke and the paper.
            interpolation=cv2.INTER_LANCZOS4,
        )

    grey = cv2.cvtColor(working, cv2.COLOR_RGB2GRAY)

    angle = _skew_angle(grey) if deskew_enabled else 0.0
    if angle != 0.0:
        working, grey, rotation = _rotate(working, grey, angle)
    else:
        rotation = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64)

    # forward = rotate ∘ scale, as 3x3, so one inversion covers both steps.
    forward = np.eye(3, dtype=np.float64)
    forward[:2, :] = rotation
    scaling = np.eye(3, dtype=np.float64)
    scaling[0][0] = upscale
    scaling[1][1] = upscale
    inverse = np.linalg.inv(forward @ scaling)[:2, :]

    denoised = cv2.bilateralFilter(working, d=5, sigmaColor=45, sigmaSpace=45)
    binary = _sauvola(grey)

    return Preprocessed(
        image=denoised,
        binary=binary,
        deskew_degrees=angle,
        upscale=upscale,
        _inverse=inverse,
    )


def _skew_angle(grey: Any) -> float:
    """Measure the page's skew, or return 0.0 when there is nothing to correct.

    `deskew`'s Radon-transform estimator rather than a minimum-area rectangle
    over the ink: the rectangle method is thrown off by a single long table rule
    or a page border, both of which are common in exactly the scanned documents
    this tier exists for.
    """
    try:
        from deskew import determine_skew
    except ImportError:  # pragma: no cover - the package is a hard dependency
        return 0.0

    try:
        measured = determine_skew(grey)
    except Exception:
        # A blank page, or a page whose ink gives the estimator nothing to lock
        # onto. Not an error: it means there is no skew to correct.
        logger.debug("skew estimation found no angle", exc_info=True)
        return 0.0

    if measured is None:
        return 0.0
    angle = float(measured)
    if not MIN_DESKEW_DEGREES <= abs(angle) <= MAX_DESKEW_DEGREES:
        return 0.0
    return angle


def _rotate(image: Any, grey: Any, angle: float) -> tuple[Any, Any, Any]:
    """Rotate both products by `angle`, growing the canvas so no ink is cropped.

    The canvas has to grow. Rotating a full page in place pushes all four
    corners outside the frame, and the corners of a scanned page are where the
    page number and the signature block live.
    """
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    centre = (width / 2.0, height / 2.0)
    matrix = cv2.getRotationMatrix2D(centre, angle, 1.0)

    cos = abs(matrix[0][0])
    sin = abs(matrix[0][1])
    bounded_width = int(height * sin + width * cos)
    bounded_height = int(height * cos + width * sin)
    matrix[0][2] += bounded_width / 2.0 - centre[0]
    matrix[1][2] += bounded_height / 2.0 - centre[1]

    size = (bounded_width, bounded_height)
    # White rather than black: the border is paper, and a black margin gives
    # both the binariser and the text detector an edge that is not there.
    rotated = cv2.warpAffine(
        image, matrix, size, flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255)
    )
    rotated_grey = cv2.warpAffine(grey, matrix, size, flags=cv2.INTER_CUBIC, borderValue=255)
    return rotated, rotated_grey, np.asarray(matrix, dtype=np.float64)


def _sauvola(grey: Any) -> Any:
    """Local adaptive threshold: `T(x) = m(x) * (1 + k * (s(x)/128 - 1))`.

    Implemented over OpenCV box filters rather than pulled in from
    scikit-image, which would add a large dependency for one function. The
    mean and the mean of squares over the window give the standard deviation in
    two passes, which is the whole of the method.
    """
    import cv2
    import numpy as np

    values = grey.astype(np.float32)
    window = (_SAUVOLA_WINDOW, _SAUVOLA_WINDOW)
    mean = cv2.boxFilter(values, ddepth=cv2.CV_32F, ksize=window, normalize=True)
    mean_square = cv2.boxFilter(values * values, ddepth=cv2.CV_32F, ksize=window, normalize=True)
    # Clipped at zero: the two box filters are computed independently and
    # floating-point error can make the difference very slightly negative on a
    # perfectly uniform region, where the true variance is exactly zero.
    variance = np.clip(mean_square - mean * mean, 0.0, None)
    deviation = np.sqrt(variance)

    threshold = mean * (1.0 + _SAUVOLA_K * (deviation / 128.0 - 1.0))
    return np.where(values > threshold, 255, 0).astype(np.uint8)
