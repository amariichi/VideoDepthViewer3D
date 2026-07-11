from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from backend.utils.frame_info import FrameInfo
from backend.video.io import FrameDecoder


def test_frame_decoder_reads_generated_cfr_media(fast_media_dir: Path) -> None:
    path = fast_media_dir / "cfr_h264_320x180_30_audio.mp4"
    decoder = FrameDecoder(path)
    try:
        metadata = decoder.metadata()
        first, first_info = decoder.decode_at(0.0)
        later, later_info = decoder.decode_at(500.0)
    finally:
        decoder.close()

    assert (metadata.width, metadata.height) == (320, 180)
    assert metadata.fps == 30.0
    assert metadata.duration_ms is not None
    assert abs(metadata.duration_ms - 2000.0) <= 100.0
    assert first.shape == later.shape == (180, 320, 3)
    assert first.dtype == later.dtype == np.uint8
    assert first_info.time_ms <= 34.0
    assert 500.0 <= later_info.time_ms <= 534.0


def test_frame_decoder_handles_generated_vfr_pts(fast_media_dir: Path) -> None:
    path = fast_media_dir / "vfr_h264_640x360_bframes.mp4"
    decoder = FrameDecoder(path)
    try:
        _, before = decoder.decode_at(950.0)
        _, after = decoder.decode_at(1050.0)
    finally:
        decoder.close()

    assert 950.0 <= before.time_ms <= 1000.0
    assert 1050.0 <= after.time_ms <= 1100.0
    assert after.time_ms > before.time_ms


def test_decoder_does_not_skip_ntsc_frame_for_float_rounding() -> None:
    class FakeFrame:
        def __init__(self, time_ms: float, index: int) -> None:
            self.time = time_ms / 1000
            self.index = index
            self.pts = index
            self.key_frame = index == 0

        def to_ndarray(self, *, format: str) -> np.ndarray:
            assert format == "rgb24"
            return np.full((1, 1, 3), self.index, dtype=np.uint8)

    decoder = object.__new__(FrameDecoder)
    decoder._frame_iter = iter(
        [
            FakeFrame(0.0, 0),
            FakeFrame(33.366666, 1),
            FakeFrame(66.733333, 2),
        ]
    )
    decoder._last_frame_time_ms = None

    frame, info = decoder._advance_to(33.3667)

    assert info == FrameInfo(
        time_ms=33.366666,
        index=1,
        pts=1,
        key_frame=False,
    )
    assert int(frame[0, 0, 0]) == 1


def test_generated_manifest_contains_rotation_and_anamorphic_metadata(
    fast_media_dir: Path,
) -> None:
    manifest = json.loads((fast_media_dir / "manifest.json").read_text())
    cases = {case["name"]: case for case in manifest["cases"]}

    assert (
        cases["anamorphic_h264_720x480_30"]["probed"]["sample_aspect_ratio"]
        == "32:27"
    )
    assert (
        cases["anamorphic_h264_720x480_30"]["probed"]["display_aspect_ratio"]
        == "16:9"
    )
    assert cases["rotated_h264_640x360_30"]["probed"]["rotation_degrees"] == 90


def test_decoder_reports_square_pixel_display_geometry(fast_media_dir: Path) -> None:
    anamorphic = FrameDecoder(
        fast_media_dir / "anamorphic_h264_720x480_30.mp4"
    )
    rotated = FrameDecoder(fast_media_dir / "rotated_h264_640x360_30.mp4")
    try:
        anamorphic_metadata = anamorphic.metadata()
        rotated_metadata = rotated.metadata()
    finally:
        anamorphic.close()
        rotated.close()

    assert anamorphic_metadata.pixel_aspect_ratio == 32 / 27
    assert (anamorphic_metadata.display_width, anamorphic_metadata.display_height) == (
        853,
        480,
    )
    assert (
        anamorphic_metadata.inference_width,
        anamorphic_metadata.inference_height,
    ) == (720, 405)
    assert abs(anamorphic_metadata.aspect - 16 / 9) < 0.002

    assert rotated_metadata.rotation_degrees == 90
    assert (rotated_metadata.display_width, rotated_metadata.display_height) == (
        360,
        640,
    )
    assert (rotated_metadata.inference_width, rotated_metadata.inference_height) == (
        360,
        640,
    )
