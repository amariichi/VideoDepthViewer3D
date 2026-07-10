"""Depth post-processing helpers."""

from __future__ import annotations

import cv2
import numpy as np


def calculate_depth_target_size(
    frame_width: int,
    frame_height: int,
    process_res: int,
    downsample_factor: int,
) -> tuple[int, int]:
    """Choose transport size without upsampling beyond inference detail."""

    width = max(int(frame_width), 1)
    height = max(int(frame_height), 1)
    longest = max(width, height)
    factor = max(int(downsample_factor), 1)
    # The factor applies to useful inference detail, not coded RGB size. If it
    # were applied only to a 4K source, factors 2-4 could still exceed a 640 px
    # model raster and have no effect on transport.
    target_longest = min(longest, max(int(process_res), 1)) / factor
    scale = min(target_longest / longest, 1.0)
    return max(1, round(width * scale)), max(1, round(height * scale))


def downsample_depth(depth: np.ndarray, factor: int) -> np.ndarray:
    """Downsample a depth map using area interpolation.

    Args:
        depth: numpy array with shape (H, W).
        factor: positive integer; 1 means no change.
    """

    if factor <= 1:
        return depth
    h, w = depth.shape
    new_h = max(1, h // factor)
    new_w = max(1, w // factor)
    resized = cv2.resize(depth, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized.astype(depth.dtype, copy=False)
