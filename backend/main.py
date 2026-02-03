"""FastAPI application entrypoint."""

from __future__ import annotations

import os
os.environ["DA3_LOG_LEVEL"] = "WARN"

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers import session as session_router
from backend.routers import stream as stream_router
from backend.config import get_settings
from backend.video.session import get_session_manager


def create_app() -> FastAPI:
    app = FastAPI(title="VideoDepthViewer3D")
    settings = get_settings()
    
    import logging
    logging.basicConfig(level=settings.log_level)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(session_router.router)
    app.include_router(stream_router.router)

    @app.on_event("startup")
    async def clear_cached_sessions() -> None:
        await get_session_manager().clear_cache()

    return app


from pydantic import BaseModel

class LogMessage(BaseModel):
    message: str

app = create_app()

@app.post("/api/log")
async def log_message(log: LogMessage):
    import logging
    logger = logging.getLogger("backend.main")
    logger.info(f"[Frontend] {log.message}")
    # Write to file for analysis
    import time
    with open("backend_stats.txt", "a") as f:
        f.write(f"{time.time()}: [Frontend] {log.message}\n")
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.main:app", reload=True)
