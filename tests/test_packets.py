from __future__ import annotations

import struct
import zlib

import numpy as np

from backend.utils.packets import (
    HEADER_SIZE,
    HEADER_STRUCT,
    pack_depth_payload,
    quantize_depth,
    quantize_depth_log8,
)


def test_quantize_depth_round_trip_error_is_bounded() -> None:
    source = np.linspace(0.5, 8.5, 1024, dtype=np.float32).reshape(32, 32)
    encoded, scale, bias = quantize_depth(source.copy(), 0.5, 8.5)
    decoded = encoded.astype(np.float32) * scale + bias

    assert encoded.dtype == np.dtype("<u2")
    assert np.max(np.abs(decoded - source)) <= scale / 2 + 1e-6


def test_quantize_depth_clips_only_to_requested_range() -> None:
    source = np.array([[-2.0, 1.0, 3.0, 9.0]], dtype=np.float32)
    encoded, scale, bias = quantize_depth(source.copy(), 1.0, 3.0)
    decoded = encoded.astype(np.float32) * scale + bias

    np.testing.assert_allclose(decoded[[0], [0, 1]], [1.0, 1.0], atol=scale)
    np.testing.assert_allclose(decoded[[0], [2, 3]], [3.0, 3.0], atol=scale)


def test_pack_depth_payload_uncompressed_header_and_body() -> None:
    depth = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
    payload = pack_depth_payload(depth.copy(), 1234.9, 1.0, 4.0, compress=False)
    magic, version, data_type, timestamp, width, height, scale, bias, z_max = (
        HEADER_STRUCT.unpack_from(payload.buffer)
    )

    assert HEADER_SIZE == struct.calcsize("<4sHHIIIfff")
    assert (magic, version, data_type) == (b"VDZ1", 1, 1)
    assert (timestamp, width, height) == (1234, 2, 2)
    assert (bias, z_max) == (1.0, 4.0)
    samples = np.frombuffer(payload.buffer, dtype="<u2", offset=HEADER_SIZE)
    decoded = samples.astype(np.float32).reshape(2, 2) * scale + bias
    np.testing.assert_allclose(decoded, depth, atol=scale)


def test_pack_depth_payload_compressed_body_round_trip() -> None:
    depth = np.arange(12, dtype=np.float32).reshape(3, 4)
    payload = pack_depth_payload(depth.copy(), 50.0, 0.0, 11.0, compress=True)
    header = HEADER_STRUCT.unpack_from(payload.buffer)
    raw = zlib.decompress(payload.buffer[HEADER_SIZE:])

    assert header[0] == b"VDZ2"
    assert header[4:6] == (4, 3)
    assert np.frombuffer(raw, dtype="<u2").size == depth.size


def test_pack_depth_payload_uses_requested_compression_level(monkeypatch) -> None:
    depth = np.arange(64, dtype=np.float32).reshape(8, 8)
    original_compress = zlib.compress
    observed_levels: list[int] = []

    def record_level(data: bytes, level: int = -1) -> bytes:
        observed_levels.append(level)
        return original_compress(data, level=level)

    monkeypatch.setattr("backend.utils.packets.zlib.compress", record_level)

    payload = pack_depth_payload(
        depth.copy(),
        50.0,
        0.0,
        63.0,
        compress=True,
        compression_level=7,
    )

    assert observed_levels == [7]
    assert HEADER_STRUCT.unpack_from(payload.buffer)[0] == b"VDZ2"
    assert np.frombuffer(zlib.decompress(payload.buffer[HEADER_SIZE:]), dtype="<u2").size == depth.size


def test_log8_quantization_has_bounded_relative_error() -> None:
    source = np.geomspace(0.5, 50.0, 4096, dtype=np.float32).reshape(64, 64)
    encoded, scale, bias = quantize_depth_log8(source.copy(), 0.5, 50.0)
    decoded = np.exp(encoded.astype(np.float32) * scale + bias)
    relative_error = np.abs(decoded - source) / source

    assert encoded.dtype == np.uint8
    assert np.max(relative_error) <= np.expm1(scale / 2) + 1e-6


def test_log8_packet_is_half_the_depth_body_size() -> None:
    depth = np.geomspace(0.5, 50.0, 1024, dtype=np.float32).reshape(32, 32)
    linear = pack_depth_payload(
        depth.copy(),
        100,
        0.5,
        50,
        compress=False,
        encoding="linear16",
    )
    log8 = pack_depth_payload(
        depth.copy(),
        100,
        0.5,
        50,
        compress=False,
        encoding="log8",
    )
    header = HEADER_STRUCT.unpack_from(log8.buffer)
    samples = np.frombuffer(log8.buffer, dtype=np.uint8, offset=HEADER_SIZE)
    decoded = np.exp(samples.astype(np.float32) * header[6] + header[7])

    assert header[:3] == (b"VDZ3", 2, 2)
    assert len(log8.buffer) - HEADER_SIZE == (len(linear.buffer) - HEADER_SIZE) // 2
    np.testing.assert_allclose(decoded.reshape(depth.shape), depth, rtol=0.01)
