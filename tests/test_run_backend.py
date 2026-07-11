from __future__ import annotations

from scripts.run_backend import parse_args


def test_backend_runner_defaults_to_loopback(monkeypatch) -> None:
    monkeypatch.delenv("VIDEO_DEPTH_HOST", raising=False)
    monkeypatch.delenv("VIDEO_DEPTH_PORT", raising=False)

    args = parse_args([])

    assert args.host == "127.0.0.1"
    assert args.port == 8000
    assert args.reload is False


def test_backend_runner_accepts_environment_and_reload(monkeypatch) -> None:
    monkeypatch.setenv("VIDEO_DEPTH_HOST", "0.0.0.0")
    monkeypatch.setenv("VIDEO_DEPTH_PORT", "8123")

    args = parse_args(["--reload"])

    assert args.host == "0.0.0.0"
    assert args.port == 8123
    assert args.reload is True
