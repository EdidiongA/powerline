/**
 * Server-initiated alerts over the Streamable HTTP GET stream.
 *
 * Each MCP session starts a monitor that polls telemetry and pushes
 * `notifications/message` (MCP logging notifications, level "warning") when:
 *   - battery drops below reserve + 10 %   → "low"
 *   - battery reaches the reserve floor    → "critical"
 *   - grid state flips                     → "grid" (also logged to the household pattern)
 * A client that has opened the GET SSE stream receives these without asking.
 * Note: the transport silently drops notifications when no GET stream is open,
 * so alerts repeat on ALERT_REPEAT_MS while a condition persists (default 15 min)
 * and the first check is deferred one interval to give the client time to connect.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { TelemetrySource } from "./telemetry/index.js";
import { getHousehold, updateHousehold } from "./store/index.js";

export interface AlertMonitor { stop(): void }

export function startAlertMonitor(
  server: McpServer, source: TelemetrySource, userId: string,
  intervalMs = Number(process.env.ALERT_INTERVAL_MS ?? 30_000),
  repeatMs = Number(process.env.ALERT_REPEAT_MS ?? 15 * 60_000),
): AlertMonitor {
  let lowAt = 0, criticalAt = 0; // last time each alert was sent (0 = armed)
  let lastGrid: boolean | null | undefined;
  const due = (last: number) => last === 0 || Date.now() - last >= repeatMs;

  const notify = (kind: string, text: string, data: Record<string, unknown> = {}) =>
    server.sendLoggingMessage({ level: "warning", logger: "powerline.alerts", data: { kind, text, ...data } }).catch((e) => console.error("[alerts] send failed:", (e as Error).message));

  const tick = async () => {
    try {
      const [t, h] = await Promise.all([source.current(), getHousehold(userId)]);
      if (process.env.ALERT_DEBUG) console.log(`[alerts] tick soc=${t.soc_pct} grid=${t.grid_available}`);
      const reserve = h.profile?.reserveSocPct ?? 20;

      if (t.soc_pct <= reserve) {
        if (due(criticalAt)) {
          criticalAt = Date.now(); lowAt = criticalAt;
          await notify("critical", `Battery is at ${t.soc_pct}% — at the ${reserve}% reserve. Switch off non-essential loads.`, { soc: t.soc_pct, reserve });
        }
      } else if (t.soc_pct <= reserve + 10) {
        if (due(lowAt)) {
          lowAt = Date.now();
          await notify("low", `Battery is at ${t.soc_pct}%, ${Math.round(t.soc_pct - reserve)} points above the reserve.`, { soc: t.soc_pct, reserve });
        }
      } else if (t.soc_pct > reserve + 15) {
        lowAt = 0; criticalAt = 0; // condition cleared → re-arm
      }

      if (lastGrid !== undefined && t.grid_available !== null && t.grid_available !== lastGrid) {
        // Every open session runs a monitor and each will independently notice the same
        // flip, so the write must be idempotent: only record a change of state.
        await updateHousehold(userId, (hh) => {
          const previous = hh.gridEvents[hh.gridEvents.length - 1];
          if (!previous || previous.on !== t.grid_available) hh.gridEvents.push({ at: t.at, on: t.grid_available! });
        });
        await notify("grid", t.grid_available ? "Grid power is back." : "Grid power just went off — running on solar and battery.", { on: t.grid_available });
      }
      lastGrid = t.grid_available;
    } catch (e) { console.error("[alerts] tick failed:", (e as Error).message); }
  };

  const timer = setInterval(tick, intervalMs); // first check after one interval
  return { stop: () => clearInterval(timer) };
}
