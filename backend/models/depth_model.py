"""Depth inference helper wrapping Depth Anything 3 metric models."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image
import cv2
import torch

from backend.config import get_settings

try:  # pragma: no cover - heavy dependency optional in tests
    from depth_anything_3.api import DepthAnything3
except ImportError:  # pragma: no cover
    DepthAnything3 = None  # type: ignore[assignment]


@dataclass(slots=True)
class DepthPrediction:
    """Container for a depth map in meters."""

    depth: np.ndarray
    z_min: float
    z_max: float


class DepthModel:
    """Lazy-loading wrapper around Video Depth Anything / Depth Anything 3."""

    def __init__(self, model_id: Optional[str] = None, device: Optional[str] = None) -> None:
        settings = get_settings()
        self.model_id = model_id or settings.depth_model_id
        self.device = torch.device(device or settings.device)
        self.process_res = settings.depth_process_res
        self.cache_dir = settings.data_root.parent / "checkpoints"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._model: DepthAnything3 | None = None
        self._semaphore: asyncio.Semaphore | None = None
        self._max_workers = settings.inference_worker_count

    def _ensure_model(self) -> DepthAnything3:
        if self._model is not None:
            return self._model
        if DepthAnything3 is None:
            raise RuntimeError(
                "depth-anything-3 package is not installed; run `uv pip install \"videodepthviewer3d[inference]\"`."
            )
        model = DepthAnything3.from_pretrained(self.model_id, cache_dir=str(self.cache_dir))
        self._model = model.to(self.device).eval()
        return self._model

    async def infer_depth_async(self, frame: np.ndarray, process_res: Optional[int] = None, target_size: Optional[tuple[int, int]] = None) -> DepthPrediction:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(self._max_workers)
        async with self._semaphore:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, self.infer_depth, frame, process_res, target_size)

    @property
    def inflight_count(self) -> int:
        if self._semaphore is None:
            return 0
        # semaphore.value is the number of available slots.
        # inflight = max_workers - available
        return self._max_workers - self._semaphore._value

    def infer_depth(self, frame: np.ndarray, process_res: Optional[int] = None, target_size: Optional[tuple[int, int]] = None) -> DepthPrediction:
        model = self._ensure_model()
        pil = Image.fromarray(frame, mode="RGB")
        
        # Use provided process_res or default to self.process_res
        res = process_res if process_res is not None else self.process_res
        
        # Debug: Check device and res
        # param_device = next(model.parameters()).device
        # print(f"[DepthModel] Inferring on {param_device} with res={res}. Frame: {pil.size}")
        
        prediction = model.inference(
            [pil],
            process_res=res,
            process_res_method="upper_bound_resize",
            export_dir=None,
        )
        depth = np.array(prediction.depth[0], dtype=np.float32, copy=True)
        
        # Resize to target size if provided, otherwise to original frame size
        tgt_w, tgt_h = target_size if target_size else (pil.width, pil.height)
        depth = self._resize_depth(depth, tgt_h, tgt_w)
        
        depth = np.nan_to_num(depth, copy=True, nan=0.0, posinf=0.0, neginf=0.0)
        z_min = float(np.percentile(depth, 1))
        z_max = float(np.percentile(depth, 99))
        if z_max <= z_min:
            z_max = z_min + 1.0
        return DepthPrediction(depth=depth, z_min=z_min, z_max=z_max)

    @staticmethod
    def _resize_depth(depth: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
        if depth.shape == (target_h, target_w):
            return depth
        # Use OpenCV for resizing to release GIL (PIL often holds it)
        # cv2.resize expects (width, height)
        # Use INTER_AREA if downscaling, INTER_CUBIC/LINEAR if upscaling
        # But here we just use INTER_LINEAR for speed/quality balance or INTER_AREA for downsampling
        # The original code used INTER_CUBIC.
        # If we are resizing from inference size (small) to target size (medium/large), 
        # we should use CUBIC or LINEAR.
        # If we are resizing from inference size (large) to target size (small), AREA is better.
        
        # Simple heuristic:
        interpolation = cv2.INTER_CUBIC
        if target_w < depth.shape[1] and target_h < depth.shape[0]:
             interpolation = cv2.INTER_AREA
             
        resized = cv2.resize(depth, (target_w, target_h), interpolation=interpolation)
        return resized.astype(np.float32, copy=False)


_depth_model: DepthModel | None = None


def get_depth_model() -> DepthModel:
    global _depth_model
    if _depth_model is None:
        _depth_model = DepthModel()
    return _depth_model
