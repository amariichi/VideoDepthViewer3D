from __future__ import annotations

import threading

import av
import pytest

from backend.utils.calibration import build_fallback_calibration
from backend.video.browser_compat import (
    BrowserVideoPreparationCancelled,
    transcode_browser_video,
)
from backend.video.io import FrameDecoder


def test_browser_copy_is_seekable_h264(fast_media_dir, tmp_path) -> None:
    source = fast_media_dir / "cfr_h264_320x180_30_audio.mp4"
    decoder = FrameDecoder(source)
    try:
        metadata = decoder.metadata()
    finally:
        decoder.close()
    calibration = build_fallback_calibration(
        source_width=metadata.width,
        source_height=metadata.height,
        sar_numerator=metadata.sample_aspect_ratio_numerator,
        sar_denominator=metadata.sample_aspect_ratio_denominator,
        rotation_degrees=metadata.rotation_degrees,
    )
    target = tmp_path / "browser-video.mp4"

    assert transcode_browser_video(
        source,
        target,
        calibration,
        threading.Event(),
    ) == target

    with av.open(str(target)) as container:
        stream = container.streams.video[0]
        assert stream.codec_context.codec.name == "h264"
        assert stream.width == 320
        assert stream.height == 180
        frames = list(container.decode(stream))
    assert len(frames) >= 30
    assert frames[0].time is not None
    assert abs(float(frames[0].time)) < 0.001
    assert frames[-1].time is not None
    assert float(frames[-1].time) > 0.9


def test_cancelled_browser_copy_is_not_published(fast_media_dir, tmp_path) -> None:
    source = fast_media_dir / "cfr_h264_320x180_30_audio.mp4"
    calibration = build_fallback_calibration(
        source_width=320,
        source_height=180,
    )
    cancel = threading.Event()
    cancel.set()
    target = tmp_path / "browser-video.mp4"

    with pytest.raises(BrowserVideoPreparationCancelled):
        transcode_browser_video(source, target, calibration, cancel)
    assert not target.exists()


@pytest.mark.parametrize(
    "source_name",
    [
        "rotated_h264_640x360_30.mp4",
        "anamorphic_h264_720x480_30.mp4",
    ],
)
def test_browser_copy_matches_depth_display_coordinates(
    fast_media_dir,
    tmp_path,
    source_name,
) -> None:
    source = fast_media_dir / source_name
    decoder = FrameDecoder(source)
    try:
        metadata = decoder.metadata()
    finally:
        decoder.close()
    calibration = build_fallback_calibration(
        source_width=metadata.width,
        source_height=metadata.height,
        sar_numerator=metadata.sample_aspect_ratio_numerator,
        sar_denominator=metadata.sample_aspect_ratio_denominator,
        rotation_degrees=metadata.rotation_degrees,
    )
    target = tmp_path / f"{source.stem}-browser.mp4"

    transcode_browser_video(source, target, calibration, threading.Event())

    with av.open(str(target)) as container:
        stream = container.streams.video[0]
        frame = next(container.decode(stream))
    expected_width = calibration.inference_width + calibration.inference_width % 2
    expected_height = calibration.inference_height + calibration.inference_height % 2
    assert (stream.width, stream.height) == (expected_width, expected_height)
    assert (frame.width, frame.height) == (expected_width, expected_height)


def test_browser_copy_preserves_vfr_timestamps(fast_media_dir, tmp_path) -> None:
    source = fast_media_dir / "vfr_h264_640x360_bframes.mp4"
    calibration = build_fallback_calibration(
        source_width=640,
        source_height=360,
    )
    target = tmp_path / "vfr-browser.mp4"

    transcode_browser_video(source, target, calibration, threading.Event())

    def frame_times(path):
        with av.open(str(path)) as container:
            frames = list(container.decode(container.streams.video[0]))
        times = [float(frame.time) for frame in frames if frame.time is not None]
        return [value - times[0] for value in times]

    source_times = frame_times(source)
    output_times = frame_times(target)
    assert len(output_times) == len(source_times)
    assert len({round(b - a, 3) for a, b in zip(source_times, source_times[1:])}) > 1
    assert output_times == pytest.approx(source_times, abs=0.002)
