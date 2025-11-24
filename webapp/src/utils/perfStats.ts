export class PerfStats {
    private metrics: Map<string, number[]> = new Map();
    private lastLogTime = performance.now();
    private readonly logIntervalMs = 1000;

    add(name: string, value: number) {
        if (!this.metrics.has(name)) {
            this.metrics.set(name, []);
        }
        this.metrics.get(name)!.push(value);
    }

    checkLog() {
        const now = performance.now();
        if (now - this.lastLogTime > this.logIntervalMs) {
            this.log();
            this.lastLogTime = now;
        }
    }

    private log() {
        const stats: Record<string, string> = {};
        let hasData = false;

        for (const [name, values] of this.metrics.entries()) {
            if (values.length === 0) continue;
            hasData = true;
            const min = Math.min(...values);
            const max = Math.max(...values);
            const avg = values.reduce((a, b) => a + b, 0) / values.length;
            stats[name] = `avg=${avg.toFixed(2)} min=${min.toFixed(2)} max=${max.toFixed(2)} n=${values.length}`;
            values.length = 0; // Clear buffer
        }

        if (hasData) {
            const isDebug = new URLSearchParams(window.location.search).get('debug') === 'true';
            if (isDebug) {
                console.log('[Perf]', JSON.stringify(stats, null, 2));
            }
        }
    }
}

export const perfStats = new PerfStats();
