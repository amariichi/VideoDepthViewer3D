"""Session state for a streamed MP4 upload."""

from __future__ import annotations

import asyncio
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Deque, Optional

import numpy as np
import logging
from fastapi import UploadFile

from backend.config import get_settings
from backend.video.io import DecoderPool, FrameDecoder, VideoMetadata


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
    depth_buffer: Deque[DepthFrame] = field(init=False)
    last_depth_time_ms: float | None = None
    telemetry: dict[str, float] = field(default_factory=dict, init=False)
    rolling_stats: dict[str, float] = field(default_factory=lambda: {
        "depth_fps": 0.0,
        "latency_ms": 0.0,
        "infer_avg_s": 0.0,
        "queue_avg_s": 0.0,
        "ws_send_avg_s": 0.0,
        "drop_count": 0.0,
    }, init=False)
    _buffer_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False, init=False)

    _quality_cooldown: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        settings = get_settings()
        self.depth_buffer = deque(maxlen=settings.video_cache_size)
        self._quality_cooldown = 0

    async def store_depth_frame(self, frame: DepthFrame) -> None:
        async with self._buffer_lock:
            self.depth_buffer.append(frame)
            self.last_depth_time_ms = frame.timestamp_ms

    async def update_telemetry(self, metrics: dict[str, float]) -> None:
        async with self._buffer_lock:
            self.telemetry.update(metrics)
            
            # Update rolling stats with EMA (alpha=0.1)
            alpha = 0.1
            for key, val in metrics.items():
                if key == "dropped":
                    self.rolling_stats["drop_count"] += val
                elif key in ["infer_s", "queue_wait_s", "ws_send_s", "decode_s"]:
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
                elif key in ["latency_ms", "depth_fps"]:
                    current = self.rolling_stats.get(key, 0.0)
                    if current == 0.0:
                        self.rolling_stats[key] = val
                    else:
                        self.rolling_stats[key] = alpha * val + (1 - alpha) * current
            
            # Calculate FPS if total_s is present
            if "total_s" in metrics and metrics["total_s"] > 0:
                fps_sample = 1.0 / metrics["total_s"]
                current_fps = self.rolling_stats.get("depth_fps", 0.0)
                if current_fps == 0.0:
                    self.rolling_stats["depth_fps"] = fps_sample
                else:
                    self.rolling_stats["depth_fps"] = alpha * fps_sample + (1 - alpha) * current_fps

            # Periodically adjust quality
            self.adjust_quality()

    def adjust_quality(self) -> None:
        """
        Dynamically adjust process resolution based on inference time.
        Target: infer_avg_s < 0.1s (10 FPS)
        """
        # Cooldown check (e.g., wait 30 frames between adjustments)
        if self._quality_cooldown > 0:
            self._quality_cooldown -= 1
            return

        infer_avg = self.rolling_stats.get("infer_avg_s", 0.0)
        queue_avg = self.rolling_stats.get("queue_avg_s", 0.0)
        latency_ms = self.rolling_stats.get("latency_ms", 0.0)
        settings = get_settings()
        
        # Initialize if not present
        if "quality_process_res" not in self.telemetry:
             self.telemetry["quality_process_res"] = float(settings.depth_process_res)

        current_res = int(self.telemetry["quality_process_res"])
        
        # Available steps for resolution
        all_steps = [960, 720, 640, 512, 480, 384, 320]
        
        # Clamp max resolution
        max_res = int(settings.depth_process_res)
        steps = [s for s in all_steps if s <= max_res]
        
        if not steps:
            steps = [max_res]
            
        # Find closest step
        closest_step = min(steps, key=lambda x: abs(x - current_res))
        current_idx = steps.index(closest_step)

        # Thresholds
        UP_THRESHOLD = 0.20  # Infer > 200ms
        DOWN_THRESHOLD = 0.08 # Infer < 80ms
        
        QUEUE_UP_THRESHOLD = 0.30 # Queue > 300ms
        QUEUE_DOWN_THRESHOLD = 0.10 # Queue < 100ms
        
        # Latency (RTT) Thresholds for Network Congestion
        # If RTT > 500ms, we are likely sending too much data.
        LATENCY_UP_THRESHOLD = 500.0 
        LATENCY_DOWN_THRESHOLD = 200.0
        
        new_idx = current_idx
        
        # Logic: Reduce quality if ANY metric is bad
        if (infer_avg > UP_THRESHOLD or 
            queue_avg > QUEUE_UP_THRESHOLD or 
            latency_ms > LATENCY_UP_THRESHOLD):
            
            # Reduce resolution (increase index)
            if current_idx < len(steps) - 1:
                new_idx = current_idx + 1
                
        # Logic: Increase quality ONLY if ALL metrics are good
        elif (infer_avg < DOWN_THRESHOLD and 
              queue_avg < QUEUE_DOWN_THRESHOLD and 
              latency_ms < LATENCY_DOWN_THRESHOLD):
              
            # Increase resolution (decrease index)
            if current_idx > 0:
                new_idx = current_idx - 1
                
        new_res = steps[new_idx]
        
        if new_res != current_res:
            self.telemetry["quality_process_res"] = float(new_res)
            self._quality_cooldown = 60
            # print(f"Adjusting quality: {current_res} -> {new_res} (infer={infer_avg:.3f}s, rtt={latency_ms:.0f}ms)")

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

    async def buffer_snapshot(self) -> dict[str, Optional[float | int | dict[str, float]]]:
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


class SessionManager:
    """Tracks active sessions and temporary files."""

    def __init__(self) -> None:
        self.settings = get_settings()
        self._sessions: dict[str, VideoSession] = {}
        self._lock = asyncio.Lock()

    async def create_session(self, upload: UploadFile) -> VideoSession:
        await self.clear_cache()
        data_root = self.settings.data_root
        data_root.mkdir(parents=True, exist_ok=True)
        session_id = uuid.uuid4().hex
        session_dir = data_root / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        target = session_dir / "source.mp4"
        with target.open("wb") as dst:
            while chunk := await upload.read(1024 * 1024):
                dst.write(chunk)
        
        # Use DecoderPool with 16 workers to match MAX_CONCURRENT_TASKS
        # This prevents decoder starvation where tasks wait for a free decoder.
        decoder = DecoderPool(target, count=16)
        metadata = decoder.metadata()
        session = VideoSession(
            session_id=session_id,
            source_path=target,
            metadata=metadata,
            decoder=decoder,
        )
        async with self._lock:
            self._sessions[session_id] = session
        return session

    async def delete_session(self, session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            session.decoder.close()
            if session.source_path.exists():
                session.source_path.unlink()
            session_dir = session.source_path.parent
            if session_dir.exists():
                for child in session_dir.iterdir():
                    child.unlink(missing_ok=True)
                session_dir.rmdir()

    async def get(self, session_id: str) -> Optional[VideoSession]:
        async with self._lock:
            return self._sessions.get(session_id)

    async def clear_cache(self) -> None:
        data_root = self.settings.data_root
        default_root = Path("tmp/sessions").resolve()
        data_root_resolved = data_root.resolve()
        if data_root_resolved != default_root and not self.settings.clear_cache_override:
            logging.getLogger(__name__).warning(
                "Skipping cache cleanup for data_root=%s (set VIDEO_DEPTH_CLEAR_CACHE=1 to override).",
                data_root_resolved,
            )
            return

        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()

        for session in sessions:
            session.decoder.close()
            if session.source_path.exists():
                session.source_path.unlink()
            session_dir = session.source_path.parent
            if session_dir.exists():
                for child in session_dir.iterdir():
                    child.unlink(missing_ok=True)
                session_dir.rmdir()

        if data_root.exists():
            for child in data_root.iterdir():
                if child.is_dir():
                    for sub in child.iterdir():
                        sub.unlink(missing_ok=True)
                    child.rmdir()
                else:
                    child.unlink(missing_ok=True)


def get_session_manager() -> SessionManager:
    if not hasattr(get_session_manager, "_instance"):
        setattr(get_session_manager, "_instance", SessionManager())
    return getattr(get_session_manager, "_instance")
