"""Helpers to quantize depth frames and assemble binary payloads."""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

import numpy as np

from backend.config import get_settings

HEADER_STRUCT = struct.Struct("<4sHHIIIfff")
HEADER_SIZE = HEADER_STRUCT.size  # 32 bytes
DATA_TYPE_UINT16 = 1


@dataclass(slots=True)
class DepthPayload:
    buffer: bytes
    width: int
    height: int
    scale: float
    bias: float
    z_max: float


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


def pack_depth_payload(depth: np.ndarray, timestamp_ms: float, z_min: float, z_max: float, compress: bool = True) -> DepthPayload:
    settings = get_settings()
    encoded, scale, bias = quantize_depth(depth, z_min, z_max)
    
    raw_bytes = encoded.tobytes()
    if compress:
        payload_bytes = zlib.compress(raw_bytes, level=1)  # Level 1 is fastest
        magic = b"VDZ2"
    else:
        payload_bytes = raw_bytes
        magic = settings.depth_header_magic

    header = HEADER_STRUCT.pack(
        magic,
        1,  # version
        DATA_TYPE_UINT16,
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
    )
