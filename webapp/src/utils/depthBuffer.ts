import type { DepthFrame } from '../types';

export class DepthBuffer {
    private frames: DepthFrame[] = [];
    private requested = new Map<number, number>(); // timestamp -> requestTime
    private readonly toleranceMs = 33; // Match frame duration roughly

    add(frame: DepthFrame) {
        // Remove from requested set
        this.requested.delete(frame.timestampMs);

        // Insert into sorted frames
        // Binary search for insertion point could be faster, but array is small (buffer size ~100)
        // Linear scan from end is likely fast enough as frames arrive mostly in order
        if (this.frames.length === 0 || frame.timestampMs >= this.frames[this.frames.length - 1].timestampMs) {
            this.frames.push(frame);
        } else {
            const idx = this.frames.findIndex(f => f.timestampMs > frame.timestampMs);
            if (idx === -1) {
                this.frames.push(frame);
            } else {
                this.frames.splice(idx, 0, frame);
            }
        }
    }

    getFrame(timeMs: number): DepthFrame | null {
        // Find frame closest to timeMs within tolerance
        // We assume frames are sorted.
        // We can remove frames significantly older than timeMs to keep buffer small.

        let bestFrame: DepthFrame | null = null;
        let minDiff = Number.MAX_VALUE;
        let pruneIdx = -1;

        for (let i = 0; i < this.frames.length; i++) {
            const frame = this.frames[i];
            const diff = Math.abs(frame.timestampMs - timeMs);

            if (frame.timestampMs < timeMs - 1000) {
                // Frame is very old (> 1s), mark for pruning
                pruneIdx = i;
            }

            if (diff < minDiff && diff <= this.toleranceMs) {
                minDiff = diff;
                bestFrame = frame;
            }

            // Optimization: if we passed timeMs by a lot, stop
            if (frame.timestampMs > timeMs + this.toleranceMs) {
                break;
            }
        }

        // Prune old frames
        if (pruneIdx >= 0) {
            this.frames.splice(0, pruneIdx + 1);
        }

        return bestFrame;
    }

    getMissing(startMs: number, endMs: number, stepMs: number, timeoutMs: number): number[] {
        const missing: number[] = [];
        const now = performance.now();
        // Align startMs to stepMs grid to avoid jitter
        // e.g. if step is 33ms, align to 0, 33, 66...
        // But video start might not be 0.
        // Let's just step from startMs.

        for (let t = startMs; t <= endMs; t += stepMs) {
            // Check if we have this frame
            const inBuffer = this.frames.some(f => Math.abs(f.timestampMs - t) < stepMs * 0.5);
            if (inBuffer) continue;

            // Check if requested
            if (this.requested.has(t)) {
                const reqTime = this.requested.get(t)!;
                if (now - reqTime < timeoutMs) {
                    // Still pending and not timed out
                    continue;
                }
                // Timed out, re-request
            }

            missing.push(t);
            this.requested.set(t, now); // Mark as requested immediately
        }
        return missing;
    }

    cleanup(currentTimeMs: number) {
        // Remove requested timestamps that are too old (relative to video time)
        // This handles dropped packets
        for (const [t, _] of this.requested) {
            if (t < currentTimeMs - 2000) {
                this.requested.delete(t);
            }
        }
    }

    get bufferSize() {
        return this.frames.length;
    }

    get requestedSize() {
        return this.requested.size;
    }

    clear(): void {
        this.frames = [];
        this.requested.clear();
    }
}
