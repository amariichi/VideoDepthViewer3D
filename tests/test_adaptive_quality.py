from __future__ import annotations

from backend.utils.adaptive_quality import (
    AdaptiveQualityController,
    QualityMetrics,
    normalize_depth_encoding,
    normalize_performance_mode,
)
from backend.utils.depth_range import StableDepthRange


def make_controller(mode: str = "balanced") -> AdaptiveQualityController:
    return AdaptiveQualityController(
        mode=mode,  # type: ignore[arg-type]
        max_process_res=960,
        manual_downsample=1,
        manual_encoding="linear16",
        bad_samples=1,
        good_samples=2,
        cooldown_samples=0,
        warmup_samples=0,
    )


def test_modes_start_with_distinct_quality_budgets() -> None:
    smooth = make_controller("smooth").state
    balanced = make_controller("balanced").state
    quality = make_controller("quality").state

    assert (smooth.process_res, smooth.downsample_factor, smooth.encoding) == (
        480,
        2,
        "log8",
    )
    assert (balanced.process_res, balanced.downsample_factor, balanced.encoding) == (
        640,
        2,
        "log8",
    )
    assert (quality.process_res, quality.downsample_factor, quality.encoding) == (
        960,
        1,
        "linear16",
    )


def test_network_pressure_reduces_precision_before_spatial_quality() -> None:
    controller = make_controller("quality")
    poor_network = QualityMetrics(
        infer_s=0.02,
        latency_ms=900,
        worker_count=4,
    )

    controller.observe(poor_network)
    assert controller.state.encoding == "log8"
    assert controller.state.downsample_factor == 1

    controller.observe(poor_network)
    assert controller.state.downsample_factor == 2
    assert controller.state.limiting_stage == "network"


def test_server_work_is_not_misclassified_as_network_latency() -> None:
    controller = make_controller("balanced")
    server_bound = QualityMetrics(
        infer_s=0.2,
        infer_wait_s=0.1,
        decode_s=0.02,
        queue_s=0.03,
        send_s=0.001,
        latency_ms=400,
        worker_count=1,
    )

    controller.observe(server_bound)

    assert controller.state.process_res == 512
    assert controller.state.downsample_factor == 2
    assert controller.state.limiting_stage == "inference"


def test_normalize_and_pack_work_are_not_misclassified_as_network_latency() -> None:
    controller = make_controller("quality")

    controller.observe(
        QualityMetrics(
            infer_s=0.01,
            normalize_s=0.24,
            pack_s=0.30,
            send_s=0.001,
            latency_ms=600,
            worker_count=4,
        )
    )

    assert controller.state.encoding == "linear16"
    assert controller.state.downsample_factor == 1
    assert controller.state.process_res == 960
    assert controller.state.limiting_stage == "stable"


def test_applied_fps_can_trade_depth_resolution_for_smoothness() -> None:
    controller = make_controller("balanced")

    controller.observe(
        QualityMetrics(
            infer_s=0.04,
            applied_fps=20,
            worker_count=3,
        )
    )

    assert controller.state.process_res == 512
    assert controller.state.downsample_factor == 2
    assert controller.state.limiting_stage == "throughput"


def test_source_fps_caps_auto_mode_target() -> None:
    controller = AdaptiveQualityController(
        mode="balanced",
        max_process_res=960,
        manual_downsample=1,
        manual_encoding="linear16",
        warmup_samples=0,
        source_fps=24,
    )

    assert controller.state.target_fps == 24


def test_compute_pressure_changes_resolution_with_hysteretic_recovery() -> None:
    controller = make_controller("balanced")
    controller.observe(QualityMetrics(infer_s=0.2, worker_count=1))
    assert controller.state.process_res == 512
    assert controller.state.limiting_stage == "inference"

    headroom = QualityMetrics(infer_s=0.02, latency_ms=10, worker_count=4)
    controller.observe(headroom)
    assert controller.state.process_res == 512
    controller.observe(headroom)
    assert controller.state.process_res == 640


def test_compute_pressure_does_not_spend_network_only_downsampling() -> None:
    controller = make_controller("balanced")
    poor_compute = QualityMetrics(infer_s=0.2, worker_count=1)

    for _ in range(10):
        controller.observe(poor_compute)

    assert controller.state.process_res == 384
    assert controller.state.downsample_factor == 2


def test_startup_samples_do_not_degrade_quality() -> None:
    controller = AdaptiveQualityController(
        mode="balanced",
        max_process_res=960,
        manual_downsample=1,
        manual_encoding="linear16",
        bad_samples=1,
        good_samples=2,
        cooldown_samples=0,
        warmup_samples=2,
    )
    startup_spike = QualityMetrics(
        infer_s=3,
        latency_ms=1000,
        worker_count=3,
    )

    controller.observe(startup_spike)
    controller.observe(startup_spike)
    assert controller.state.process_res == 640
    assert controller.state.downsample_factor == 2
    assert controller.state.limiting_stage == "warming-up"

    controller.observe(startup_spike)
    assert controller.state.encoding == "log8"
    assert controller.state.process_res == 512
    assert controller.state.downsample_factor == 2


def test_manual_mode_never_adapts() -> None:
    controller = make_controller("manual")
    before = (
        controller.state.process_res,
        controller.state.downsample_factor,
        controller.state.encoding,
    )
    controller.observe(
        QualityMetrics(infer_s=10, queue_s=10, latency_ms=10_000, worker_count=1)
    )
    after = (
        controller.state.process_res,
        controller.state.downsample_factor,
        controller.state.encoding,
    )
    assert after == before
    assert controller.state.limiting_stage == "manual"


def test_depth_range_expands_immediately_and_contracts_slowly() -> None:
    tracker = StableDepthRange(contraction_delay=2, contraction_alpha=0.1)
    assert tracker.update(1, 10) == (1, 10)
    assert tracker.update(0.5, 12) == (0.5, 12)

    assert tracker.update(2, 8) == (0.5, 12)
    contracted = tracker.update(2, 8)
    assert contracted == (0.65, 11.6)


def test_untrusted_mode_values_fall_back_without_breaking_stream() -> None:
    assert normalize_performance_mode({"bad": "shape"}) == "balanced"
    assert normalize_performance_mode("quality") == "quality"
    assert normalize_depth_encoding(["linear16"]) == "log8"
