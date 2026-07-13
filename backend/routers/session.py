"""HTTP and control-WebSocket endpoints for session lifecycle."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from starlette.responses import FileResponse

from backend.video.browser_compat import (
    BrowserVideoPreparationCancelled,
    BrowserVideoPreparationError,
)
from backend.video.session import (
    InvalidVideoError,
    SessionManager,
    VideoSession,
    get_session_manager,
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def session_payload(session: VideoSession) -> dict[str, object]:
    """Return metadata shared by create, discovery, and status responses."""

    quality = session.quality_controller.state
    return {
        "session_id": session.session_id,
        "source_name": session.source_name,
        "media_type": session.media_type,
        "width": session.metadata.width,
        "height": session.metadata.height,
        "display_width": session.metadata.display_width,
        "display_height": session.metadata.display_height,
        "inference_width": session.metadata.inference_width,
        "inference_height": session.metadata.inference_height,
        "sample_aspect_ratio": {
            "numerator": session.metadata.sample_aspect_ratio_numerator,
            "denominator": session.metadata.sample_aspect_ratio_denominator,
        },
        "rotation_degrees": session.metadata.rotation_degrees,
        "calibration": session.calibration.as_dict(),
        "performance": {
            "mode": quality.mode,
            "process_res": quality.process_res,
            "downsample_factor": quality.downsample_factor,
            "encoding": quality.encoding,
            "target_fps": quality.target_fps,
        },
        "fps": session.metadata.fps,
        "duration_ms": session.metadata.duration_ms,
    }


@router.post("")
async def create_session(
    file: UploadFile,
    manager: SessionManager = Depends(get_session_manager),
):
    try:
        session = await manager.create_session(file)
    except InvalidVideoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return session_payload(session)


@router.get("/current")
async def current_session(manager: SessionManager = Depends(get_session_manager)):
    session = await manager.current()
    if session is None:
        return Response(status_code=204)
    return session_payload(session)


@router.get("/{session_id}/video")
async def session_video(
    session_id: str,
    manager: SessionManager = Depends(get_session_manager),
):
    session = await manager.get(session_id)
    if not session or not session.source_path.is_file():
        raise HTTPException(status_code=404, detail="session not found")
    return FileResponse(
        session.source_path,
        media_type=session.media_type,
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{session_id}/browser-video")
async def prepare_browser_video(
    session_id: str,
    manager: SessionManager = Depends(get_session_manager),
):
    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    try:
        await session.prepare_browser_video()
    except BrowserVideoPreparationCancelled as exc:
        raise HTTPException(
            status_code=409,
            detail="The video session was replaced while browser playback was prepared.",
        ) from exc
    except BrowserVideoPreparationError as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not prepare this codec for browser playback.",
        ) from exc
    return {"status": "ready"}


@router.get("/{session_id}/browser-video")
async def browser_video(
    session_id: str,
    manager: SessionManager = Depends(get_session_manager),
):
    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    path = session.browser_video_path
    if not path.is_file() or path.stat().st_size == 0:
        raise HTTPException(status_code=409, detail="browser video is not ready")
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.websocket("/{session_id}/control")
async def playback_control(
    websocket: WebSocket,
    session_id: str,
    manager: SessionManager = Depends(get_session_manager),
) -> None:
    await websocket.accept()
    session = await manager.get(session_id)
    if not session:
        # Tell reconnecting phone/viewer clients that this is a terminal session
        # state rather than a transient network loss.
        with suppress(Exception):
            await websocket.send_json({"type": "session-ended"})
        await websocket.close(code=1008)
        return

    queue = await session.playback.subscribe()
    stop = asyncio.Event()

    async def receiver() -> None:
        try:
            while not stop.is_set():
                payload = await websocket.receive_json()
                if not isinstance(payload, dict):
                    queue.put_nowait(
                        {"type": "error", "message": "playback message must be an object"}
                    )
                    continue
                active = await manager.get(session_id)
                if active is not session:
                    queue.put_nowait({"type": "session-ended"})
                    stop.set()
                    return
                try:
                    await session.playback.apply(payload)
                except ValueError as exc:
                    queue.put_nowait({"type": "error", "message": str(exc)})
        except WebSocketDisconnect:
            stop.set()
        except asyncio.CancelledError:
            raise
        except Exception:
            stop.set()

    async def sender() -> None:
        try:
            while not stop.is_set():
                message: dict[str, Any] = await queue.get()
                await websocket.send_json(message)
                if message.get("type") == "session-ended":
                    stop.set()
                    return
        except (WebSocketDisconnect, RuntimeError):
            stop.set()
        except asyncio.CancelledError:
            raise
        except Exception:
            stop.set()

    receiver_task = asyncio.create_task(receiver())
    sender_task = asyncio.create_task(sender())
    try:
        await stop.wait()
    finally:
        receiver_task.cancel()
        sender_task.cancel()
        await session.playback.unsubscribe(queue)
        with suppress(Exception):
            await asyncio.gather(receiver_task, sender_task, return_exceptions=True)
        with suppress(Exception):
            await websocket.close()


@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    manager: SessionManager = Depends(get_session_manager),
):
    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    await manager.delete_session(session_id)
    return {"status": "deleted"}


@router.get("/{session_id}/status")
async def session_status(
    session_id: str,
    manager: SessionManager = Depends(get_session_manager),
):
    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    buffer = await session.buffer_snapshot()
    settings = manager.settings
    quality = session.quality_controller.state
    return {
        **session_payload(session),
        "config": {
            "inference_workers": settings.inference_worker_count,
            "decoder_workers": settings.decoder_worker_count,
            "process_res": quality.process_res,
            "downsample_factor": quality.downsample_factor,
            "encoding": quality.encoding,
            "mode": quality.mode,
            "target_fps": quality.target_fps,
            "limiting_stage": quality.limiting_stage,
        },
        **buffer,
    }
