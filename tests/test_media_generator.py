from __future__ import annotations

import json
from pathlib import Path

from scripts.generate_test_media import fast_cases, full_cases, generate_profile


def test_profiles_cover_independent_risk_dimensions() -> None:
    fast = fast_cases()
    full = full_cases()

    assert {case.name for case in fast} <= {case.name for case in full}
    assert any(case.sar == "32:27" for case in fast)
    assert any(case.rotation_degrees == 90 for case in fast)
    assert any(case.variable_frame_rate for case in fast)
    assert any(case.width == 3840 and case.height == 2160 for case in full)
    assert {case.codec for case in full} >= {"h264", "hevc", "vp9", "av1"}


def test_fast_manifest_matches_generated_files(fast_media_dir: Path) -> None:
    manifest = json.loads((fast_media_dir / "manifest.json").read_text())

    assert manifest["schema_version"] == 1
    assert manifest["profile"] == "fast"
    assert len(manifest["cases"]) == len(fast_cases())
    assert all(case["status"] == "generated" for case in manifest["cases"])
    for case in manifest["cases"]:
        path = fast_media_dir / case["path"]
        assert path.is_file()
        assert path.stat().st_size == case["probed"]["size_bytes"]
        assert not case["validation_errors"]


def test_fast_generation_is_idempotent(tmp_path: Path) -> None:
    first_dir, first = generate_profile("fast", tmp_path)
    second_dir, second = generate_profile("fast", tmp_path)

    assert first_dir == second_dir
    assert [case["name"] for case in first["cases"]] == [
        case["name"] for case in second["cases"]
    ]
    assert all(case["status"] == "generated" for case in second["cases"])
    assert not list(second_dir.glob("*.part.*"))
