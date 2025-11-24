import type { DepthStatus, PerfSettings } from '../types';

export class DepthSyncController {
    private intervalId: number | null = null;
    private sessionId: string | null = null;
    private getState: () => { perfSettings: PerfSettings };
    private updatePerfSettings: (settings: Partial<PerfSettings>) => void;

    constructor(
        getState: () => { perfSettings: PerfSettings },
        updatePerfSettings: (settings: Partial<PerfSettings>) => void
    ) {
        this.getState = getState;
        this.updatePerfSettings = updatePerfSettings;
    }

    start(sessionId: string) {
        this.stop();
        this.sessionId = sessionId;
        this.intervalId = window.setInterval(() => this.tick(), 500);
    }

    stop() {
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.sessionId = null;
    }

    private async tick() {
        if (!this.sessionId) return;

        try {
            const res = await fetch(`/api/sessions/${this.sessionId}/status`);
            if (!res.ok) return;
            const status: DepthStatus = await res.json();
            this.adjustSettings(status);
        } catch (e) {
            console.error('SyncController poll failed', e);
        }
    }

    private adjustSettings(status: DepthStatus) {
        const { perfSettings } = this.getState();

        // 1. Update maxInflightRequests based on backend capacity
        if (status.config && status.config.inference_workers) {
            // Allow more inflight requests to cover network latency (Little's Law)
            // With high RTT, we need Inflight > Workers to keep the pipeline full.
            // Factor of 4 allows for RTT up to 4x the processing time.
            const targetInflight = status.config.inference_workers * 4;
            if (perfSettings.maxInflightRequests !== targetInflight) {
                this.updatePerfSettings({ maxInflightRequests: targetInflight });
                console.debug(`[SyncController] Adjusted maxInflight to ${targetInflight}`);
            }
        }

        if (!perfSettings.autoLead) return;

        const stats = status.rolling_stats;
        if (!stats) return;

        // Calculate ideal lead time
        // lead = queue + decode + infer + safety
        // safety margin: 50ms base + 10% of inference time
        const safetyMargin = 0.05 + (stats.infer_avg_s * 0.1);
        const totalProcessingS =
            stats.queue_avg_s +
            (stats.decode_avg_s || 0.05) +
            stats.infer_avg_s +
            safetyMargin;

        let targetLeadMs = totalProcessingS * 1000;

        // Ensure lead time is sufficient to keep all workers busy
        // If we have N workers, we want to buffer at least N frames ahead?
        // Or rather, we want to ensure we have enough "inflight" requests.
        // If latency is L, and workers is W. Throughput = W/L.
        // We need to request frames at rate W/L.
        // To sustain this, our lead window must be large enough.
        // Empirically, adding a "pipeline fill" component helps.
        if (status.config && status.config.inference_workers) {
            const minPipelineLead = status.config.inference_workers * 40; // 40ms per worker
            targetLeadMs = Math.max(targetLeadMs, minPipelineLead);
        }

        // Clamp to reasonable limits [50ms, 2000ms]
        // Increased max to 2000ms to allow for high worker counts
        targetLeadMs = Math.max(50, Math.min(2000, targetLeadMs));

        // Only update if difference is significant (> 20ms) to avoid React render thrashing
        if (Math.abs(targetLeadMs - perfSettings.depthLeadMs) > 20) {
            this.updatePerfSettings({ depthLeadMs: Math.round(targetLeadMs) });
            console.debug(`[SyncController] Adjusted lead to ${Math.round(targetLeadMs)}ms (infer=${stats.infer_avg_s.toFixed(3)}s)`);
        }
    }
}
