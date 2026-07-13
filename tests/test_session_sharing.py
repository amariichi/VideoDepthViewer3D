from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from starlette.responses import FileResponse

from backend.routers import session as session_router
from backend.video.playback import PlaybackChannel


class StubManager:
    def __init__(self, session=None) -> None:
        self.session = session
        self.settings = SimpleNamespace(
            inference_worker_count=1,
            decoder_worker_count=1,
        )

    async def current(self):
        return self.session

    async def get(self, session_id: str):
        if self.session and self.session.session_id == session_id:
            return self.session
        return None

    async def delete_session(self, session_id: str) -> None:
        if self.session and self.session.session_id == session_id:
            await self.session.playback.close()
            self.session = None


def stub_session(source_path):
    metadata = SimpleNamespace(
        width=320,
        height=180,
        display_width=320,
        display_height=180,
        inference_width=320,
        inference_height=180,
        sample_aspect_ratio_numerator=1,
        sample_aspect_ratio_denominator=1,
        rotation_degrees=0,
        fps=30.0,
        duration_ms=2_000.0,
    )
    quality = SimpleNamespace(
        mode="balanced",
        process_res=640,
        downsample_factor=2,
        encoding="log8",
        target_fps=30.0,
        limiting_stage="none",
    )

    async def buffer_snapshot():
        return {
            "buffer_length": 0,
            "last_depth_time_ms": None,
            "telemetry": {},
            "rolling_stats": {},
        }

    browser_video_path = source_path.parent / "browser-video.mp4"

    async def prepare_browser_video():
        browser_video_path.write_bytes(b"browser video")
        return browser_video_path

    return SimpleNamespace(
        session_id="shared-session",
        source_path=source_path,
        browser_video_path=browser_video_path,
        source_name="phone.mov",
        media_type="video/quicktime",
        metadata=metadata,
        calibration=SimpleNamespace(as_dict=lambda: {}),
        quality_controller=SimpleNamespace(state=quality),
        playback=PlaybackChannel(metadata.duration_ms),
        buffer_snapshot=buffer_snapshot,
        prepare_browser_video=prepare_browser_video,
    )


@pytest.mark.asyncio
async def test_current_session_and_range_video_delivery(tmp_path) -> None:
    source = tmp_path / "source.mov"
    source.write_bytes(b"0123456789")
    manager = StubManager()
    empty = await session_router.current_session(manager)
    assert isinstance(empty, Response)
    assert empty.status_code == 204

    manager.session = stub_session(source)
    current = await session_router.current_session(manager)
    assert current["session_id"] == "shared-session"
    assert current["source_name"] == "phone.mov"

    video = await session_router.session_video("shared-session", manager)
    assert isinstance(video, FileResponse)
    assert video.path == source
    assert video.media_type == "video/quicktime"
    assert video.headers["accept-ranges"] == "bytes"
    assert video.headers["cache-control"] == "private, no-store"
    assert video.headers["x-content-type-options"] == "nosniff"
    assert FileResponse._parse_range_header("bytes=2-5", 10) == [(2, 6)]

    with pytest.raises(HTTPException) as missing:
        await session_router.session_video("missing", manager)
    assert missing.value.status_code == 404

    prepared = await session_router.prepare_browser_video("shared-session", manager)
    assert prepared == {"status": "ready"}
    browser_video = await session_router.browser_video("shared-session", manager)
    assert isinstance(browser_video, FileResponse)
    assert browser_video.path == manager.session.browser_video_path
    assert browser_video.media_type == "video/mp4"
    assert browser_video.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_playback_channel_reconnects_and_closes_cleanly() -> None:
    channel = PlaybackChannel(duration_ms=1_000)
    first = await channel.subscribe()
    assert (await first.get())["revision"] == 0

    await channel.apply(
        {
            "type": "command",
            "action": "play",
            "current_time_ms": 250,
            "role": "remote",
            "client_id": "phone",
        }
    )
    assert (await first.get())["paused"] is False

    viewer_event = await channel.apply(
        {
            "type": "state",
            "current_time_ms": 9_000,
            "paused": False,
            "role": "viewer",
            "client_id": "desktop",
        }
    )
    assert viewer_event["current_time_ms"] == 1_000
    assert viewer_event["revision"] == 2
    assert (await first.get()) == viewer_event

    second = await channel.subscribe()
    snapshot = await second.get()
    assert snapshot["revision"] == 2
    assert snapshot["current_time_ms"] == 1_000

    with pytest.raises(ValueError, match="only the desktop viewer"):
        await channel.apply(
            {
                "type": "state",
                "current_time_ms": 500,
                "paused": True,
                "role": "remote",
                "client_id": "phone",
            }
        )

    await channel.close()
    assert (await first.get())["type"] == "session-ended"
    assert (await second.get())["type"] == "session-ended"
