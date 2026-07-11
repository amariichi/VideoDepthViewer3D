import asyncio
from collections import deque
from types import SimpleNamespace

import numpy as np
import pytest

from backend.video.session import DepthFrame, VideoSession
from backend.utils.adaptive_quality import QualityMetrics


def depth_frame(timestamp_ms: float, value: float) -> DepthFrame:
    return DepthFrame(
        timestamp_ms=timestamp_ms,
        depth=np.array([[value]], dtype=np.float32),
        z_min=value,
        z_max=value + 1,
    )


@pytest.mark.asyncio
async def test_completion_order_cache_is_timestamp_sorted_and_deduplicated() -> None:
    session = VideoSession.__new__(VideoSession)
    session.depth_buffer = deque(maxlen=3)
    session.last_depth_time_ms = None
    session._buffer_lock = asyncio.Lock()

    await session.store_depth_frame(depth_frame(300, 3))
    await session.store_depth_frame(depth_frame(100, 1))
    await session.store_depth_frame(depth_frame(200, 2))
    await session.store_depth_frame(depth_frame(200.4, 20))
    await session.store_depth_frame(depth_frame(400, 4))

    assert [frame.timestamp_ms for frame in session.depth_buffer] == [
        200.4,
        300,
        400,
    ]
    assert float(session.depth_buffer[0].depth[0, 0]) == 20
    assert session.last_depth_time_ms == 400

    hit = await session.get_cached_depth(300, drop_on_hit=True)

    assert hit is not None
    assert hit.timestamp_ms == 300
    assert [frame.timestamp_ms for frame in session.depth_buffer] == [400]


@pytest.mark.asyncio
async def test_normalize_and_pack_timings_reach_quality_controller(monkeypatch) -> None:
    observed: list[QualityMetrics] = []

    class CapturingController:
        def observe(self, metrics: QualityMetrics) -> None:
            observed.append(metrics)

    session = VideoSession.__new__(VideoSession)
    session._buffer_lock = asyncio.Lock()
    session.telemetry = {}
    session.rolling_stats = {}
    session.quality_controller = CapturingController()
    session._delivery_window_start_s = None
    session._delivery_window_count = 0
    monkeypatch.setattr(
        "backend.video.session.get_settings",
        lambda: SimpleNamespace(inference_worker_count=3),
    )

    await session.update_telemetry({"normalize_s": 0.04, "pack_s": 0.06})
    session.adjust_quality()

    assert session.rolling_stats["normalize_avg_s"] == 0.04
    assert session.rolling_stats["pack_avg_s"] == 0.06
    assert len(observed) == 1
    assert observed[0].normalize_s == 0.04
    assert observed[0].pack_s == 0.06
