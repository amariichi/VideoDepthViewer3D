from backend.config import Settings, _default_inference_worker_count


def test_inference_worker_default_is_platform_specific() -> None:
    assert _default_inference_worker_count("win32") == 2
    assert _default_inference_worker_count("linux") == 3


def test_settings_uses_platform_inference_worker_default(monkeypatch) -> None:
    monkeypatch.delenv("VIDEO_DEPTH_INFER_WORKERS", raising=False)
    assert Settings().inference_worker_count == _default_inference_worker_count()
