import asyncio
from collections import deque

import numpy as np
import pytest

from backend.video.session import DepthFrame, VideoSession


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
