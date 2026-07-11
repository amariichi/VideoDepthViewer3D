"""WebSocket interface streaming binary depth payloads."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import suppress

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends

from backend.models.depth_model import get_depth_model
from backend.utils.calibration import normalize_frame_for_display
from backend.utils.depth_ops import calculate_depth_target_size
from backend.utils.packets import pack_depth_payload
from backend.video.io import EndOfStreamError
from backend.video.session import DepthFrame, get_session_manager, SessionManager
from backend.config import get_settings
from backend.utils.queues import DroppingQueue
from backend.utils.stats import StatisticsCollector

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sessions", tags=["stream"])
profile_logger = logging.getLogger("uvicorn.error")


@router.websocket("/{session_id}/stream")
async def depth_stream(
    websocket: WebSocket,
    session_id: str,
    manager: SessionManager = Depends(get_session_manager),
) -> None:
    await websocket.accept()
    session = await manager.get(session_id)
    if not session:
        await websocket.close(code=1008)
        return

    logger.info(f"Depth stream connected: {session_id}")
    model = get_depth_model()
    settings = get_settings()
    
    # Queue for incoming requests
    request_queue = DroppingQueue(maxsize=32)
    # Completed pipelines are queued in completion order. The browser buffers
    # by timestamp, so a slow decode/inference must not hold back later frames
    # that are already ready to display.
    send_queue: asyncio.Queue[asyncio.Task[tuple[bytes | None, dict[str, float]]]] = (
        asyncio.Queue()
    )
    
    stop = asyncio.Event()
    active_tasks = set()
    
    stats = StatisticsCollector()

    async def cancel_pending(*tasks: asyncio.Task) -> None:
        pending = [task for task in tasks if task is not None and not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            with suppress(Exception):
                await asyncio.gather(*pending, return_exceptions=True)

    async def receiver() -> None:
        try:
            while True:
                raw = await websocket.receive_text()
                data = json.loads(raw)
                data["_recv_time"] = time.perf_counter()

                if "performance_mode" in data:
                    await session.set_performance_mode(data["performance_mode"])
                if "rtt" in data:
                    await session.update_telemetry({"latency_ms": float(data["rtt"])})
                if "applied_fps" in data:
                    await session.update_telemetry(
                        {"client_fps": max(float(data["applied_fps"]), 0.0)}
                    )
                
                # If client sends a time_ms request
                if "time_ms" in data:
                    request_queue.put_nowait(data)
                    
        except WebSocketDisconnect:
            stop.set()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            stop.set()
            logger.exception("Receiver error: %s", exc)
    
    async def process_request_pipeline(request: dict, session) -> tuple[bytes | None, dict[str, float]]:
        """Full pipeline: Decode -> Infer -> Pack."""
        time_ms = float(request.get("time_ms", 0.0))
        recv_time = request.get("_recv_time", time.perf_counter())
        queue_wait_s = time.perf_counter() - recv_time
        
        stats.add("queue_wait_s", queue_wait_s)
        
        timings: dict[str, float] = {
            "queue_wait_s": queue_wait_s,
            "request_time_ms": time_ms,
        }
        total_start = time.perf_counter()
        quality = session.quality_controller.state
        depth_encoding = quality.encoding

        # Cache Check
        cached = await session.get_cached_depth(time_ms, drop_on_hit=True)
        if cached:
            pack_start = time.perf_counter()
            payload = pack_depth_payload(
                cached.depth.copy(),
                cached.timestamp_ms,
                cached.z_min,
                cached.z_max,
                compress=settings.depth_compression_level > 0,
                compression_level=settings.depth_compression_level,
                encoding=depth_encoding,
            )
            pack_s = time.perf_counter() - pack_start
            stats.add("pack_s", pack_s)
            
            timings["pack_s"] = pack_s
            timings["payload_bytes"] = float(len(payload.buffer))
            timings["frame_time_ms"] = cached.timestamp_ms
            timings["total_s"] = time.perf_counter() - total_start
            stats.add("total_s", timings["total_s"])
            
            await session.update_telemetry(timings)
            return payload.buffer, timings

        # Decode (Parallel via DecoderPool)
        try:
            decode_start = time.perf_counter()
            frame, frame_info = await asyncio.to_thread(session.decoder.decode_at, time_ms)
            decode_s = time.perf_counter() - decode_start
            stats.add("decode_s", decode_s)
            
            timings["decode_s"] = decode_s
            # print(f"[Backend] Processing: {time_ms}ms. QueueWait: {timings['queue_wait_s']:.3f}s. Decode: {timings['decode_s']:.3f}s")
        except EndOfStreamError:
            # EOF
            return None, timings
        except Exception as e:
            logger.error(f"Decode error: {e}")
            return None, timings

        # Normalize decoded coded pixels into the same square-pixel display
        # coordinates used by the browser video texture. Rotation and SAR are
        # session metadata, so RGB and depth share one stable UV mapping.
        normalize_start = time.perf_counter()
        frame = normalize_frame_for_display(frame, session.calibration)
        normalize_s = time.perf_counter() - normalize_start
        stats.add("normalize_s", normalize_s)
        timings["normalize_s"] = normalize_s

        # Infer
        inflight_estimate = model.inflight_count + 1
        process_res = quality.process_res
        
        # Calculate target size based on downsample factor
        downsample_factor = quality.downsample_factor
        # Do not upsample a low-resolution inference result merely because the
        # source RGB is 2K/4K. RGB remains native in the browser; transported
        # depth is capped by both downsampling policy and process resolution.
        h, w = frame.shape[:2]
        target_size = calculate_depth_target_size(
            w,
            h,
            process_res,
            downsample_factor,
        )

        inference = await model.infer_depth_async(
            frame,
            process_res=process_res,
            target_size=target_size,
            calibration=session.calibration,
        )
        prediction = inference.prediction
        infer_s = inference.execution_s
        stats.add("infer_s", infer_s)
        stats.add("infer_wait_s", inference.slot_wait_s)
        
        timings["infer_s"] = infer_s
        timings["infer_wait_s"] = inference.slot_wait_s
        timings["inflight_used"] = float(inflight_estimate)
        timings["cold_start"] = float(inference.cold_start)
        
        depth_map = prediction.depth
        # Downsampling is now handled inside infer_depth via target_size
        # if downsample_factor > 1:
        #     depth_map = downsample_depth(depth_map, downsample_factor)
        
        frame_time_ms = frame_info.time_ms if frame_info.time_ms >= 0 else time_ms
        stable_min, stable_max = await session.stabilize_depth_range(
            prediction.z_min,
            prediction.z_max,
        )
        cached_frame = DepthFrame(
            timestamp_ms=frame_time_ms,
            depth=depth_map,
            z_min=stable_min,
            z_max=stable_max,
        )
        await session.store_depth_frame(cached_frame)

        # Pack
        pack_start = time.perf_counter()
        payload = pack_depth_payload(
            cached_frame.depth.copy(),
            cached_frame.timestamp_ms,
            cached_frame.z_min,
            cached_frame.z_max,
            compress=settings.depth_compression_level > 0,
            compression_level=settings.depth_compression_level,
            encoding=depth_encoding,
        )
        pack_s = time.perf_counter() - pack_start
        stats.add("pack_s", pack_s)
        
        timings["pack_s"] = pack_s
        timings["payload_bytes"] = float(len(payload.buffer))
        timings["frame_time_ms"] = cached_frame.timestamp_ms
        timings["total_s"] = time.perf_counter() - total_start
        stats.add("total_s", timings["total_s"])
        
        telemetry_timings = timings.copy()
        if inference.cold_start:
            # Model load and first-kernel warmup are startup costs, not a
            # steady-state signal for the adaptive resolution controller.
            telemetry_timings.pop("infer_s", None)
        await session.update_telemetry(telemetry_timings)
        return payload.buffer, timings

    async def stats_reporter():
        """Logs statistics every 5 seconds."""
        while not stop.is_set():
            await asyncio.sleep(5)
            snapshot = stats.get_snapshot_and_reset()
            if not snapshot:
                continue
            
            # Format log message
            msg_parts = ["[Stats Report]"]
            if "fps" in snapshot:
                msg_parts.append(f"FPS: {snapshot['fps']:.1f}")
            
            for key in [
                "decode_s",
                "infer_s",
                "infer_wait_s",
                "normalize_s",
                "pack_s",
                "ws_send_s",
                "queue_wait_s",
            ]:
                if key in snapshot:
                    d = snapshot[key]
                    msg_parts.append(f"{key}: avg={d['avg']:.3f} p95={d['p95']:.3f} max={d['max']:.3f}")
            
            if "request_queue_size" in snapshot:
                msg_parts.append(f"QSize: {snapshot['request_queue_size']}")
            if "active_tasks" in snapshot:
                msg_parts.append(f"Active: {snapshot['active_tasks']}")
            if "dropped_count" in snapshot:
                msg_parts.append(f"Drop: {snapshot['dropped_count']}")
                
            log_line = " | ".join(msg_parts)
            logger.info(log_line)
            
            # Write to file for analysis
            with open("backend_stats.txt", "a") as f:
                f.write(f"{time.time()}: {log_line}\n")

    async def processor() -> None:
        """Spawns pipeline tasks for each request."""
        while not stop.is_set():
            try:
                # Update gauge metrics
                stats.set_counter("request_queue_size", request_queue.qsize())
                stats.set_counter("active_tasks", len(active_tasks))
                
                get_task = asyncio.create_task(request_queue.get())
                stop_task = asyncio.create_task(stop.wait())
                done, _ = await asyncio.wait([get_task, stop_task], return_when=asyncio.FIRST_COMPLETED)
                await cancel_pending(get_task, stop_task)
                
                if stop_task in done:
                    break
                
                request = get_task.result()
                
                session = await manager.get(session_id)
                if not session:
                    await websocket.send_json({"type": "error", "message": "session not found"})
                    stop.set()
                    break

                # Report dropped requests
                dropped = request_queue.dropped_count
                if dropped > 0:
                    stats.increment("dropped_count", dropped)
                    await session.update_telemetry({"dropped": float(dropped)})
                    request_queue.reset_dropped_count()

                # Concurrency Control
                max_concurrent_tasks = max(
                    settings.inference_worker_count * 2,
                    settings.decoder_worker_count,
                )
                if len(active_tasks) >= max_concurrent_tasks:
                    done, pending = await asyncio.wait(active_tasks, return_when=asyncio.FIRST_COMPLETED)
                
                task = asyncio.create_task(process_request_pipeline(request, session))
                active_tasks.add(task)

                def queue_completed(
                    completed: asyncio.Task[tuple[bytes | None, dict[str, float]]],
                ) -> None:
                    active_tasks.discard(completed)
                    send_queue.put_nowait(completed)

                task.add_done_callback(queue_completed)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.exception("Processor error: %s", exc)
                stop.set()

    async def sender() -> None:
        """Send completed results without request-order head-of-line blocking."""
        while not stop.is_set():
            try:
                get_task = asyncio.create_task(send_queue.get())
                stop_task = asyncio.create_task(stop.wait())
                done, _ = await asyncio.wait([get_task, stop_task], return_when=asyncio.FIRST_COMPLETED)
                await cancel_pending(get_task, stop_task)
                
                if stop_task in done:
                    break
                    
                task = get_task.result()
                
                # The task is already complete; callbacks enqueue tasks in
                # completion order to avoid head-of-line blocking.
                result = await task
                if result is None:
                    continue
                    
                payload_bytes, timings = result
                
                try:
                    if payload_bytes:
                        send_start = time.perf_counter()
                        await websocket.send_bytes(payload_bytes)
                        ws_send_s = time.perf_counter() - send_start
                        stats.add("ws_send_s", ws_send_s)
                        timings["ws_send_s"] = ws_send_s
                        await session.update_telemetry(
                            {"ws_send_s": ws_send_s},
                            adjust_quality=True,
                        )
                        
                        if settings.profile_depth_timing:
                            profile_logger.info(
                                "depth_timing session=%s time_ms=%.1f decode=%.3f normalize=%.3f infer=%.3f pack=%.3f send=%.3f queue=%.3f total=%.3f inflight=%d",
                                session_id,
                                timings.get(
                                    "frame_time_ms",
                                    timings.get("request_time_ms", 0.0),
                                ),
                                timings.get("decode_s", 0.0),
                                timings.get("normalize_s", 0.0),
                                timings.get("infer_s", 0.0),
                                timings.get("pack_s", 0.0),
                                timings.get("ws_send_s", 0.0),
                                timings.get("queue_wait_s", 0.0),
                                timings.get("total_s", 0.0),
                                int(timings.get("inflight_used", 0)),
                            )
                    else:
                        # Keep the one-request/one-response flow-control contract
                        # for EOF or decode misses. The client can release the exact
                        # inflight slot immediately instead of waiting two seconds.
                        await websocket.send_json(
                            {
                                "type": "miss",
                                "time_ms": timings.get("request_time_ms", 0.0),
                            }
                        )
                except Exception:
                    stop.set()
                    break  # Socket closed
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.exception("Sender error: %s", exc)
                stop.set()

    receiver_task = asyncio.create_task(receiver())
    processor_task = asyncio.create_task(processor())
    sender_task = asyncio.create_task(sender())
    stats_task = asyncio.create_task(stats_reporter())
    
    try:
        await stop.wait()
    finally:
        receiver_task.cancel()
        processor_task.cancel()
        sender_task.cancel()
        stats_task.cancel()
        for task in active_tasks:
            task.cancel()
        with suppress(Exception):
            await asyncio.gather(receiver_task, processor_task, sender_task, stats_task, *active_tasks, return_exceptions=True)
