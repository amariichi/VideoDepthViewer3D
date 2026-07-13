"""Video decoding helpers built on top of PyAV."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

import av
import numpy as np

from backend.utils.frame_info import FrameInfo, frame_info_from_av
from backend.utils.calibration import (
    expanded_square_pixel_dimensions,
    normalize_rotation_degrees,
    square_pixel_dimensions,
)


class EndOfStreamError(Exception):
    """Raised when the decoder reaches EOF for a requested timestamp."""


def _is_av_eof(exc: Exception) -> bool:
    av_error_mod = getattr(av, "error", None)
    eof_types = tuple(
        cls
        for cls in (
            getattr(av, "EOFError", None),
            getattr(av_error_mod, "EOFError", None),
        )
        if isinstance(cls, type)
    )
    return isinstance(exc, eof_types) if eof_types else False


@dataclass(frozen=True)
class VideoMetadata:
    width: int
    height: int
    frames: Optional[int]
    fps: float
    duration_ms: Optional[float]
    sample_aspect_ratio_numerator: int
    sample_aspect_ratio_denominator: int
    rotation_degrees: int
    display_width: int
    display_height: int
    inference_width: int
    inference_height: int

    @property
    def aspect(self) -> float:
        return self.display_width / self.display_height if self.display_height else 1.0

    @property
    def pixel_aspect_ratio(self) -> float:
        denominator = self.sample_aspect_ratio_denominator or 1
        return self.sample_aspect_ratio_numerator / denominator


class FrameDecoder:
    """Thin wrapper around PyAV for timestamp-based decoding."""

    SEEK_PAD_MS = 0.0
    STREAM_WINDOW_MS = 1000.0
    MAX_SCAN_FRAMES = 360
    TIMESTAMP_EPSILON_MS = 1.0

    def __init__(self, source: Path) -> None:
        self.source = source
        self._container = av.open(str(source))
        self._stream = self._container.streams.video[0]
        # Frame + slice threading improves high-resolution software decode.
        # DecoderPool concurrency is bounded separately to avoid oversubscription.
        self._stream.thread_type = "AUTO"
        self._frame_iter: Optional[Iterator] = None
        self._last_frame_time_ms: Optional[float] = None
        self._rotation_degrees: Optional[int] = None

    def metadata(self) -> VideoMetadata:
        stream = self._stream
        fps = float(stream.average_rate) if stream.average_rate else 30.0
        duration_ms = float(stream.duration * stream.time_base * 1000) if stream.duration else None
        sar = stream.sample_aspect_ratio
        sar_numerator = int(sar.numerator) if sar and sar.numerator else 1
        sar_denominator = int(sar.denominator) if sar and sar.denominator else 1
        rotation = self._probe_rotation()
        if rotation in (90, 270):
            rotated_width, rotated_height = stream.height, stream.width
            display_sar = sar_denominator / sar_numerator
        else:
            rotated_width, rotated_height = stream.width, stream.height
            display_sar = sar_numerator / sar_denominator
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
        return VideoMetadata(
            width=stream.width,
            height=stream.height,
            frames=stream.frames or None,
            fps=fps,
            duration_ms=duration_ms,
            sample_aspect_ratio_numerator=sar_numerator,
            sample_aspect_ratio_denominator=sar_denominator,
            rotation_degrees=rotation,
            display_width=display_width,
            display_height=display_height,
            inference_width=inference_width,
            inference_height=inference_height,
        )

    def _probe_rotation(self) -> int:
        if self._rotation_degrees is not None:
            return self._rotation_degrees
        rotation = 0
        try:
            with av.open(str(self.source)) as container:
                stream = container.streams.video[0]
                frame = next(container.decode(stream))
                rotation = normalize_rotation_degrees(getattr(frame, "rotation", 0))
        except (StopIteration, OSError, av.error.FFmpegError):
            rotation = 0
        self._rotation_degrees = rotation
        return rotation

    def decode_at(self, time_ms: float) -> tuple[np.ndarray, FrameInfo]:
        """Decode the frame nearest to the requested timestamp (ms).

        The decoder defaults to forward streaming: if the caller requests a
        timestamp slightly ahead of the last frame we returned, we simply advance
        the existing decode iterator. When the caller jumps far ahead or backwards
        we fall back to a guarded seek toward the preceding keyframe, then resume
        forward decoding until we reach (or slightly surpass) the target time.
        """

        time_ms = max(time_ms, 0.0)
        if not self._should_stream_forward(time_ms):
            self._seek_near(time_ms)
        frame, info = self._advance_to(time_ms)
        return frame, info

    def iter_frames(self) -> Iterator[np.ndarray]:
        for packet in self._container.demux(self._stream):
            for frame in packet.decode():
                yield frame.to_ndarray(format="rgb24")

    def close(self) -> None:
        self._container.close()

    def __del__(self) -> None:  # pragma: no cover - destructor best-effort
        try:
            self.close()
        except Exception:  # noqa: BLE001
            pass

    def _reset_iterator(self) -> None:
        self._frame_iter = self._container.decode(self._stream)

    def should_stream_forward(self, time_ms: float) -> bool:
        if self._last_frame_time_ms is None:
            return False
        delta = time_ms - self._last_frame_time_ms
        return 0.0 <= delta <= self.STREAM_WINDOW_MS

    def _should_stream_forward(self, time_ms: float) -> bool:
        return self.should_stream_forward(time_ms)

    def _seek_near(self, time_ms: float) -> None:
        # Seek exactly to the target time with backward=True.
        # This finds the closest keyframe <= time_ms.
        seek_ts = time_ms / 1000.0
        time_base = float(self._stream.time_base)
        target_pts = int(seek_ts / time_base)
        self._container.seek(target_pts, stream=self._stream, any_frame=False, backward=True)
        self._reset_iterator()
        self._last_frame_time_ms = None

    def _advance_to(self, time_ms: float) -> tuple[np.ndarray, FrameInfo]:
        if self._frame_iter is None:
            self._reset_iterator()
        assert self._frame_iter is not None
        frames_examined = 0
        while True:
            try:
                frame = next(self._frame_iter)
            except StopIteration as exc:  # pragma: no cover - EOF
                self._frame_iter = None
                raise EndOfStreamError from exc
            except Exception as exc:  # pragma: no cover - decoder EOF varies by PyAV build
                if _is_av_eof(exc):
                    self._frame_iter = None
                    raise EndOfStreamError from exc
                raise
            info = frame_info_from_av(frame)
            frames_examined += 1
            actual_time = info.time_ms if info.time_ms >= 0 else time_ms
            self._last_frame_time_ms = actual_time
            if (
                info.time_ms < 0
                or actual_time + self.TIMESTAMP_EPSILON_MS >= time_ms
                or frames_examined >= self.MAX_SCAN_FRAMES
            ):
                return frame.to_ndarray(format="rgb24"), info


class DecoderPool:
    """Manages a pool of FrameDecoders for parallel random access with locality awareness."""

    def __init__(self, source: Path, count: int = 4) -> None:
        self.source = source
        self.count = count
        self._decoders = [FrameDecoder(source) for _ in range(count)]
        self._free_decoders = list(self._decoders)
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._closed = False

    def metadata(self) -> VideoMetadata:
        # Just peek at one decoder
        with self._cond:
            while not self._free_decoders and not self._closed:
                self._cond.wait()
            if self._closed:
                raise RuntimeError("decoder pool is closed")
            decoder = self._free_decoders.pop()
        
        try:
            return decoder.metadata()
        finally:
            with self._cond:
                if decoder in self._decoders:
                    self._free_decoders.append(decoder)
                self._cond.notify_all()

    def decode_at(self, time_ms: float) -> tuple[np.ndarray, FrameInfo]:
        # Block until a decoder is available
        with self._cond:
            while not self._free_decoders and not self._closed:
                self._cond.wait()
            if self._closed:
                raise RuntimeError("decoder pool is closed")
            
            # Smart Scheduling: Find a decoder that is close to the target time
            # to avoid expensive seeking.
            best_decoder = None
            for d in self._free_decoders:
                if d.should_stream_forward(time_ms):
                    best_decoder = d
                    break
            
            # If no suitable decoder found, pick the most recently used one (LIFO)
            # to keep "hot" decoders active, or just any.
            if best_decoder is None:
                best_decoder = self._free_decoders.pop() # Pop from end (LIFO)
            else:
                self._free_decoders.remove(best_decoder)

        try:
            return best_decoder.decode_at(time_ms)
        finally:
            with self._cond:
                if best_decoder in self._decoders:
                    self._free_decoders.append(best_decoder)
                self._cond.notify_all()

    def close(self) -> None:
        # PyAV containers must never be closed while another thread is inside
        # av_read_frame. Session replacement can race with asyncio.to_thread()
        # decodes, so reject new checkouts and wait for every borrowed decoder
        # to return before closing its container.
        with self._cond:
            if self._closed:
                return
            self._closed = True
            self._cond.notify_all()
            while len(self._free_decoders) < len(self._decoders):
                self._cond.wait()
            decoders = tuple(self._decoders)
            self._decoders.clear()
            self._free_decoders.clear()
        for decoder in decoders:
            try:
                decoder.close()
            except Exception:
                pass
