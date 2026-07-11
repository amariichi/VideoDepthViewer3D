#!/usr/bin/env python3
"""Benchmark decode, normalization, DA3 inference, and depth packing stages."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import median
from typing import Sequence

import numpy as np

@dataclass(slots=True)
class FrameSample:
    timestamp_ms: float
    decoded_timestamp_ms: float
    decode_ms: float
    normalize_ms: float
    infer_ms: float
    pack_ms: float
    total_ms: float
    payload_bytes: int
    median_depth_m: float
    metric_scale: float


def summarize(values: Sequence[float]) -> dict[str, float]:
    array = np.asarray(values, dtype=np.float64)
    if array.size == 0:
        return {"p50": 0.0, "p95": 0.0, "max": 0.0, "mean": 0.0}
    return {
        "p50": float(np.percentile(array, 50)),
        "p95": float(np.percentile(array, 95)),
        "max": float(np.max(array)),
        "mean": float(np.mean(array)),
    }


def resolve_video(video: Path | None, manifest: Path, case_name: str) -> Path:
    if video is not None:
        return video.resolve()
    data = json.loads(manifest.read_text())
    for case in data.get("cases", []):
        if case.get("name") == case_name and case.get("status") == "generated":
            return (manifest.parent / case["path"]).resolve()
    raise SystemExit(
        f"case {case_name!r} is unavailable in {manifest}; generate test media first"
    )


def software_versions() -> dict[str, str]:
    versions = {"python": platform.python_version()}
    for package in ("av", "numpy", "torch", "depth-anything-3"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "not-installed"
    return versions


def gpu_description() -> str | None:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,driver_version,memory.total",
                "--format=csv,noheader",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def benchmark(args: argparse.Namespace) -> dict[str, object]:
    from backend.models.depth_model import DepthModel
    from backend.utils.calibration import (
        build_fallback_calibration,
        normalize_frame_for_display,
    )
    from backend.utils.depth_range import StableDepthRange
    from backend.utils.depth_ops import calculate_depth_target_size
    from backend.utils.packets import pack_depth_payload
    from backend.video.io import FrameDecoder

    source = resolve_video(args.video, args.manifest, args.case)
    decoder = FrameDecoder(source)
    metadata = decoder.metadata()
    calibration = build_fallback_calibration(
        source_width=metadata.width,
        source_height=metadata.height,
        sar_numerator=metadata.sample_aspect_ratio_numerator,
        sar_denominator=metadata.sample_aspect_ratio_denominator,
        rotation_degrees=metadata.rotation_degrees,
        fov_y_degrees=args.source_fov_y,
    )
    model = DepthModel(model_id=args.model_id, device=args.device)
    depth_range = StableDepthRange()
    frame_period_ms = 1000.0 / max(metadata.fps, 1.0)
    duration_ms = metadata.duration_ms or frame_period_ms * (args.frames + args.warmup)
    total_frames = args.frames + args.warmup
    timestamps = np.linspace(
        0,
        max(0.0, duration_ms - 2 * frame_period_ms),
        total_frames,
    )
    samples: list[FrameSample] = []

    try:
        for index, timestamp_ms in enumerate(timestamps):
            total_start = time.perf_counter()
            start = time.perf_counter()
            frame, info = decoder.decode_at(float(timestamp_ms))
            decode_ms = (time.perf_counter() - start) * 1000

            start = time.perf_counter()
            frame = normalize_frame_for_display(frame, calibration)
            normalize_ms = (time.perf_counter() - start) * 1000
            height, width = frame.shape[:2]
            target_size = calculate_depth_target_size(
                width,
                height,
                args.process_res,
                args.downsample,
            )

            start = time.perf_counter()
            prediction = model.infer_depth(
                frame,
                process_res=args.process_res,
                target_size=target_size,
                calibration=calibration,
            )
            infer_ms = (time.perf_counter() - start) * 1000
            z_min, z_max = depth_range.update(prediction.z_min, prediction.z_max)

            start = time.perf_counter()
            payload = pack_depth_payload(
                prediction.depth.copy(),
                info.time_ms,
                z_min,
                z_max,
                compress=args.compress,
                encoding=args.encoding,
            )
            pack_ms = (time.perf_counter() - start) * 1000
            total_ms = (time.perf_counter() - total_start) * 1000
            if index >= args.warmup:
                samples.append(
                    FrameSample(
                        timestamp_ms=float(timestamp_ms),
                        decoded_timestamp_ms=info.time_ms,
                        decode_ms=decode_ms,
                        normalize_ms=normalize_ms,
                        infer_ms=infer_ms,
                        pack_ms=pack_ms,
                        total_ms=total_ms,
                        payload_bytes=len(payload.buffer),
                        median_depth_m=float(np.median(prediction.depth)),
                        metric_scale=prediction.metric_scale,
                    )
                )
    finally:
        decoder.close()

    total_seconds = sum(sample.total_ms for sample in samples) / 1000.0
    achieved_fps = len(samples) / total_seconds if total_seconds > 0 else 0.0
    median_depths = [sample.median_depth_m for sample in samples]
    median_depth = median(median_depths) if median_depths else 0.0
    scale_deviation = (
        max(abs(value - median_depth) for value in median_depths) / median_depth
        if median_depth > 0 and median_depths
        else 0.0
    )
    avg_payload = float(np.mean([sample.payload_bytes for sample in samples]))

    return {
        "schema_version": 1,
        "source": str(source),
        "source_metadata": {
            "coded_width": metadata.width,
            "coded_height": metadata.height,
            "display_width": metadata.display_width,
            "display_height": metadata.display_height,
            "fps": metadata.fps,
            "rotation_degrees": metadata.rotation_degrees,
            "pixel_aspect_ratio": metadata.pixel_aspect_ratio,
        },
        "configuration": {
            "model_id": model.model_id,
            "device": str(model.device),
            "process_res": args.process_res,
            "downsample": args.downsample,
            "encoding": args.encoding,
            "compression": args.compress,
            "warmup_frames": args.warmup,
            "measured_frames": args.frames,
        },
        "hardware": {
            "platform": platform.platform(),
            "processor": platform.processor(),
            "gpu": gpu_description(),
        },
        "software": software_versions(),
        "summary": {
            "decode_ms": summarize([sample.decode_ms for sample in samples]),
            "normalize_ms": summarize([sample.normalize_ms for sample in samples]),
            "infer_ms": summarize([sample.infer_ms for sample in samples]),
            "pack_ms": summarize([sample.pack_ms for sample in samples]),
            "total_ms": summarize([sample.total_ms for sample in samples]),
            "sequential_fps": achieved_fps,
            "average_payload_bytes": avg_payload,
            "payload_mbps_at_sequential_fps": avg_payload * achieved_fps * 8 / 1_000_000,
            "metric_scale": summarize([sample.metric_scale for sample in samples]),
            "median_depth_temporal_relative_spread": scale_deviation,
        },
        "frames": [asdict(sample) for sample in samples],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("tmp/test-media/fast/manifest.json"),
    )
    parser.add_argument("--case", default="cfr_h264_320x180_30_audio")
    parser.add_argument("--model-id")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--process-res", type=int, default=640)
    parser.add_argument("--downsample", type=int, default=2)
    parser.add_argument("--encoding", choices=("linear16", "log8"), default="log8")
    parser.add_argument("--compress", action="store_true")
    parser.add_argument("--source-fov-y", type=float, default=50.0)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--frames", type=int, default=10)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.frames < 1 or args.warmup < 0:
        parser.error("--frames must be positive and --warmup must be non-negative")
    if args.process_res < 1 or args.downsample < 1:
        parser.error("--process-res and --downsample must be positive")
    return args


def main() -> int:
    args = parse_args()
    result = benchmark(args)
    rendered = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n")
        print(args.output)
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
