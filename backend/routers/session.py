"""HTTP endpoints for session lifecycle."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from backend.video.session import SessionManager, get_session_manager

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("")
async def create_session(file: UploadFile, manager: SessionManager = Depends(get_session_manager)):
    session = await manager.create_session(file)
    quality = session.quality_controller.state
    return {
        "session_id": session.session_id,
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
    quality = session.quality_controller.state
    return {
        "session_id": session.session_id,
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
        "fps": session.metadata.fps,
        "duration_ms": session.metadata.duration_ms,
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
