from __future__ import annotations

from scripts.benchmark_pipeline import summarize


def test_benchmark_summary_reports_distribution() -> None:
    result = summarize([1, 2, 3, 4, 100])

    assert result["p50"] == 3
    assert result["p95"] > 4
    assert result["max"] == 100
    assert result["mean"] == 22


def test_benchmark_summary_handles_empty_input() -> None:
    assert summarize([]) == {"p50": 0, "p95": 0, "max": 0, "mean": 0}
