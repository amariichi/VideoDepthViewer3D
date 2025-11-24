import asyncio
from collections import deque
from typing import Generic, TypeVar, Optional

T = TypeVar("T")

class DroppingQueue(Generic[T]):
    """
    An asyncio queue that drops the oldest item when full (LIFO freshness, FIFO processing).
    """

    def __init__(self, maxsize: int):
        self.maxsize = maxsize
        self._queue: deque[T] = deque()
        self._get_event = asyncio.Event()
        self._dropped_count = 0

    def put_nowait(self, item: T) -> None:
        """
        Put an item into the queue. If full, drop the oldest item.
        This method is non-blocking.
        """
        if self.maxsize > 0 and len(self._queue) >= self.maxsize:
            self._queue.popleft()
            self._dropped_count += 1
        
        self._queue.append(item)
        self._get_event.set()

    async def get(self) -> T:
        """
        Remove and return an item from the queue.
        Waits if the queue is empty.
        """
        while not self._queue:
            self._get_event.clear()
            await self._get_event.wait()
        
        return self._queue.popleft()

    @property
    def dropped_count(self) -> int:
        """Return total number of dropped items."""
        return self._dropped_count

    def reset_dropped_count(self) -> None:
        self._dropped_count = 0

    def qsize(self) -> int:
        return len(self._queue)

    def empty(self) -> bool:
        return not self._queue
