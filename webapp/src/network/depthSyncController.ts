import type { DepthStatus, PerfSettings } from '../types';
import { getAutoMaxInflight, getSuggestedDepthLeadMs } from './depthSyncPolicy';
import { getSessionStatus } from './sessionApi';

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
            const status = await getSessionStatus(this.sessionId);
            this.adjustSettings(status);
        } catch (e) {
            console.error('SyncController poll failed', e);
        }
    }

    private adjustSettings(status: DepthStatus) {
        const { perfSettings } = this.getState();

        // 1. Update maxInflightRequests based on backend capacity
        if (
            perfSettings.mode !== 'manual' &&
            status.config &&
            status.config.inference_workers
        ) {
            // Allow more inflight requests to cover network latency (Little's Law)
            // With high RTT, we need Inflight > Workers to keep the pipeline full.
            // Factor of 4 allows for RTT up to 4x the processing time.
            const targetInflight = getAutoMaxInflight(
                perfSettings.mode,
                status.config.inference_workers
            );
            if (
                targetInflight !== null &&
                perfSettings.maxInflightRequests !== targetInflight
            ) {
                this.updatePerfSettings({ maxInflightRequests: targetInflight });
                console.debug(`[SyncController] Adjusted maxInflight to ${targetInflight}`);
            }
        }

        if (!perfSettings.autoLead) return;

        const stats = status.rolling_stats;
        if (!stats) return;

        // Keep the disabled manual-lead value near the measured pipeline cost,
        // so turning Auto Lead off starts from a useful value. Playback Auto
        // Lead itself remains RTT + 100 ms in VideoDepthApp.
        const targetLeadMs = getSuggestedDepthLeadMs(
            stats,
            status.config?.inference_workers ?? 0
        );

        // Only update if difference is significant (> 20ms) to avoid React render thrashing
        if (Math.abs(targetLeadMs - perfSettings.depthLeadMs) > 20) {
            this.updatePerfSettings({ depthLeadMs: targetLeadMs });
            console.debug(`[SyncController] Adjusted lead to ${targetLeadMs}ms (infer=${stats.infer_avg_s.toFixed(3)}s)`);
        }
    }
}
