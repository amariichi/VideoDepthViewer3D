"""Build a browser-compatible display copy without changing depth timing."""

from __future__ import annotations

import logging
import threading
from fractions import Fraction
from pathlib import Path

import av

from backend.utils.calibration import CameraCalibration, normalize_frame_for_display

logger = logging.getLogger(__name__)

_OUTPUT_TIME_BASE = Fraction(1, 90_000)


class BrowserVideoPreparationCancelled(RuntimeError):
    """Raised when a session is replaced while its display copy is encoding."""


class BrowserVideoPreparationError(RuntimeError):
    """Raised when no bundled H.264 encoder can create a display copy."""


def _even_dimension(value: int) -> int:
    value = max(int(value), 2)
    return value if value % 2 == 0 else value + 1


def _encoder_candidates() -> list[tuple[str, dict[str, str]]]:
    candidates: list[tuple[str, dict[str, str]]] = []
    if "h264_nvenc" in av.codecs_available:
        candidates.append(
            (
                "h264_nvenc",
                {
                    "preset": "p4",
                    "rc": "vbr",
                    "cq": "19",
                },
            )
        )
    if "libx264" in av.codecs_available:
        candidates.append(
            (
                "libx264",
                {
                    "preset": "veryfast",
                    "crf": "18",
                },
            )
        )
    elif "h264" in av.codecs_available:
        candidates.append(
            (
                "h264",
                {
                    "preset": "veryfast",
                    "crf": "18",
                },
            )
        )
    return candidates


def _transcode_attempt(
    source: Path,
    target: Path,
    calibration: CameraCalibration,
    cancel: threading.Event,
    encoder_name: str,
    encoder_options: dict[str, str],
) -> None:
    """Decode once and encode normalized square-pixel frames as H.264."""

    target.unlink(missing_ok=True)
    with av.open(str(source)) as input_container:
        input_stream = input_container.streams.video[0]
        average_rate = input_stream.average_rate or Fraction(30, 1)
        with av.open(
            str(target),
            mode="w",
            format="mp4",
            options={"movflags": "+faststart"},
        ) as output_container:
            output_stream = output_container.add_stream(
                encoder_name,
                rate=average_rate,
                time_base=_OUTPUT_TIME_BASE,
                options=encoder_options,
            )
            output_stream.width = _even_dimension(calibration.inference_width)
            output_stream.height = _even_dimension(calibration.inference_height)
            output_stream.pix_fmt = "yuv420p"

            first_time: Fraction | None = None
            last_pts = -1
            frame_count = 0
            for source_frame in input_container.decode(input_stream):
                if cancel.is_set():
                    raise BrowserVideoPreparationCancelled

                if source_frame.pts is not None and source_frame.time_base is not None:
                    source_time = Fraction(source_frame.pts) * source_frame.time_base
                else:
                    source_time = Fraction(frame_count, 1) / average_rate
                if first_time is None:
                    first_time = source_time
                relative_time = max(source_time - first_time, Fraction(0, 1))
                output_pts = round(relative_time / _OUTPUT_TIME_BASE)
                if output_pts <= last_pts:
                    output_pts = last_pts + 1

                rgb = source_frame.to_ndarray(format="rgb24")
                normalized = normalize_frame_for_display(rgb, calibration)
                output_frame = av.VideoFrame.from_ndarray(normalized, format="rgb24")
                output_frame.pts = output_pts
                output_frame.time_base = _OUTPUT_TIME_BASE
                for packet in output_stream.encode(output_frame):
                    output_container.mux(packet)
                last_pts = output_pts
                frame_count += 1

            if frame_count == 0:
                raise BrowserVideoPreparationError("The source has no decodable video frames.")
            if cancel.is_set():
                raise BrowserVideoPreparationCancelled
            for packet in output_stream.encode(None):
                output_container.mux(packet)


def transcode_browser_video(
    source: Path,
    target: Path,
    calibration: CameraCalibration,
    cancel: threading.Event,
) -> Path:
    """Create an atomically published H.264 MP4 using bundled PyAV codecs.

    Hardware H.264 encoding is attempted when the PyAV build exposes it. A
    software libx264 pass is the portable fallback. Each attempt starts from
    the original source so a partially initialized hardware encoder cannot
    corrupt the final file.
    """

    if target.is_file() and target.stat().st_size > 0:
        return target
    candidates = _encoder_candidates()
    if not candidates:
        raise BrowserVideoPreparationError(
            "This PyAV build has no browser-compatible H.264 encoder."
        )

    errors: list[str] = []
    for index, (encoder_name, options) in enumerate(candidates):
        attempt = target.with_name(f"browser-video-{index}.part.mp4")
        try:
            _transcode_attempt(
                source,
                attempt,
                calibration,
                cancel,
                encoder_name,
                options,
            )
            if cancel.is_set():
                raise BrowserVideoPreparationCancelled
            attempt.replace(target)
            logger.info("Prepared browser video with %s", encoder_name)
            return target
        except BrowserVideoPreparationCancelled:
            attempt.unlink(missing_ok=True)
            raise
        except Exception as exc:  # encoder availability is runtime-dependent
            attempt.unlink(missing_ok=True)
            errors.append(f"{encoder_name}: {exc}")
            logger.warning("Browser-video encoder %s failed: %s", encoder_name, exc)

    raise BrowserVideoPreparationError(
        "Could not prepare a browser-compatible H.264 copy (" + "; ".join(errors) + ")"
    )
