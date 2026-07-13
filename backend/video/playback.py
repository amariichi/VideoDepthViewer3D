"""Session-scoped playback commands and authoritative viewer state."""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass
from typing import Any

from backend.utils.queues import DroppingQueue


PlaybackMessage = dict[str, object]


def _finite_time_ms(value: object, fallback: float) -> float:
    if isinstance(value, bool):
        return fallback
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def _bounded_label(value: object, fallback: str, limit: int = 80) -> str:
    if not isinstance(value, str):
        return fallback
    normalized = value.strip()
    return normalized[:limit] if normalized else fallback


@dataclass
class PlaybackState:
    """Latest playback state from a remote command or desktop confirmation."""

    current_time_ms: float = 0.0
    paused: bool = True
    revision: int = 0
    origin_client_id: str = "server"
    origin_role: str = "server"


class PlaybackChannel:
    """Broadcasts fresh playback events without creating another depth client."""

    def __init__(self, duration_ms: float | None) -> None:
        try:
            parsed_duration = float(duration_ms) if duration_ms is not None else None
        except (TypeError, ValueError):
            parsed_duration = None
        self._duration_ms = (
            parsed_duration
            if parsed_duration is not None and math.isfinite(parsed_duration)
            else None
        )
        self._state = PlaybackState()
        self._subscribers: set[DroppingQueue[PlaybackMessage]] = set()
        self._lock = asyncio.Lock()
        self._closed = False

    def _clamp_time(self, value: object) -> float:
        parsed = max(0.0, _finite_time_ms(value, self._state.current_time_ms))
        if self._duration_ms is not None:
            parsed = min(parsed, max(0.0, self._duration_ms))
        return parsed

    def _snapshot_unlocked(self) -> PlaybackMessage:
        return {
            "type": "state",
            "revision": self._state.revision,
            "current_time_ms": self._state.current_time_ms,
            "paused": self._state.paused,
            "origin_client_id": self._state.origin_client_id,
            "origin_role": self._state.origin_role,
            "server_time_ms": time.time() * 1000,
        }

    async def subscribe(self) -> DroppingQueue[PlaybackMessage]:
        queue: DroppingQueue[PlaybackMessage] = DroppingQueue(maxsize=16)
        async with self._lock:
            if self._closed:
                queue.put_nowait({"type": "session-ended"})
                return queue
            self._subscribers.add(queue)
            queue.put_nowait(self._snapshot_unlocked())
        return queue

    async def unsubscribe(self, queue: DroppingQueue[PlaybackMessage]) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    async def apply(self, payload: dict[str, Any]) -> PlaybackMessage:
        """Validate, persist, and broadcast a client command or viewer state."""

        message_type = payload.get("type")
        role = _bounded_label(payload.get("role"), "unknown", 16)
        client_id = _bounded_label(payload.get("client_id"), "anonymous")

        async with self._lock:
            if self._closed:
                raise ValueError("session has ended")

            if message_type == "command":
                action = payload.get("action")
                if action not in {"play", "pause", "seek"}:
                    raise ValueError("unsupported playback command")
                current_time_ms = self._clamp_time(payload.get("current_time_ms"))
                if action == "play":
                    paused = False
                elif action == "pause":
                    paused = True
                else:
                    paused = (
                        payload["paused"]
                        if isinstance(payload.get("paused"), bool)
                        else self._state.paused
                    )
            elif message_type == "state":
                if role != "viewer":
                    raise ValueError("only the desktop viewer may publish state")
                action = None
                current_time_ms = self._clamp_time(payload.get("current_time_ms"))
                paused = payload.get("paused")
                if not isinstance(paused, bool):
                    raise ValueError("viewer state must include paused")
            else:
                raise ValueError("unsupported playback message")

            self._state.current_time_ms = current_time_ms
            self._state.paused = paused
            self._state.revision += 1
            self._state.origin_client_id = client_id
            self._state.origin_role = role

            event: PlaybackMessage = {
                "type": message_type,
                "revision": self._state.revision,
                "current_time_ms": current_time_ms,
                "paused": paused,
                "origin_client_id": client_id,
                "origin_role": role,
                "server_time_ms": time.time() * 1000,
            }
            if action is not None:
                event["action"] = action
            subscribers = tuple(self._subscribers)

        for queue in subscribers:
            queue.put_nowait(event.copy())
        return event

    async def snapshot(self) -> PlaybackMessage:
        async with self._lock:
            return self._snapshot_unlocked()

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            self._state.revision += 1
            event: PlaybackMessage = {
                "type": "session-ended",
                "revision": self._state.revision,
            }
            subscribers = tuple(self._subscribers)
            self._subscribers.clear()
        for queue in subscribers:
            queue.put_nowait(event.copy())
