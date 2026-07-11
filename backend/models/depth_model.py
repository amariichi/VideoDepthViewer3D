"""Depth inference helper wrapping Depth Anything 3 metric models."""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np
from PIL import Image
import cv2
import torch

from backend.config import get_settings
from backend.utils.calibration import CameraCalibration, metric_focal_scale

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
    metric_scale: float = 1.0
    calibration: CameraCalibration | None = None


@dataclass(slots=True)
class AsyncDepthPrediction:
    """Prediction plus separate scheduler and model execution timings."""

    prediction: DepthPrediction
    slot_wait_s: float
    execution_s: float
    cold_start: bool


class _SingleImageInputProcessor:
    """Avoid DA3's per-call thread pool when preprocessing one image."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    def __call__(self, image: list[Any], *args: Any, **kwargs: Any) -> Any:
        if len(image) == 1:
            kwargs.setdefault("num_workers", 1)
            kwargs.setdefault("sequential", True)
        return self._delegate(image, *args, **kwargs)


class DepthModel:
    """Lazy-loading wrapper around Video Depth Anything / Depth Anything 3."""

    def __init__(self, model_id: Optional[str] = None, device: Optional[str] = None) -> None:
        settings = get_settings()
        self.model_id = model_id or settings.depth_model_id
        self.device = self._resolve_device(device or settings.device)
        self.process_res = settings.depth_process_res
        self.cache_dir = settings.data_root.parent / "checkpoints"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._model: DepthAnything3 | None = None
        self._model_lock = threading.Lock()
        self._semaphore: asyncio.Semaphore | None = None
        self._max_workers = settings.inference_worker_count

    @staticmethod
    def _resolve_device(requested: str) -> torch.device:
        requested = requested.strip().lower()
        if requested != "auto":
            return torch.device(requested)
        if torch.cuda.is_available():
            return torch.device("cuda")
        xpu = getattr(torch, "xpu", None)
        if xpu is not None and xpu.is_available():
            return torch.device("xpu")
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    def _ensure_model(self) -> DepthAnything3:
        if self._model is not None:
            return self._model
        # infer_depth_async runs in a thread pool. On a cold start several
        # requests can reach this method together; serialize construction so a
        # multi-worker configuration does not download/load the same large
        # checkpoint multiple times.
        with self._model_lock:
            if self._model is not None:
                return self._model
            if DepthAnything3 is None:
                raise RuntimeError(
                    "depth-anything-3 package is not installed; run `uv pip install \"videodepthviewer3d[inference]\"`."
                )
            model = DepthAnything3.from_pretrained(
                self.model_id,
                cache_dir=str(self.cache_dir),
            )
            self._model = model.to(self.device).eval()
            input_processor = getattr(self._model, "input_processor", None)
            if input_processor is not None and not isinstance(
                input_processor,
                _SingleImageInputProcessor,
            ):
                self._model.input_processor = _SingleImageInputProcessor(input_processor)
            return self._model

    async def infer_depth_async(
        self,
        frame: np.ndarray,
        process_res: Optional[int] = None,
        target_size: Optional[tuple[int, int]] = None,
        calibration: CameraCalibration | None = None,
    ) -> AsyncDepthPrediction:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(self._max_workers)
        wait_start = time.perf_counter()
        async with self._semaphore:
            slot_wait_s = time.perf_counter() - wait_start
            cold_start = self._model is None
            loop = asyncio.get_running_loop()

            def run_inference() -> tuple[DepthPrediction, float]:
                execution_start = time.perf_counter()
                prediction = self.infer_depth(
                    frame,
                    process_res,
                    target_size,
                    calibration,
                )
                return prediction, time.perf_counter() - execution_start

            prediction, execution_s = await loop.run_in_executor(
                None,
                run_inference,
            )
            return AsyncDepthPrediction(
                prediction=prediction,
                slot_wait_s=slot_wait_s,
                execution_s=execution_s,
                cold_start=cold_start,
            )

    @property
    def inflight_count(self) -> int:
        if self._semaphore is None:
            return 0
        # semaphore.value is the number of available slots.
        # inflight = max_workers - available
        return self._max_workers - self._semaphore._value

    def infer_depth(
        self,
        frame: np.ndarray,
        process_res: Optional[int] = None,
        target_size: Optional[tuple[int, int]] = None,
        calibration: CameraCalibration | None = None,
    ) -> DepthPrediction:
        model = self._ensure_model()
        # Use provided process_res or default to self.process_res
        res = process_res if process_res is not None else self.process_res
        frame = self._limit_input_resolution(frame, res)
        pil = Image.fromarray(frame, mode="RGB")
        
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
        metric_scale = 1.0
        if calibration is not None and self._requires_metric_focal_scaling(prediction):
            settings = get_settings()
            metric_scale = metric_focal_scale(
                calibration,
                processed_width=depth.shape[1],
                processed_height=depth.shape[0],
                reference_focal_px=settings.metric_reference_focal_px,
            )
            depth *= metric_scale
        
        # Resize to target size if provided, otherwise to original frame size
        tgt_w, tgt_h = target_size if target_size else (pil.width, pil.height)
        depth = self._resize_depth(depth, tgt_h, tgt_w)
        
        depth = np.nan_to_num(depth, copy=True, nan=0.0, posinf=0.0, neginf=0.0)
        valid_depth = depth[depth > 0]
        if valid_depth.size:
            z_min = float(np.percentile(valid_depth, 0.1))
            z_max = float(np.percentile(valid_depth, 99.9))
        else:
            z_min = 1e-3
            z_max = 1.0
        if z_max <= z_min:
            z_max = z_min + 1e-3
        return DepthPrediction(
            depth=depth,
            z_min=z_min,
            z_max=z_max,
            metric_scale=metric_scale,
            calibration=calibration,
        )

    def _requires_metric_focal_scaling(self, prediction: object) -> bool:
        """Identify standalone DA3Metric output that is still canonical-scale."""

        model_name = self.model_id.upper().replace("_", "-")
        already_metric = bool(getattr(prediction, "is_metric", False))
        return "METRIC" in model_name and not already_metric

    @staticmethod
    def _limit_input_resolution(frame: np.ndarray, process_res: int) -> np.ndarray:
        """Avoid constructing a 2K/4K PIL image only to downscale it in DA3."""

        height, width = frame.shape[:2]
        longest = max(width, height)
        if longest <= process_res:
            return frame
        scale = process_res / longest
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        return cv2.resize(frame, target, interpolation=cv2.INTER_AREA)

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
