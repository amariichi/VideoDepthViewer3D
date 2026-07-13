"""Session state for a streamed MP4 upload."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import re
import shutil
import threading
import time
import uuid
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Deque, Optional

import numpy as np
from fastapi import UploadFile

from backend.config import get_settings
from backend.utils.adaptive_quality import (
    AdaptiveQualityController,
    QualityMetrics,
    normalize_depth_encoding,
    normalize_performance_mode,
)
from backend.utils.calibration import CameraCalibration, build_fallback_calibration
from backend.utils.depth_range import StableDepthRange
from backend.video.browser_compat import (
    BrowserVideoPreparationCancelled,
    transcode_browser_video,
)
from backend.video.io import DecoderPool, VideoMetadata
from backend.video.playback import PlaybackChannel


@dataclass
class DepthFrame:
    timestamp_ms: float
    depth: np.ndarray
    z_min: float
    z_max: float


@dataclass
class VideoSession:
    session_id: str
    source_path: Path
    metadata: VideoMetadata
    decoder: DecoderPool  # Changed from FrameDecoder
    source_name: str = "video.mp4"
    media_type: str = "video/mp4"
    calibration: CameraCalibration = field(init=False)
    playback: PlaybackChannel = field(init=False, repr=False)
    browser_video_path: Path = field(init=False)
    quality_controller: AdaptiveQualityController = field(init=False, repr=False)
    depth_range: StableDepthRange = field(init=False, repr=False)
    depth_buffer: Deque[DepthFrame] = field(init=False)
    last_depth_time_ms: float | None = None
    telemetry: dict[str, float] = field(default_factory=dict, init=False)
    rolling_stats: dict[str, float] = field(default_factory=lambda: {
        "depth_fps": 0.0,
        "latency_ms": 0.0,
        "client_fps": 0.0,
        "infer_avg_s": 0.0,
        "infer_wait_avg_s": 0.0,
        "normalize_avg_s": 0.0,
        "pack_avg_s": 0.0,
        "queue_avg_s": 0.0,
        "ws_send_avg_s": 0.0,
        "decode_avg_s": 0.0,
        "payload_avg_bytes": 0.0,
        "drop_count": 0.0,
    }, init=False)
    _buffer_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False, init=False)
    _delivery_window_start_s: float | None = field(default=None, repr=False, init=False)
    _delivery_window_count: int = field(default=0, repr=False, init=False)
    _browser_video_lock: asyncio.Lock = field(
        default_factory=asyncio.Lock, repr=False, init=False
    )
    _browser_video_cancel: threading.Event = field(
        default_factory=threading.Event, repr=False, init=False
    )
    _browser_video_task: asyncio.Task[Path] | None = field(
        default=None, repr=False, init=False
    )
    _closed: bool = field(default=False, repr=False, init=False)

    def __post_init__(self) -> None:
        settings = get_settings()
        self.depth_buffer = deque(maxlen=settings.video_cache_size)
        self.playback = PlaybackChannel(self.metadata.duration_ms)
        self.browser_video_path = self.source_path.parent / "browser-video.mp4"
        self.calibration = build_fallback_calibration(
            source_width=self.metadata.width,
            source_height=self.metadata.height,
            sar_numerator=self.metadata.sample_aspect_ratio_numerator,
            sar_denominator=self.metadata.sample_aspect_ratio_denominator,
            rotation_degrees=self.metadata.rotation_degrees,
            fov_y_degrees=settings.source_fov_y,
        )
        self.depth_range = StableDepthRange()
        self.quality_controller = AdaptiveQualityController(
            mode=normalize_performance_mode(settings.optimization_mode),
            max_process_res=settings.depth_process_res,
            manual_downsample=settings.depth_downsample_factor,
            manual_encoding=normalize_depth_encoding(settings.depth_encoding),
            source_fps=self.metadata.fps,
        )

    async def store_depth_frame(self, frame: DepthFrame) -> None:
        async with self._buffer_lock:
            # Pipelines complete out of order. Keep the small cache ordered by
            # media time so cache eviction/drop-on-hit semantics remain valid,
            # and replace duplicate decoded PTS instead of wasting slots.
            maxlen = self.depth_buffer.maxlen
            frames = [
                cached
                for cached in self.depth_buffer
                if abs(cached.timestamp_ms - frame.timestamp_ms) >= 1.0
            ]
            frames.append(frame)
            frames.sort(key=lambda cached: cached.timestamp_ms)
            if maxlen is not None:
                frames = frames[-maxlen:]
            self.depth_buffer = deque(frames, maxlen=maxlen)
            self.last_depth_time_ms = self.depth_buffer[-1].timestamp_ms

    async def stabilize_depth_range(
        self,
        frame_min: float,
        frame_max: float,
    ) -> tuple[float, float]:
        async with self._buffer_lock:
            return self.depth_range.update(frame_min, frame_max)

    async def set_performance_mode(self, value: object) -> None:
        mode = normalize_performance_mode(value)
        async with self._buffer_lock:
            self.quality_controller.set_mode(mode)

    async def update_telemetry(
        self,
        metrics: dict[str, float],
        *,
        adjust_quality: bool = False,
    ) -> None:
        async with self._buffer_lock:
            self.telemetry.update(metrics)
            
            # Update rolling stats with EMA (alpha=0.1)
            alpha = 0.1
            for key, val in metrics.items():
                if key == "dropped":
                    self.rolling_stats["drop_count"] += val
                elif key in [
                    "infer_s",
                    "infer_wait_s",
                    "normalize_s",
                    "pack_s",
                    "queue_wait_s",
                    "ws_send_s",
                    "decode_s",
                ]:
                    if key == "queue_wait_s":
                        avg_key = "queue_avg_s"
                    elif key.endswith("_s"):
                        avg_key = key[:-2] + "_avg_s"
                    else:
                        avg_key = key
                    
                    current = self.rolling_stats.get(avg_key, 0.0)
                    if current == 0.0:
                        self.rolling_stats[avg_key] = val
                    else:
                        self.rolling_stats[avg_key] = alpha * val + (1 - alpha) * current
                elif key in ["latency_ms", "depth_fps", "client_fps"]:
                    current = self.rolling_stats.get(key, 0.0)
                    if current == 0.0:
                        self.rolling_stats[key] = val
                    else:
                        self.rolling_stats[key] = alpha * val + (1 - alpha) * current
                elif key == "payload_bytes":
                    current = self.rolling_stats["payload_avg_bytes"]
                    self.rolling_stats["payload_avg_bytes"] = (
                        val if current == 0.0 else alpha * val + (1 - alpha) * current
                    )
            
            # Delivery FPS is based on actual response spacing. Per-task
            # 1/total_s is not throughput when several pipelines overlap.
            if adjust_quality:
                now = time.perf_counter()
                if self._delivery_window_start_s is None:
                    self._delivery_window_start_s = now
                    self._delivery_window_count = 1
                else:
                    self._delivery_window_count += 1
                elapsed_s = now - self._delivery_window_start_s
                if elapsed_s >= 1.0:
                    fps_sample = self._delivery_window_count / elapsed_s
                    current_fps = self.rolling_stats.get("depth_fps", 0.0)
                    if current_fps == 0.0:
                        self.rolling_stats["depth_fps"] = fps_sample
                    else:
                        self.rolling_stats["depth_fps"] = (
                            alpha * fps_sample + (1 - alpha) * current_fps
                        )
                    self._delivery_window_start_s = now
                    self._delivery_window_count = 0

            if adjust_quality:
                self.adjust_quality()

    def adjust_quality(self) -> None:
        settings = get_settings()
        self.quality_controller.observe(
            QualityMetrics(
                infer_s=self.rolling_stats.get("infer_avg_s", 0.0),
                infer_wait_s=self.rolling_stats.get("infer_wait_avg_s", 0.0),
                decode_s=self.rolling_stats.get("decode_avg_s", 0.0),
                normalize_s=self.rolling_stats.get("normalize_avg_s", 0.0),
                pack_s=self.rolling_stats.get("pack_avg_s", 0.0),
                queue_s=self.rolling_stats.get("queue_avg_s", 0.0),
                send_s=self.rolling_stats.get("ws_send_avg_s", 0.0),
                latency_ms=self.rolling_stats.get("latency_ms", 0.0),
                applied_fps=self.rolling_stats.get("client_fps", 0.0),
                worker_count=settings.inference_worker_count,
            )
        )

    async def get_cached_depth(self, time_ms: float, tolerance_ms: float = 33.0, drop_on_hit: bool = False) -> Optional[DepthFrame]:
        async with self._buffer_lock:
            for idx in range(len(self.depth_buffer) - 1, -1, -1):
                cached = self.depth_buffer[idx]
                if abs(cached.timestamp_ms - time_ms) <= tolerance_ms:
                    if drop_on_hit:
                        # remove all entries up to idx inclusive to keep buffer fresh
                        for _ in range(idx + 1):
                            self.depth_buffer.popleft()
                    return cached
        return None

    async def buffer_snapshot(self) -> dict[str, object]:
        async with self._buffer_lock:
            size = len(self.depth_buffer)
            last = self.last_depth_time_ms
            telem = self.telemetry.copy()
            rolling = self.rolling_stats.copy()
        return {
            "buffer_length": size,
            "last_depth_time_ms": last,
            "telemetry": telem,
            "rolling_stats": rolling,
        }

    async def close(self) -> None:
        self._closed = True
        self._browser_video_cancel.set()
        browser_video_task = self._browser_video_task
        if browser_video_task is not None:
            with suppress(Exception, asyncio.CancelledError):
                await browser_video_task
        await self.playback.close()
        # DecoderPool.close waits for in-flight PyAV calls. Run that wait off
        # the event loop so control/session-ended messages can still drain.
        await asyncio.to_thread(self.decoder.close)

    async def prepare_browser_video(self) -> Path:
        """Prepare one shared H.264 display copy for browsers lacking the codec."""

        if self._closed:
            raise BrowserVideoPreparationCancelled
        if self.browser_video_path.is_file() and self.browser_video_path.stat().st_size > 0:
            return self.browser_video_path

        async with self._browser_video_lock:
            if self._closed:
                raise BrowserVideoPreparationCancelled
            if (
                self.browser_video_path.is_file()
                and self.browser_video_path.stat().st_size > 0
            ):
                return self.browser_video_path
            task = self._browser_video_task
            if task is None or task.done():
                self._browser_video_cancel.clear()
                task = asyncio.create_task(
                    asyncio.to_thread(
                        transcode_browser_video,
                        self.source_path,
                        self.browser_video_path,
                        self.calibration,
                        self._browser_video_cancel,
                    )
                )
                self._browser_video_task = task

        try:
            return await asyncio.shield(task)
        except Exception:
            async with self._browser_video_lock:
                if self._browser_video_task is task:
                    self._browser_video_task = None
            raise


class InvalidVideoError(ValueError):
    """Raised when uploaded bytes cannot be opened as a video."""


class SessionManager:
    """Tracks active sessions and temporary files."""

    def __init__(self) -> None:
        self.settings = get_settings()
        self._sessions: dict[str, VideoSession] = {}
        self._current_session_id: str | None = None
        self._lock = asyncio.Lock()

    async def create_session(self, upload: UploadFile) -> VideoSession:
        data_root = self.settings.data_root
        data_root.mkdir(parents=True, exist_ok=True)
        session_id = uuid.uuid4().hex
        session_dir = data_root / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        raw_name = (upload.filename or "video.mp4").replace("\\", "/")
        source_name = Path(raw_name).name or "video.mp4"
        suffix = Path(source_name).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
            suffix = ".mp4"
        target = session_dir / f"source{suffix}"
        guessed_type = mimetypes.guess_type(source_name)[0]
        media_type = (
            upload.content_type
            if upload.content_type and upload.content_type.startswith("video/")
            else guessed_type or "application/octet-stream"
        )
        decoder: DecoderPool | None = None
        try:
            with target.open("wb") as dst:
                while chunk := await upload.read(1024 * 1024):
                    dst.write(chunk)

            decoder = DecoderPool(target, count=self.settings.decoder_worker_count)
            metadata = decoder.metadata()
            session = VideoSession(
                session_id=session_id,
                source_path=target,
                metadata=metadata,
                decoder=decoder,
                source_name=source_name,
                media_type=media_type,
            )
        except asyncio.CancelledError:
            if decoder is not None:
                decoder.close()
            shutil.rmtree(session_dir, ignore_errors=True)
            raise
        except Exception as exc:
            if decoder is not None:
                decoder.close()
            shutil.rmtree(session_dir, ignore_errors=True)
            raise InvalidVideoError(
                "The selected file could not be decoded as a supported video."
            ) from exc
        # Publish only after the new upload has been fully written and probed.
        # This keeps the current video alive during a long phone upload and
        # preserves it when the replacement is invalid.
        async with self._lock:
            previous_sessions = tuple(self._sessions.values())
            self._sessions = {session_id: session}
            self._current_session_id = session_id
        for previous in previous_sessions:
            await self._dispose_session(previous)
        return session

    async def delete_session(self, session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
            if self._current_session_id == session_id:
                self._current_session_id = None
        if session:
            await self._dispose_session(session)

    async def get(self, session_id: str) -> Optional[VideoSession]:
        async with self._lock:
            return self._sessions.get(session_id)

    async def current(self) -> Optional[VideoSession]:
        async with self._lock:
            if self._current_session_id is None:
                return None
            return self._sessions.get(self._current_session_id)

    async def clear_cache(self) -> None:
        data_root = self.settings.data_root
        default_root = Path("tmp/sessions").resolve()
        data_root_resolved = data_root.resolve()
        can_sweep_root = (
            data_root_resolved == default_root or self.settings.clear_cache_override
        )
        if not can_sweep_root:
            logging.getLogger(__name__).warning(
                "Skipping untracked cache cleanup for data_root=%s "
                "(set VIDEO_DEPTH_CLEAR_CACHE=1 to override).",
                data_root_resolved,
            )

        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
            self._current_session_id = None

        for session in sessions:
            await self._dispose_session(session)

        if not can_sweep_root:
            return

        if data_root.exists():
            for child in data_root.iterdir():
                if child.is_dir():
                    for sub in child.iterdir():
                        sub.unlink(missing_ok=True)
                    child.rmdir()
                else:
                    child.unlink(missing_ok=True)

    @staticmethod
    async def _dispose_session(session: VideoSession) -> None:
        """Close one known session before removing its private UUID directory."""

        await session.close()
        session_dir = session.source_path.parent
        # Windows can briefly retain a FileResponse handle while a browser
        # abandons the old Range request. Session replacement must still
        # succeed; an undeleted private cache directory is safe to retry during
        # the next startup sweep.
        shutil.rmtree(session_dir, ignore_errors=True)


def get_session_manager() -> SessionManager:
    if not hasattr(get_session_manager, "_instance"):
        setattr(get_session_manager, "_instance", SessionManager())
    return getattr(get_session_manager, "_instance")
