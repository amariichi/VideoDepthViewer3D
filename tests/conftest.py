from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from scripts.generate_test_media import generate_profile


@pytest.fixture(scope="session")
def fast_media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Generate the small deterministic media profile once per test run."""

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        pytest.skip("ffmpeg and ffprobe are required for media integration tests")
    output_root = tmp_path_factory.mktemp("test-media")
    profile_dir, manifest = generate_profile("fast", output_root)
    failed = [
        case["name"]
        for case in manifest["cases"]
        if case["required"] and case["status"] != "generated"
    ]
    assert not failed, f"Required generated media failed: {failed}"
    return profile_dir
