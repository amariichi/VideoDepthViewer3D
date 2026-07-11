"""Camera calibration and display-space normalization helpers.

The browser displays video after applying container rotation and sample-aspect
ratio (SAR).  PyAV exposes decoded frames in coded pixel coordinates, so depth
inference must apply the same transform before its output can share texture UVs
with the browser video.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import isfinite, tan, radians
from typing import Literal

import numpy as np
from PIL import Image

try:  # pragma: no cover - inference extra provides the faster path
    import cv2
except ImportError:  # pragma: no cover - base/dev installs use Pillow fallback
    cv2 = None  # type: ignore[assignment]

CalibrationOrigin = Literal["metadata", "estimated", "manual", "fallback"]


@dataclass(frozen=True, slots=True)
class CameraCalibration:
    """Pinhole calibration in square-pixel display coordinates."""

    fx: float
    fy: float
    cx: float
    cy: float
    source_width: int
    source_height: int
    display_width: int
    display_height: int
    inference_width: int
    inference_height: int
    pixel_aspect_ratio: float
    rotation_degrees: int
    crop_x: int = 0
    crop_y: int = 0
    crop_width: int = 0
    crop_height: int = 0
    origin: CalibrationOrigin = "fallback"
    confidence: float = 0.0

    @property
    def display_aspect(self) -> float:
        return self.display_width / max(self.display_height, 1)

    def as_dict(self) -> dict[str, float | int | str]:
        return asdict(self)


def normalize_rotation_degrees(value: float | int | None) -> int:
    """Return the nearest counter-clockwise quarter-turn in ``[0, 360)``."""

    if value is None or not isfinite(float(value)):
        return 0
    return int(round(float(value) / 90.0) * 90) % 360


def square_pixel_dimensions(
    width: int,
    height: int,
    pixel_aspect_ratio: float,
) -> tuple[int, int]:
    """Preserve display aspect without increasing decoded pixel count.

    Expanding anamorphic content before inference wastes work.  Shrinking the
    opposite axis produces the same display aspect and keeps normalized texture
    coordinates unchanged.
    """

    width = max(int(width), 1)
    height = max(int(height), 1)
    sar = float(pixel_aspect_ratio)
    if not isfinite(sar) or sar <= 0:
        sar = 1.0
    if sar >= 1.0:
        return width, max(1, round(height / sar))
    return max(1, round(width * sar)), height


def expanded_square_pixel_dimensions(
    width: int,
    height: int,
    pixel_aspect_ratio: float,
) -> tuple[int, int]:
    """Return browser-style display dimensions without shrinking an axis."""

    width = max(int(width), 1)
    height = max(int(height), 1)
    sar = float(pixel_aspect_ratio)
    if not isfinite(sar) or sar <= 0:
        sar = 1.0
    if sar >= 1.0:
        return max(1, round(width * sar)), height
    return width, max(1, round(height / sar))


def build_fallback_calibration(
    *,
    source_width: int,
    source_height: int,
    sar_numerator: int = 1,
    sar_denominator: int = 1,
    rotation_degrees: int = 0,
    fov_y_degrees: float = 50.0,
) -> CameraCalibration:
    """Construct centered K after applying rotation and SAR.

    Video containers normally do not carry camera intrinsics.  The fallback
    vertical FOV is explicit so a later manual calibration can replace it
    without changing the display transform.
    """

    rotation = normalize_rotation_degrees(rotation_degrees)
    sar_denominator = sar_denominator or 1
    sar = sar_numerator / sar_denominator
    if not isfinite(sar) or sar <= 0:
        sar = 1.0

    if rotation in (90, 270):
        rotated_width, rotated_height = source_height, source_width
        display_sar = 1.0 / sar
    else:
        rotated_width, rotated_height = source_width, source_height
        display_sar = sar

    display_width, display_height = expanded_square_pixel_dimensions(
        rotated_width,
        rotated_height,
        display_sar,
    )
    inference_width, inference_height = square_pixel_dimensions(
        rotated_width,
        rotated_height,
        display_sar,
    )
    fov_y = min(max(float(fov_y_degrees), 1.0), 179.0)
    focal = 0.5 * display_height / tan(radians(fov_y) / 2.0)

    return CameraCalibration(
        fx=focal,
        fy=focal,
        cx=(display_width - 1) / 2.0,
        cy=(display_height - 1) / 2.0,
        source_width=max(int(source_width), 1),
        source_height=max(int(source_height), 1),
        display_width=display_width,
        display_height=display_height,
        inference_width=inference_width,
        inference_height=inference_height,
        pixel_aspect_ratio=sar,
        rotation_degrees=rotation,
        crop_width=display_width,
        crop_height=display_height,
        origin="fallback",
        confidence=0.25,
    )


def normalize_frame_for_display(
    frame: np.ndarray,
    calibration: CameraCalibration,
) -> np.ndarray:
    """Apply display-matrix rotation and SAR correction to an RGB frame."""

    rotation = calibration.rotation_degrees
    if rotation == 90:
        normalized = np.rot90(frame, k=1)
    elif rotation == 180:
        normalized = np.rot90(frame, k=2)
    elif rotation == 270:
        normalized = np.rot90(frame, k=3)
    else:
        normalized = frame

    target = (calibration.inference_width, calibration.inference_height)
    if normalized.shape[1] != target[0] or normalized.shape[0] != target[1]:
        if cv2 is not None:
            normalized = cv2.resize(normalized, target, interpolation=cv2.INTER_AREA)
        else:
            normalized = np.asarray(
                Image.fromarray(normalized).resize(target, Image.Resampling.BOX)
            )
    return np.ascontiguousarray(normalized)


def metric_focal_scale(
    calibration: CameraCalibration,
    processed_width: int,
    processed_height: int,
    reference_focal_px: float = 300.0,
) -> float:
    """Return DA3Metric's canonical-depth to metric-depth multiplier.

    DA3Metric is trained against a 300 px reference focal length.  Its input
    processor resizes K along with the image, so using the actual processed
    dimensions makes the result invariant to ``process_res``.
    """

    if reference_focal_px <= 0:
        raise ValueError("reference_focal_px must be positive")
    scale_x = max(int(processed_width), 1) / calibration.display_width
    scale_y = max(int(processed_height), 1) / calibration.display_height
    processed_focal = 0.5 * (
        calibration.fx * scale_x + calibration.fy * scale_y
    )
    return processed_focal / reference_focal_px
