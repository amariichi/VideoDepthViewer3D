"""HTTP endpoints for session lifecycle."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from backend.video.session import SessionManager, get_session_manager

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("")
async def create_session(file: UploadFile, manager: SessionManager = Depends(get_session_manager)):
    session = await manager.create_session(file)
    return {
        "session_id": session.session_id,
        "width": session.metadata.width,
        "height": session.metadata.height,
        "fps": session.metadata.fps,
        "duration_ms": session.metadata.duration_ms,
    }


@router.delete("/{session_id}")
async def delete_session(session_id: str, manager: SessionManager = Depends(get_session_manager)):
    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    await manager.delete_session(session_id)
    return {"status": "deleted"}


@router.get("/{session_id}/status")
async def session_status(session_id: str, manager: SessionManager = Depends(get_session_manager)):
    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    buffer = await session.buffer_snapshot()
    settings = get_session_manager().settings
    return {
        "session_id": session.session_id,
        "width": session.metadata.width,
        "height": session.metadata.height,
        "fps": session.metadata.fps,
        "duration_ms": session.metadata.duration_ms,
        "config": {
            "inference_workers": settings.inference_worker_count,
            "process_res": session.telemetry.get("quality_process_res", settings.depth_process_res),
            "downsample_factor": session.telemetry.get("quality_downsample_factor", settings.depth_downsample_factor),
        },
        **buffer,
    }
