"""Utilities for inspecting PyAV frames."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class FrameInfo:
    time_ms: float
    index: int
    pts: int | None
    key_frame: bool


def frame_info_from_av(frame) -> FrameInfo:
    time_ms = float(frame.time) * 1000 if frame.time is not None else -1.0
    return FrameInfo(
        time_ms=time_ms,
        index=getattr(frame, 'index', -1),
        pts=frame.pts,
        key_frame=bool(frame.key_frame),
    )
