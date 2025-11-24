"""Runtime configuration for the VideoDepthViewer3D backend."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Central place for tunable backend parameters."""

    data_root: Path = Field(default=Path("tmp/sessions"), validation_alias="VIDEO_DEPTH_DATA_ROOT")
    video_cache_size: int = Field(default=8, validation_alias="VIDEO_DEPTH_CACHE")
    depth_model_id: str = Field(
        default="depth-anything/DA3METRIC-LARGE",
        validation_alias="VIDEO_DEPTH_MODEL_ID",
    )
    depth_process_res: int = Field(default=640, validation_alias="VIDEO_DEPTH_PROCESS_RES")
    device: str = "cuda"
    max_queue_size: int = 4
    depth_width: int = 640
    depth_height: int = 360
    torch_dtype: str = "float16"
    depth_header_magic: bytes = b"VDZ1"
    cors_origins: List[str] = Field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"], validation_alias="VIDEO_DEPTH_CORS_ORIGINS")
    profile_depth_timing: bool = Field(default=False, validation_alias="VIDEO_DEPTH_PROFILE_TIMING")
    depth_downsample_factor: int = Field(default=1, validation_alias="VIDEO_DEPTH_DOWNSAMPLE")
    depth_compression_level: int = Field(default=0, validation_alias="VIDEO_DEPTH_COMPRESSION")
    uv_cache_dir: Path | None = None
    inference_worker_count: int = Field(default=3, validation_alias="VIDEO_DEPTH_INFER_WORKERS")
    log_level: str = Field(default="WARNING", validation_alias="VIDEO_DEPTH_LOG_LEVEL")

    model_config = {
        "frozen": True,
    }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a singleton settings object."""

    root = Settings()
    root.data_root.mkdir(parents=True, exist_ok=True)
    return root
