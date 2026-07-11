"""Stable session-level bounds for depth transport quantization."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite


@dataclass(slots=True)
class StableDepthRange:
    contraction_delay: int = 60
    contraction_alpha: float = 0.01
    z_min: float | None = None
    z_max: float | None = None
    _inside_count: int = 0

    def update(self, frame_min: float, frame_max: float) -> tuple[float, float]:
        low, high = self._sanitize(frame_min, frame_max)
        if self.z_min is None or self.z_max is None:
            self.z_min, self.z_max = low, high
            return low, high

        expanded = False
        if low < self.z_min:
            self.z_min = low
            expanded = True
        if high > self.z_max:
            self.z_max = high
            expanded = True

        if expanded:
            self._inside_count = 0
        else:
            self._inside_count += 1
            if self._inside_count >= self.contraction_delay:
                alpha = min(max(self.contraction_alpha, 0.0), 1.0)
                self.z_min += (low - self.z_min) * alpha
                self.z_max += (high - self.z_max) * alpha

        if self.z_max <= self.z_min:
            self.z_max = self.z_min + 1e-3
        return self.z_min, self.z_max

    @staticmethod
    def _sanitize(frame_min: float, frame_max: float) -> tuple[float, float]:
        low = float(frame_min)
        high = float(frame_max)
        if not isfinite(low) or low <= 0:
            low = 1e-3
        if not isfinite(high) or high <= low:
            high = low + 1e-3
        return low, high
