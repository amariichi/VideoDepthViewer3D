"""Depth post-processing helpers."""

from __future__ import annotations

import cv2
import numpy as np


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
