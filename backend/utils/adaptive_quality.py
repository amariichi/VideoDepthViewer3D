"""Deterministic automatic quality policy independent of UI and hardware APIs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PerformanceMode = Literal["smooth", "balanced", "quality", "manual"]
DepthEncoding = Literal["linear16", "log8"]


@dataclass(frozen=True, slots=True)
class ModeProfile:
    target_fps: float
    latency_budget_ms: float
    preferred_process_res: int
    minimum_process_res: int
    maximum_process_res: int
    initial_downsample: int
    maximum_downsample: int
    preferred_encoding: DepthEncoding


MODE_PROFILES: dict[PerformanceMode, ModeProfile] = {
    "smooth": ModeProfile(30, 180, 480, 320, 640, 2, 4, "log8"),
    "balanced": ModeProfile(30, 250, 640, 384, 720, 2, 4, "log8"),
    "quality": ModeProfile(24, 400, 960, 480, 4096, 1, 2, "linear16"),
    "manual": ModeProfile(0, float("inf"), 640, 1, 4096, 1, 16, "linear16"),
}


@dataclass(slots=True)
class QualityState:
    mode: PerformanceMode
    process_res: int
    downsample_factor: int
    encoding: DepthEncoding
    target_fps: float
    limiting_stage: str = "warming-up"


@dataclass(frozen=True, slots=True)
class QualityMetrics:
    infer_s: float = 0.0
    infer_wait_s: float = 0.0
    decode_s: float = 0.0
    normalize_s: float = 0.0
    pack_s: float = 0.0
    queue_s: float = 0.0
    send_s: float = 0.0
    latency_ms: float = 0.0
    applied_fps: float = 0.0
    worker_count: int = 1


class AdaptiveQualityController:
    """Hysteretic quality state machine used by each video session."""

    BASE_RESOLUTIONS = (960, 720, 640, 512, 480, 384, 320)

    def __init__(
        self,
        *,
        mode: PerformanceMode,
        max_process_res: int,
        manual_downsample: int,
        manual_encoding: DepthEncoding,
        bad_samples: int = 3,
        good_samples: int = 30,
        cooldown_samples: int = 60,
        warmup_samples: int = 120,
        source_fps: float | None = None,
    ) -> None:
        self.max_process_res = max(int(max_process_res), 1)
        self.manual_downsample = max(int(manual_downsample), 1)
        self.manual_encoding = manual_encoding
        self.bad_samples = max(int(bad_samples), 1)
        self.good_samples = max(int(good_samples), 1)
        self.cooldown_samples = max(int(cooldown_samples), 0)
        self.warmup_samples = max(int(warmup_samples), 0)
        self.source_fps = (
            float(source_fps)
            if source_fps is not None and source_fps > 0
            else float("inf")
        )
        self._bad_streak = 0
        self._good_streak = 0
        self._cooldown = 0
        self._warmup = self.warmup_samples
        self.state = self._initial_state(mode)

    def set_mode(self, mode: PerformanceMode) -> QualityState:
        if mode == self.state.mode:
            return self.state
        self._bad_streak = 0
        self._good_streak = 0
        self._cooldown = 0
        self.state = self._initial_state(mode)
        return self.state

    def observe(self, metrics: QualityMetrics) -> QualityState:
        if self.state.mode == "manual":
            self.state.limiting_stage = "manual"
            return self.state
        if self._warmup > 0:
            self._warmup -= 1
            self.state.limiting_stage = "warming-up"
            return self.state
        if self._cooldown > 0:
            self._cooldown -= 1
            return self.state

        profile = MODE_PROFILES[self.state.mode]
        target_fps = min(profile.target_fps, self.source_fps)
        workers = max(metrics.worker_count, 1)
        stage_s = max(metrics.infer_s + 0.25 * metrics.decode_s, 1e-6)
        capacity_fps = workers / stage_s if metrics.infer_s > 0 else 0.0
        model_capacity_bad = capacity_fps > 0 and capacity_fps < target_fps * 0.9
        applied_throughput_bad = (
            metrics.applied_fps > 0 and metrics.applied_fps < target_fps * 0.9
        )
        compute_bad = model_capacity_bad or applied_throughput_bad
        queue_bad = metrics.queue_s * 1000 > profile.latency_budget_ms * 0.5
        server_latency_ms = 1000 * (
            metrics.infer_s
            + metrics.infer_wait_s
            + metrics.decode_s
            + metrics.normalize_s
            + metrics.pack_s
            + metrics.queue_s
            + metrics.send_s
        )
        # Browser RTT is end-to-end, not a network-only measurement. Subtract
        # the server stages we already measure so slow inference does not spend
        # transport-quality levers such as depth downsampling.
        transport_latency_ms = max(metrics.latency_ms - server_latency_ms, 0.0)
        network_bad = (
            transport_latency_ms > profile.latency_budget_ms
            or metrics.send_s > (1.0 / target_fps) * 0.35
        )
        applied_throughput_good = (
            metrics.applied_fps <= 0 or metrics.applied_fps >= target_fps * 0.98
        )
        is_bad = compute_bad or queue_bad or network_bad
        is_good = (
            capacity_fps >= target_fps * 1.75
            and applied_throughput_good
            and metrics.queue_s * 1000 < profile.latency_budget_ms * 0.2
            and transport_latency_ms < profile.latency_budget_ms * 0.6
            and metrics.send_s < (1.0 / target_fps) * 0.2
        )

        self._bad_streak = self._bad_streak + 1 if is_bad else 0
        self._good_streak = self._good_streak + 1 if is_good else 0

        if self._bad_streak >= self.bad_samples:
            if network_bad:
                changed = self._degrade_network(profile)
                self.state.limiting_stage = "network"
            else:
                changed = self._degrade_compute(profile)
                if queue_bad:
                    self.state.limiting_stage = "queue"
                elif applied_throughput_bad:
                    self.state.limiting_stage = "throughput"
                else:
                    self.state.limiting_stage = "inference"
            self._bad_streak = 0
            self._good_streak = 0
            if changed:
                self._cooldown = self.cooldown_samples
        elif self._good_streak >= self.good_samples:
            changed = self._upgrade(profile)
            self.state.limiting_stage = "headroom" if changed else "target"
            self._bad_streak = 0
            self._good_streak = 0
            if changed:
                self._cooldown = self.cooldown_samples
        elif not is_bad:
            self.state.limiting_stage = "stable"
        return self.state

    def _initial_state(self, mode: PerformanceMode) -> QualityState:
        if mode == "manual":
            return QualityState(
                mode=mode,
                process_res=self.max_process_res,
                downsample_factor=self.manual_downsample,
                encoding=self.manual_encoding,
                target_fps=0,
                limiting_stage="manual",
            )
        profile = MODE_PROFILES[mode]
        steps = self._resolution_steps(profile)
        initial = min(steps, key=lambda value: abs(value - profile.preferred_process_res))
        return QualityState(
            mode=mode,
            process_res=initial,
            downsample_factor=profile.initial_downsample,
            encoding=profile.preferred_encoding,
            target_fps=min(profile.target_fps, self.source_fps),
        )

    def _resolution_steps(self, profile: ModeProfile) -> list[int]:
        upper = min(self.max_process_res, profile.maximum_process_res)
        values = {value for value in self.BASE_RESOLUTIONS if profile.minimum_process_res <= value <= upper}
        values.add(upper)
        if not values:
            values.add(self.max_process_res)
        return sorted(values, reverse=True)

    def _degrade_compute(self, profile: ModeProfile) -> bool:
        # Output downsampling happens after model inference, so it saves
        # transport/packing work but cannot relieve GPU inference pressure.
        # Keep it as a network lever and change only process resolution here.
        return self._lower_resolution(profile)

    def _degrade_network(self, profile: ModeProfile) -> bool:
        if self.state.encoding == "linear16":
            self.state.encoding = "log8"
            return True
        if self.state.downsample_factor < profile.maximum_downsample:
            self.state.downsample_factor = min(
                self.state.downsample_factor * 2,
                profile.maximum_downsample,
            )
            return True
        return self._lower_resolution(profile)

    def _lower_resolution(self, profile: ModeProfile) -> bool:
        steps = self._resolution_steps(profile)
        current_index = min(
            range(len(steps)),
            key=lambda index: abs(steps[index] - self.state.process_res),
        )
        if current_index >= len(steps) - 1:
            return False
        self.state.process_res = steps[current_index + 1]
        return True

    def _upgrade(self, profile: ModeProfile) -> bool:
        steps = self._resolution_steps(profile)
        current_index = min(
            range(len(steps)),
            key=lambda index: abs(steps[index] - self.state.process_res),
        )
        if current_index > 0:
            self.state.process_res = steps[current_index - 1]
            return True
        if self.state.downsample_factor > profile.initial_downsample:
            self.state.downsample_factor = max(
                profile.initial_downsample,
                self.state.downsample_factor // 2,
            )
            return True
        if self.state.encoding != profile.preferred_encoding:
            self.state.encoding = profile.preferred_encoding
            return True
        return False


def normalize_performance_mode(value: object) -> PerformanceMode:
    if isinstance(value, str) and value in MODE_PROFILES:
        return value  # type: ignore[return-value]
    return "balanced"


def normalize_depth_encoding(value: object) -> DepthEncoding:
    if value == "linear16":
        return "linear16"
    return "log8"
