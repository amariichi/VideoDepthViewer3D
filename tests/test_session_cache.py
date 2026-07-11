from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.video.session import SessionManager


@pytest.mark.asyncio
async def test_clear_cache_removes_only_configured_test_root(tmp_path) -> None:
    data_root = tmp_path / "sessions"
    session_dir = data_root / "one"
    session_dir.mkdir(parents=True)
    (session_dir / "source.mp4").write_bytes(b"fixture")

    manager = SessionManager()
    manager.settings = SimpleNamespace(
        data_root=data_root,
        clear_cache_override=True,
    )
    await manager.clear_cache()

    assert data_root.is_dir()
    assert list(data_root.iterdir()) == []


@pytest.mark.asyncio
async def test_clear_cache_skips_custom_root_without_override(tmp_path) -> None:
    data_root = tmp_path / "custom-sessions"
    session_dir = data_root / "one"
    session_dir.mkdir(parents=True)
    source = session_dir / "source.mp4"
    source.write_bytes(b"fixture")

    manager = SessionManager()
    manager.settings = SimpleNamespace(
        data_root=data_root,
        clear_cache_override=False,
    )
    await manager.clear_cache()

    assert source.read_bytes() == b"fixture"
