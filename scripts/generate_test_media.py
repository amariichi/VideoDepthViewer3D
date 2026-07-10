"""Generate deterministic video fixtures for tests and local benchmarks.

The generated files live under ``tmp/test-media`` by default and are therefore
not committed.  A JSON manifest records both the requested characteristics and
what ffprobe observed so tests never rely on a filename alone.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable


ENCODER_CODECS = {
    "libx264": "h264",
    "libx265": "hevc",
    "libvpx-vp9": "vp9",
    "libaom-av1": "av1",
}


@dataclass(frozen=True, slots=True)
class MediaCase:
    """One independently useful media characteristic to generate."""

    name: str
    width: int
    height: int
    source_fps: int
    duration_s: float
    encoder: str = "libx264"
    extension: str = "mp4"
    sar: str = "1:1"
    rotation_degrees: int | None = None
    variable_frame_rate: bool = False
    include_audio: bool = False
    required: bool = True
    tags: tuple[str, ...] = ()

    @property
    def codec(self) -> str:
        return ENCODER_CODECS[self.encoder]


def fast_cases() -> list[MediaCase]:
    """Small edge-case set intended for every pull request."""

    return [
        MediaCase(
            name="cfr_h264_320x180_30_audio",
            width=320,
            height=180,
            source_fps=30,
            duration_s=2.0,
            include_audio=True,
            tags=("baseline", "cfr", "audio", "bframes"),
        ),
        MediaCase(
            name="anamorphic_h264_720x480_30",
            width=720,
            height=480,
            source_fps=30,
            duration_s=2.0,
            sar="32:27",
            tags=("anamorphic", "sar", "dar-16-9"),
        ),
        MediaCase(
            name="portrait_h264_360x640_30",
            width=360,
            height=640,
            source_fps=30,
            duration_s=2.0,
            tags=("portrait",),
        ),
        MediaCase(
            name="rotated_h264_640x360_30",
            width=640,
            height=360,
            source_fps=30,
            duration_s=2.0,
            rotation_degrees=90,
            tags=("rotation-metadata", "display-matrix"),
        ),
        MediaCase(
            name="vfr_h264_640x360_bframes",
            width=640,
            height=360,
            source_fps=60,
            duration_s=2.0,
            variable_frame_rate=True,
            tags=("vfr", "bframes", "pts"),
        ),
    ]


def full_cases() -> list[MediaCase]:
    """Orthogonal resolution, frame-rate, and codec sweeps."""

    cases = fast_cases()

    for width, height in [
        (640, 360),
        (1280, 720),
        (1920, 1080),
        (2560, 1440),
        (3840, 2160),
    ]:
        cases.append(
            MediaCase(
                name=f"resolution_h264_{width}x{height}_30",
                width=width,
                height=height,
                source_fps=30,
                duration_s=1.0,
                tags=("resolution-sweep",),
            )
        )

    for fps in (24, 60):
        cases.append(
            MediaCase(
                name=f"fps_h264_1920x1080_{fps}",
                width=1920,
                height=1080,
                source_fps=fps,
                duration_s=1.0,
                tags=("fps-sweep",),
            )
        )

    for encoder, extension in [
        ("libx265", "mp4"),
        ("libvpx-vp9", "webm"),
        ("libaom-av1", "webm"),
    ]:
        cases.append(
            MediaCase(
                name=f"codec_{ENCODER_CODECS[encoder]}_1920x1080_30",
                width=1920,
                height=1080,
                source_fps=30,
                duration_s=1.0,
                encoder=encoder,
                extension=extension,
                required=False,
                tags=("codec-sweep", "optional-encoder"),
            )
        )

    return cases


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


def _tool_version(tool: str) -> str:
    result = _run([tool, "-version"])
    return result.stdout.splitlines()[0].strip()


def _available_encoders(ffmpeg: str) -> set[str]:
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-encoders"],
        check=True,
        capture_output=True,
        text=True,
    )
    encoders: set[str] = set()
    for line in (result.stdout + result.stderr).splitlines():
        match = re.match(r"^\s*[A-Z.]{6}\s+(\S+)", line)
        if match:
            encoders.add(match.group(1))
    return encoders


def _encoder_args(case: MediaCase) -> list[str]:
    gop = max(1, case.source_fps * 2)
    if case.encoder == "libx264":
        return [
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-g",
            str(gop),
            "-bf",
            "3" if case.variable_frame_rate else "2",
        ]
    if case.encoder == "libx265":
        return [
            "-c:v",
            "libx265",
            "-preset",
            "ultrafast",
            "-crf",
            "24",
            "-pix_fmt",
            "yuv420p",
            "-x265-params",
            "log-level=error",
        ]
    if case.encoder == "libvpx-vp9":
        return [
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-crf",
            "32",
            "-b:v",
            "0",
            "-row-mt",
            "1",
            "-pix_fmt",
            "yuv420p",
        ]
    if case.encoder == "libaom-av1":
        return [
            "-c:v",
            "libaom-av1",
            "-cpu-used",
            "8",
            "-crf",
            "36",
            "-b:v",
            "0",
            "-row-mt",
            "1",
            "-pix_fmt",
            "yuv420p",
        ]
    raise ValueError(f"Unsupported encoder configuration: {case.encoder}")


def _encode_command(ffmpeg: str, case: MediaCase, output: Path) -> list[str]:
    source = (
        f"testsrc2=size={case.width}x{case.height}:"
        f"rate={case.source_fps}:duration={case.duration_s:.6f}"
    )
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        source,
    ]
    if case.include_audio:
        command.extend(
            [
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency=880:sample_rate=48000:duration={case.duration_s:.6f}",
            ]
        )

    filters: list[str] = []
    if case.variable_frame_rate:
        filters.append("select='if(lt(t,1),not(mod(n,2)),not(mod(n,3)))'")
    if case.sar != "1:1":
        filters.append(f"setsar={case.sar.replace(':', '/')}")
    if filters:
        command.extend(["-vf", ",".join(filters)])
    if case.variable_frame_rate:
        command.extend(["-fps_mode", "vfr"])

    command.extend(_encoder_args(case))
    if case.include_audio:
        command.extend(["-c:a", "aac", "-b:a", "96k", "-shortest"])
    else:
        command.append("-an")
    command.append(str(output))
    return command


def _rotation_command(
    ffmpeg: str, source: Path, output: Path, rotation_degrees: int
) -> list[str]:
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-display_rotation",
        str(rotation_degrees),
        "-i",
        str(source),
        "-map",
        "0",
        "-c",
        "copy",
        str(output),
    ]


def _probe(ffprobe: str, path: Path) -> dict[str, Any]:
    result = _run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ]
    )
    raw = json.loads(result.stdout)
    streams = raw.get("streams", [])
    video = next(stream for stream in streams if stream.get("codec_type") == "video")
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
    rotation = None
    for side_data in video.get("side_data_list", []):
        if side_data.get("side_data_type") == "Display Matrix":
            rotation = side_data.get("rotation")
            break
    format_info = raw.get("format", {})
    return {
        "codec": video.get("codec_name"),
        "profile": video.get("profile"),
        "width": video.get("width"),
        "height": video.get("height"),
        "pixel_format": video.get("pix_fmt"),
        "sample_aspect_ratio": video.get("sample_aspect_ratio"),
        "display_aspect_ratio": video.get("display_aspect_ratio"),
        "r_frame_rate": video.get("r_frame_rate"),
        "avg_frame_rate": video.get("avg_frame_rate"),
        "duration_s": _float_or_none(video.get("duration") or format_info.get("duration")),
        "frame_count": _int_or_none(video.get("nb_frames")),
        "has_b_frames": video.get("has_b_frames"),
        "rotation_degrees": rotation,
        "audio_codecs": [stream.get("codec_name") for stream in audio],
        "format_name": format_info.get("format_name"),
        "size_bytes": _int_or_none(format_info.get("size")),
        "bit_rate": _int_or_none(format_info.get("bit_rate")),
    }


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _fraction(value: str | None) -> Fraction | None:
    if not value or value == "0/0":
        return None
    try:
        return Fraction(value)
    except (ValueError, ZeroDivisionError):
        return None


def _display_aspect(case: MediaCase) -> str:
    sar = Fraction(case.sar.replace(":", "/"))
    dar = Fraction(case.width, case.height) * sar
    return f"{dar.numerator}:{dar.denominator}"


def _expected(case: MediaCase) -> dict[str, Any]:
    return {
        "codec": case.codec,
        "width": case.width,
        "height": case.height,
        "source_fps": case.source_fps,
        "duration_s": case.duration_s,
        "sample_aspect_ratio": case.sar,
        "display_aspect_ratio": _display_aspect(case),
        "rotation_degrees": case.rotation_degrees,
        "variable_frame_rate": case.variable_frame_rate,
        "has_audio": case.include_audio,
    }


def _validation_errors(case: MediaCase, probed: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    expected = _expected(case)
    for key in ("codec", "width", "height", "sample_aspect_ratio"):
        if probed.get(key) != expected[key]:
            errors.append(f"{key}: expected {expected[key]!r}, got {probed.get(key)!r}")

    if case.rotation_degrees is not None:
        actual_rotation = probed.get("rotation_degrees")
        if actual_rotation is None or abs(int(actual_rotation)) != abs(case.rotation_degrees):
            errors.append(
                f"rotation_degrees: expected {case.rotation_degrees}, got {actual_rotation}"
            )

    has_audio = bool(probed.get("audio_codecs"))
    if has_audio != case.include_audio:
        errors.append(f"has_audio: expected {case.include_audio}, got {has_audio}")

    duration = probed.get("duration_s")
    if duration is None or abs(duration - case.duration_s) > 0.25:
        errors.append(f"duration_s: expected about {case.duration_s}, got {duration}")

    avg_rate = _fraction(probed.get("avg_frame_rate"))
    real_rate = _fraction(probed.get("r_frame_rate"))
    if case.variable_frame_rate:
        if avg_rate is None or real_rate is None or avg_rate == real_rate:
            errors.append(
                "variable_frame_rate: expected differing avg_frame_rate and r_frame_rate"
            )
    elif avg_rate is None or abs(float(avg_rate) - case.source_fps) > 0.01:
        errors.append(
            f"avg_frame_rate: expected {case.source_fps}, got {probed.get('avg_frame_rate')}"
        )
    return errors


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _clean_owned_temporary_files(profile_dir: Path, case: MediaCase) -> None:
    for suffix in (".encoded.part", ".part"):
        candidate = profile_dir / f"{case.name}{suffix}.{case.extension}"
        candidate.unlink(missing_ok=True)


def generate_case(
    ffmpeg: str,
    ffprobe: str,
    profile_dir: Path,
    case: MediaCase,
) -> dict[str, Any]:
    """Generate one case atomically and return its manifest record."""

    final_path = profile_dir / f"{case.name}.{case.extension}"
    encoded_part = profile_dir / f"{case.name}.encoded.part.{case.extension}"
    final_part = profile_dir / f"{case.name}.part.{case.extension}"
    _clean_owned_temporary_files(profile_dir, case)

    encode_target = encoded_part if case.rotation_degrees is not None else final_part
    try:
        encode_command = _encode_command(ffmpeg, case, encode_target)
        _run(encode_command)
        commands = [encode_command]
        if case.rotation_degrees is not None:
            rotation_command = _rotation_command(
                ffmpeg, encoded_part, final_part, case.rotation_degrees
            )
            _run(rotation_command)
            commands.append(rotation_command)
        os.replace(final_part, final_path)
        probed = _probe(ffprobe, final_path)
        errors = _validation_errors(case, probed)
        return {
            "name": case.name,
            "status": "generated" if not errors else "failed_validation",
            "required": case.required,
            "path": final_path.name,
            "tags": list(case.tags),
            "expected": _expected(case),
            "probed": probed,
            "sha256": _sha256(final_path),
            "commands": commands,
            "validation_errors": errors,
        }
    except subprocess.CalledProcessError as exc:
        final_part.unlink(missing_ok=True)
        final_path.unlink(missing_ok=True)
        return {
            "name": case.name,
            "status": "failed_generation",
            "required": case.required,
            "path": final_path.name,
            "tags": list(case.tags),
            "expected": _expected(case),
            "error": (exc.stderr or exc.stdout or str(exc)).strip(),
        }
    finally:
        encoded_part.unlink(missing_ok=True)


def _manifest_path(profile_dir: Path) -> Path:
    return profile_dir / "manifest.json"


def write_manifest(profile_dir: Path, manifest: dict[str, Any]) -> None:
    target = _manifest_path(profile_dir)
    temporary = profile_dir / "manifest.part.json"
    temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, target)


def _resolve_tool(name_or_path: str) -> str:
    resolved = shutil.which(name_or_path)
    if resolved is None:
        raise FileNotFoundError(f"Required executable not found: {name_or_path}")
    return resolved


def generate_profile(
    profile: str,
    output_root: Path,
    ffmpeg_name: str = "ffmpeg",
    ffprobe_name: str = "ffprobe",
) -> tuple[Path, dict[str, Any]]:
    ffmpeg = _resolve_tool(ffmpeg_name)
    ffprobe = _resolve_tool(ffprobe_name)
    encoders = _available_encoders(ffmpeg)
    cases = fast_cases() if profile == "fast" else full_cases()
    profile_dir = output_root / profile
    profile_dir.mkdir(parents=True, exist_ok=True)

    records: list[dict[str, Any]] = []
    for case in cases:
        if case.encoder not in encoders:
            records.append(
                {
                    "name": case.name,
                    "status": "missing_encoder" if case.required else "skipped",
                    "required": case.required,
                    "path": f"{case.name}.{case.extension}",
                    "tags": list(case.tags),
                    "expected": _expected(case),
                    "error": f"Encoder {case.encoder} is unavailable",
                }
            )
            continue
        records.append(generate_case(ffmpeg, ffprobe, profile_dir, case))

    manifest = {
        "schema_version": 1,
        "profile": profile,
        "generator": {
            "script": "scripts/generate_test_media.py",
            "ffmpeg": _tool_version(ffmpeg),
            "ffprobe": _tool_version(ffprobe),
        },
        "cases": records,
    }
    write_manifest(profile_dir, manifest)
    return profile_dir, manifest


def _failed_required_cases(records: Iterable[dict[str, Any]]) -> list[str]:
    return [
        str(record["name"])
        for record in records
        if record.get("required") and record.get("status") != "generated"
    ]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("fast", "full"), default="fast")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("tmp/test-media"),
        help="Root directory; the profile name is appended (default: tmp/test-media)",
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        profile_dir, manifest = generate_profile(
            profile=args.profile,
            output_root=args.output,
            ffmpeg_name=args.ffmpeg,
            ffprobe_name=args.ffprobe,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    failed = _failed_required_cases(manifest["cases"])
    generated = sum(record["status"] == "generated" for record in manifest["cases"])
    skipped = sum(record["status"] == "skipped" for record in manifest["cases"])
    print(
        f"Generated {generated} case(s), skipped {skipped}; "
        f"manifest: {_manifest_path(profile_dir)}"
    )
    if failed:
        print(f"Required cases failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    if generated == 0:
        print("No media cases were generated", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
