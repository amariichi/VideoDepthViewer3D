from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from backend.utils.calibration import (
    build_fallback_calibration,
    metric_focal_scale,
    normalize_frame_for_display,
    expanded_square_pixel_dimensions,
    square_pixel_dimensions,
)


def test_square_pixel_dimensions_preserve_display_aspect_without_upscaling() -> None:
    assert square_pixel_dimensions(720, 480, 32 / 27) == (720, 405)
    assert square_pixel_dimensions(480, 720, 27 / 32) == (405, 720)
    assert expanded_square_pixel_dimensions(720, 480, 32 / 27) == (853, 480)
    assert expanded_square_pixel_dimensions(480, 720, 27 / 32) == (480, 853)


def test_display_normalization_matches_counter_clockwise_display_matrix() -> None:
    frame = np.array(
        [
            [[1, 0, 0], [2, 0, 0], [3, 0, 0]],
            [[4, 0, 0], [5, 0, 0], [6, 0, 0]],
        ],
        dtype=np.uint8,
    )
    calibration = build_fallback_calibration(
        source_width=3,
        source_height=2,
        rotation_degrees=90,
    )

    normalized = normalize_frame_for_display(frame, calibration)

    assert normalized.shape == (3, 2, 3)
    np.testing.assert_array_equal(normalized[:, :, 0], [[3, 6], [2, 5], [1, 4]])
    assert normalized.flags.c_contiguous


def test_metric_focal_scale_tracks_processed_resolution() -> None:
    calibration = build_fallback_calibration(
        source_width=640,
        source_height=360,
        fov_y_degrees=50,
    )

    scale_640 = metric_focal_scale(calibration, 640, 360)
    scale_320 = metric_focal_scale(calibration, 320, 180)

    assert scale_320 == scale_640 / 2
    # A canonical prediction scales inversely with processed focal length.
    assert (2.0 / scale_640) * scale_640 == (2.0 / scale_320) * scale_320


def test_depth_model_metric_output_is_process_resolution_invariant() -> None:
    pytest.importorskip("torch")
    pytest.importorskip("cv2")
    from backend.models.depth_model import DepthModel

    calibration = build_fallback_calibration(
        source_width=640,
        source_height=360,
        fov_y_degrees=50,
    )

    class CanonicalMetricModel:
        def inference(self, _images, *, process_res: int, **_kwargs):
            width = process_res
            height = round(process_res * 360 / 640)
            focal_scale = metric_focal_scale(calibration, width, height)
            raw_depth = np.full((1, height, width), 2.5 / focal_scale, np.float32)
            return SimpleNamespace(depth=raw_depth, is_metric=0)

    model = DepthModel(model_id="depth-anything/DA3METRIC-LARGE", device="cpu")
    model._model = CanonicalMetricModel()  # type: ignore[assignment]
    frame = np.zeros((360, 640, 3), dtype=np.uint8)

    low = model.infer_depth(
        frame,
        process_res=320,
        target_size=(64, 36),
        calibration=calibration,
    )
    high = model.infer_depth(
        frame,
        process_res=640,
        target_size=(64, 36),
        calibration=calibration,
    )

    np.testing.assert_allclose(low.depth, 2.5, rtol=1e-6)
    np.testing.assert_allclose(high.depth, 2.5, rtol=1e-6)
    np.testing.assert_allclose(low.depth, high.depth, rtol=1e-6)
    assert low.metric_scale * 2 == high.metric_scale
    assert low.calibration is calibration
