import type { DepthStatus, PerfSettings } from '../types';
import { getAutoMaxInflight, getSuggestedDepthLeadMs } from './depthSyncPolicy';
import { getSessionStatus, isSessionGoneError } from './sessionApi';

export class DepthSyncController {
    private intervalId: number | null = null;
    private sessionId: string | null = null;
    private generation = 0;
    private requestController: AbortController | null = null;
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
        this.intervalId = window.setInterval(() => void this.tick(), 500);
    }

    stop() {
        this.generation += 1;
        this.requestController?.abort();
        this.requestController = null;
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.sessionId = null;
    }

    private async tick() {
        const sessionId = this.sessionId;
        if (!sessionId || this.requestController) return;
        const generation = this.generation;
        const controller = new AbortController();
        this.requestController = controller;

        try {
            const status = await getSessionStatus(sessionId, controller.signal);
            if (
                controller.signal.aborted ||
                generation !== this.generation ||
                sessionId !== this.sessionId
            ) {
                return;
            }
            this.adjustSettings(status);
        } catch (e) {
            if (
                controller.signal.aborted ||
                generation !== this.generation ||
                isSessionGoneError(e)
            ) {
                if (isSessionGoneError(e) && generation === this.generation) {
                    this.stop();
                }
                return;
            }
            console.error('SyncController poll failed', e);
        } finally {
            if (this.requestController === controller) {
                this.requestController = null;
            }
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
