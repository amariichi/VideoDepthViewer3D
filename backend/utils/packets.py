"""Helpers to quantize depth frames and assemble binary payloads."""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from typing import Literal

import numpy as np

from backend.config import get_settings

HEADER_STRUCT = struct.Struct("<4sHHIIIfff")
HEADER_SIZE = HEADER_STRUCT.size  # 32 bytes
DATA_TYPE_UINT16 = 1
DATA_TYPE_UINT8_LOG = 2
DepthEncoding = Literal["linear16", "log8"]


@dataclass(slots=True)
class DepthPayload:
    buffer: bytes
    width: int
    height: int
    scale: float
    bias: float
    z_max: float
    encoding: DepthEncoding


def quantize_depth(depth: np.ndarray, z_min: float, z_max: float) -> tuple[np.ndarray, float, float]:
    z_min = float(z_min)
    z_max = float(z_max)
    if z_max <= z_min:
        z_max = z_min + 1e-3
    scale = (z_max - z_min) / 65535.0
    np.clip(depth, z_min, z_max, out=depth)
    normalized = (depth - z_min) / scale
    encoded = np.rint(normalized).astype("<u2", copy=False)
    return encoded, scale, z_min


def quantize_depth_log8(
    depth: np.ndarray,
    z_min: float,
    z_max: float,
) -> tuple[np.ndarray, float, float]:
    z_min = max(float(z_min), 1e-6)
    z_max = max(float(z_max), z_min + 1e-6)
    log_min = float(np.log(z_min))
    log_max = float(np.log(z_max))
    scale = (log_max - log_min) / 255.0
    if scale <= 0:
        scale = 1e-6
    np.clip(depth, z_min, z_max, out=depth)
    normalized = (np.log(depth) - log_min) / scale
    encoded = np.rint(normalized).astype(np.uint8, copy=False)
    return encoded, scale, log_min


def pack_depth_payload(
    depth: np.ndarray,
    timestamp_ms: float,
    z_min: float,
    z_max: float,
    compress: bool = True,
    compression_level: int = 1,
    encoding: DepthEncoding = "linear16",
) -> DepthPayload:
    settings = get_settings()
    level = min(max(int(compression_level), 0), 9) if compress else 0
    is_compressed = level > 0
    if encoding == "log8":
        encoded, scale, bias = quantize_depth_log8(depth, z_min, z_max)
        data_type = DATA_TYPE_UINT8_LOG
        version = 2
        magic = b"VDZ4" if is_compressed else b"VDZ3"
    else:
        encoded, scale, bias = quantize_depth(depth, z_min, z_max)
        data_type = DATA_TYPE_UINT16
        version = 1
        magic = b"VDZ2" if is_compressed else settings.depth_header_magic

    raw_bytes = encoded.tobytes()
    if is_compressed:
        payload_bytes = zlib.compress(raw_bytes, level=level)
    else:
        payload_bytes = raw_bytes

    header = HEADER_STRUCT.pack(
        magic,
        version,
        data_type,
        int(timestamp_ms),
        depth.shape[1],
        depth.shape[0],
        scale,
        bias,
        z_max,
    )
    return DepthPayload(
        buffer=header + payload_bytes,
        width=depth.shape[1],
        height=depth.shape[0],
        scale=scale,
        bias=bias,
        z_max=z_max,
        encoding=encoding,
    )
