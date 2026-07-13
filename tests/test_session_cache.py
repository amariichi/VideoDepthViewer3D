from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from backend.video import session as session_module
from backend.video.session import InvalidVideoError
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


@pytest.mark.asyncio
async def test_invalid_replacement_preserves_current_session(
    tmp_path, monkeypatch
) -> None:
    data_root = tmp_path / "sessions"
    data_root.mkdir()
    old_session = SimpleNamespace(session_id="old-session")

    class InvalidDecoderPool:
        def __init__(self, *_args, **_kwargs) -> None:
            raise OSError("not a video")

    monkeypatch.setattr(session_module, "DecoderPool", InvalidDecoderPool)
    manager = SessionManager()
    manager.settings = SimpleNamespace(
        data_root=data_root,
        decoder_worker_count=1,
        clear_cache_override=True,
    )
    manager._sessions = {old_session.session_id: old_session}
    manager._current_session_id = old_session.session_id
    class InvalidUpload:
        filename = "broken.mov"
        content_type = "video/quicktime"

        def __init__(self) -> None:
            self._sent = False

        async def read(self, _size: int) -> bytes:
            if self._sent:
                return b""
            self._sent = True
            return b"invalid"

    upload = InvalidUpload()

    with pytest.raises(InvalidVideoError):
        await manager.create_session(upload)

    assert await manager.current() is old_session
    assert list(data_root.iterdir()) == []


@pytest.mark.asyncio
async def test_cancelled_upload_removes_partial_file_and_preserves_current_session(
    tmp_path,
) -> None:
    data_root = tmp_path / "sessions"
    data_root.mkdir()
    old_session = SimpleNamespace(session_id="old-session")

    class CancelledUpload:
        filename = "cancelled.mov"
        content_type = "video/quicktime"

        def __init__(self) -> None:
            self._reads = 0

        async def read(self, _size: int) -> bytes:
            self._reads += 1
            if self._reads == 1:
                return b"partial"
            raise asyncio.CancelledError

    manager = SessionManager()
    manager.settings = SimpleNamespace(
        data_root=data_root,
        decoder_worker_count=1,
        clear_cache_override=True,
    )
    manager._sessions = {old_session.session_id: old_session}
    manager._current_session_id = old_session.session_id

    with pytest.raises(asyncio.CancelledError):
        await manager.create_session(CancelledUpload())

    assert await manager.current() is old_session
    assert list(data_root.iterdir()) == []


@pytest.mark.asyncio
async def test_valid_replacement_is_published_and_disposes_previous_session(
    tmp_path, monkeypatch
) -> None:
    class MemoryUpload:
        content_type = "video/mp4"

        def __init__(self, filename: str, data: bytes) -> None:
            self.filename = filename
            self._data = data

        async def read(self, _size: int) -> bytes:
            data, self._data = self._data, b""
            return data

    class FakeDecoderPool:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def metadata(self) -> SimpleNamespace:
            return SimpleNamespace()

        def close(self) -> None:
            pass

    class FakeSession:
        def __init__(self, **values) -> None:
            self.__dict__.update(values)
            self.closed = False

        async def close(self) -> None:
            self.closed = True

    monkeypatch.setattr(session_module, "DecoderPool", FakeDecoderPool)
    monkeypatch.setattr(session_module, "VideoSession", FakeSession)
    data_root = tmp_path / "sessions"
    manager = SessionManager()
    manager.settings = SimpleNamespace(
        data_root=data_root,
        decoder_worker_count=1,
        clear_cache_override=True,
    )

    first = await manager.create_session(MemoryUpload("first.mp4", b"first"))
    first_dir = first.source_path.parent
    second = await manager.create_session(MemoryUpload("second.mp4", b"second"))

    assert await manager.current() is second
    assert first.closed is True
    assert first_dir.exists() is False
    assert second.source_name == "second.mp4"
    await manager.clear_cache()
