"""WebSocket interface streaming binary depth payloads."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import suppress

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends

from backend.models.depth_model import get_depth_model
from backend.utils.packets import pack_depth_payload
from backend.utils.depth_ops import downsample_depth
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
    # Queue for outgoing tasks (to preserve order)
    send_queue = asyncio.Queue()
    
    stop = asyncio.Event()
    active_tasks = set()
    
    stats = StatisticsCollector()

    async def receiver() -> None:
        try:
            while True:
                raw = await websocket.receive_text()
                data = json.loads(raw)
                data["_recv_time"] = time.perf_counter()
                
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
    
    # Queue for incoming requests
    request_queue = DroppingQueue(maxsize=32)
    # Queue for outgoing tasks (to preserve order)
    send_queue = asyncio.Queue()
    
    stop = asyncio.Event()
    active_tasks = set()
    
    stats = StatisticsCollector()

    async def process_request_pipeline(request: dict, session) -> tuple[bytes | None, dict[str, float]]:
        """Full pipeline: Decode -> Infer -> Pack."""
        time_ms = float(request.get("time_ms", 0.0))
        recv_time = request.get("_recv_time", time.perf_counter())
        queue_wait_s = time.perf_counter() - recv_time
        
        stats.add("queue_wait_s", queue_wait_s)
        
        timings: dict[str, float] = {
            "queue_wait_s": queue_wait_s,
        }
        total_start = time.perf_counter()

        # Cache Check
        cached = await session.get_cached_depth(time_ms, drop_on_hit=True)
        if cached:
            pack_start = time.perf_counter()
            payload = pack_depth_payload(
                cached.depth.copy(),
                cached.timestamp_ms,
                cached.z_min,
                cached.z_max,
                compress=settings.depth_compression_level > 0
            )
            pack_s = time.perf_counter() - pack_start
            stats.add("pack_s", pack_s)
            
            timings["pack_s"] = pack_s
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
        except StopIteration:
            # EOF
            return None, timings
        except Exception as e:
            logger.error(f"Decode error: {e}")
            return None, timings

        # Infer
        infer_start = time.perf_counter()
        inflight_estimate = model.inflight_count + 1
        process_res = int(session.telemetry.get("quality_process_res", settings.depth_process_res))
        
        # Calculate target size based on downsample factor
        downsample_factor = settings.depth_downsample_factor
        target_size = None
        if downsample_factor > 1:
            # frame is (H, W, C), target_size expects (W, H)
            h, w = frame.shape[:2]
            target_w = max(1, w // downsample_factor)
            target_h = max(1, h // downsample_factor)
            target_size = (target_w, target_h)

        prediction = await model.infer_depth_async(frame, process_res=process_res, target_size=target_size)
        infer_s = time.perf_counter() - infer_start
        stats.add("infer_s", infer_s)
        
        timings["infer_s"] = infer_s
        timings["inflight_used"] = float(inflight_estimate)
        
        depth_map = prediction.depth
        # Downsampling is now handled inside infer_depth via target_size
        # if downsample_factor > 1:
        #     depth_map = downsample_depth(depth_map, downsample_factor)
        
        frame_time_ms = frame_info.time_ms if frame_info.time_ms >= 0 else time_ms
        cached_frame = DepthFrame(
            timestamp_ms=frame_time_ms,
            depth=depth_map,
            z_min=prediction.z_min,
            z_max=prediction.z_max,
        )
        await session.store_depth_frame(cached_frame)

        # Pack
        pack_start = time.perf_counter()
        payload = pack_depth_payload(
            cached_frame.depth.copy(),
            cached_frame.timestamp_ms,
            cached_frame.z_min,
            cached_frame.z_max,
            compress=settings.depth_compression_level > 0
        )
        pack_s = time.perf_counter() - pack_start
        stats.add("pack_s", pack_s)
        
        timings["pack_s"] = pack_s
        timings["total_s"] = time.perf_counter() - total_start
        stats.add("total_s", timings["total_s"])
        
        await session.update_telemetry(timings)
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
            
            for key in ["decode_s", "infer_s", "pack_s", "ws_send_s", "queue_wait_s"]:
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
                
                if stop_task in done:
                    get_task.cancel()
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

                # Extract RTT if present
                if "rtt" in request:
                    await session.update_telemetry({"latency_ms": float(request["rtt"])})

                # Concurrency Control
                MAX_CONCURRENT_TASKS = 16
                if len(active_tasks) >= MAX_CONCURRENT_TASKS:
                    done, pending = await asyncio.wait(active_tasks, return_when=asyncio.FIRST_COMPLETED)
                
                task = asyncio.create_task(process_request_pipeline(request, session))
                active_tasks.add(task)
                task.add_done_callback(active_tasks.discard)
                
                await send_queue.put(task)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.exception("Processor error: %s", exc)
                stop.set()

    async def sender() -> None:
        """Sends results back to client in order."""
        while not stop.is_set():
            try:
                get_task = asyncio.create_task(send_queue.get())
                stop_task = asyncio.create_task(stop.wait())
                done, _ = await asyncio.wait([get_task, stop_task], return_when=asyncio.FIRST_COMPLETED)
                
                if stop_task in done:
                    get_task.cancel()
                    break
                    
                task = get_task.result()
                
                # Await the result (enforcing order)
                result = await task
                if result is None:
                    continue
                    
                payload_bytes, timings = result
                
                if payload_bytes:
                    send_start = time.perf_counter()
                    try:
                        await websocket.send_bytes(payload_bytes)
                        ws_send_s = time.perf_counter() - send_start
                        stats.add("ws_send_s", ws_send_s)
                        timings["ws_send_s"] = ws_send_s
                        
                        if settings.profile_depth_timing:
                             profile_logger.info(
                                "depth_timing session=%s time_ms=%.1f decode=%.3f infer=%.3f pack=%.3f send=%.3f queue=%.3f total=%.3f inflight=%d",
                                session_id,
                                0.0, 
                                timings.get("decode_s", 0.0),
                                timings.get("infer_s", 0.0),
                                timings.get("pack_s", 0.0),
                                timings.get("ws_send_s", 0.0),
                                timings.get("queue_wait_s", 0.0),
                                timings.get("total_s", 0.0),
                                int(timings.get("inflight_used", 0)),
                            )
                    except Exception:
                        break # Socket closed
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
