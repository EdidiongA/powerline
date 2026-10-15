/**
 * Server-level history recorder. The per-session alert monitor also records samples, but a
 * household's history must not depend on someone having the host open: a server that runs for a
 * week with nobody connected should still have a week of readings. One sample per hour slot per
 * household, grid flips logged as events — both idempotent, so the session monitors and this
 * recorder never double-write.
 */
import type { TelemetrySource } from "./telemetry/index.js";
import { getHousehold, updateHousehold } from "./store/index.js";

export interface HistoryRecorder { stop(): void; tick(): Promise<void> }

export function startHistoryRecorder(source: TelemetrySource, households: () => string[], intervalMs = 30_000): HistoryRecorder {
  const lastGrid = new Map<string, boolean | null>();
  const tick = async () => {
    let t;
    try { t = await source.current(); } catch (e) { console.error(`[history] telemetry unavailable: ${(e as Error).message}`); return; }
    if (!Number.isFinite(t.soc_pct) || Number.isNaN(Date.parse(t.at))) return;
    const slot = new Date(t.at).toISOString().slice(0, 13);
    for (const id of households()) {
      try {
        const h = await getHousehold(id);
        const have = (list: typeof h.samples) => !!list?.some((s) => s.at.slice(0, 13) === slot);
        const prev = lastGrid.get(id);
        const flipped = prev !== undefined && t.grid_available !== null && t.grid_available !== prev;
        if (!have(h.samples) || flipped) {
          await updateHousehold(id, (hh) => {
            if (!have(hh.samples)) (hh.samples ??= []).push({ at: `${slot}:00:00.000Z`, pv_w: t.pv_w, load_w: t.load_w, soc_pct: t.soc_pct, grid_on: t.grid_available });
            if (flipped) { const last = hh.gridEvents[hh.gridEvents.length - 1]; if (!last || last.on !== t.grid_available) hh.gridEvents.push({ at: t.at, on: t.grid_available! }); }
          });
        }
        lastGrid.set(id, t.grid_available);
      } catch (e) { console.error(`[history] ${id}: ${(e as Error).message}`); }
    }
  };
  const timer = setInterval(() => { void tick(); }, Math.max(1_000, intervalMs));
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
