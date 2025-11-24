import threading
import time
import numpy as np
from collections import defaultdict
from typing import Dict, List, Any

class StatisticsCollector:
    def __init__(self):
        self._lock = threading.Lock()
        self._data: Dict[str, List[float]] = defaultdict(list)
        self._counters: Dict[str, int] = defaultdict(int)
        self._start_time = time.time()

    def add(self, key: str, value: float):
        with self._lock:
            self._data[key].append(value)

    def set_counter(self, key: str, value: int):
        with self._lock:
            self._counters[key] = value

    def increment(self, key: str, value: int = 1):
        with self._lock:
            self._counters[key] += value

    def get_snapshot_and_reset(self) -> Dict[str, Any]:
        with self._lock:
            now = time.time()
            duration = now - self._start_time
            snapshot = {}
            
            # Process lists (timings)
            for key, values in self._data.items():
                if not values:
                    continue
                arr = np.array(values)
                snapshot[key] = {
                    "min": float(np.min(arr)),
                    "avg": float(np.mean(arr)),
                    "max": float(np.max(arr)),
                    "p95": float(np.percentile(arr, 95)),
                    "count": len(arr)
                }
            
            # Process counters (gauges)
            for key, value in self._counters.items():
                snapshot[key] = value
                
            # Throughput
            if "total_s" in snapshot:
                count = snapshot["total_s"]["count"]
                snapshot["fps"] = count / duration if duration > 0 else 0.0

            # Reset
            self._data.clear()
            self._counters.clear()
            self._start_time = now
            
            return snapshot
