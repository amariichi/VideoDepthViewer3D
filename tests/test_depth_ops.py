from __future__ import annotations

from backend.utils.depth_ops import calculate_depth_target_size


def test_transport_size_never_exceeds_inference_detail() -> None:
    assert calculate_depth_target_size(3840, 2160, 640, 1) == (640, 360)
    assert calculate_depth_target_size(3840, 2160, 640, 2) == (320, 180)
    assert calculate_depth_target_size(3840, 2160, 480, 4) == (120, 68)


def test_transport_size_honors_downsampling_for_small_sources() -> None:
    assert calculate_depth_target_size(320, 180, 640, 2) == (160, 90)
    assert calculate_depth_target_size(320, 180, 640, 1) == (320, 180)
