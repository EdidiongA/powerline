/**
 * Server-initiated alerts over the Streamable HTTP GET stream.
 *
 * Each MCP session starts a monitor that polls telemetry and pushes
 * `notifications/message` (MCP logging notifications, level "warning") when:
 *   - battery drops below reserve + 10 %   → "low"
 *   - battery reaches the reserve floor    → "critical"
 *   - grid state flips                     → "grid" (also logged to the household pattern)
 *   - an armed appliance's start time arrives → "reminder" ("It's 10:00 — run the iron now")
 * It also records one telemetry sample per hour into the household's history (reports, learning).
 * A client that has opened the GET SSE stream receives these without asking.
 * Note: the transport silently drops notifications when no GET stream is open,
 * so alerts repeat on ALERT_REPEAT_MS while a condition persists (default 15 min)
 * and the first check is deferred one interval to give the client time to connect.
 */
import { alertChannelFor } from "./push.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { TelemetrySource } from "./telemetry/index.js";
import { getHousehold, updateHousehold } from "./store/index.js";
import { dueReminders } from "./forecast.js";
import { localClock, reasonFor } from "./config.js";

export interface AlertMonitor { stop(): void }

/** A millisecond setting from the environment; anything that is not a positive number means the default (NaN would make setInterval spin). */
const envMs = (name: string, dflt: number) => { const n = Number(process.env[name]); return process.env[name]?.trim() && Number.isFinite(n) && n > 0 ? n : dflt; };

export function startAlertMonitor(
  server: McpServer, source: TelemetrySource, userId: string,
  intervalMs = envMs("ALERT_INTERVAL_MS", 30_000),
  repeatMs = envMs("ALERT_REPEAT_MS", 15 * 60_000),
  delivered?: Set<string>,
): AlertMonitor {
  let lowAt = 0, criticalAt = 0; // last time each alert was sent (0 = armed)
  let lastGrid: boolean | null | undefined;
  const remindedHere = delivered ?? new Set<string>(); // reminders this session has already delivered (shared with arm_plan's immediate path)
  let lastSeenAt = 0;                      // telemetry time at the previous tick
  const due = (last: number) => last === 0 || Date.now() - last >= repeatMs;

  // Resource-subscription push when the host subscribed to powerline://alerts, MCP logging otherwise (push.ts).
  const notify = (kind: string, text: string, data: Record<string, unknown> = {}) =>
    alertChannelFor(server).send(kind, text, data).catch((e) => console.error("[alerts] send failed:", (e as Error).message));

  const tick = async () => {
    try {
      const [t, h] = await Promise.all([source.current(), getHousehold(userId)]);
      if (process.env.ALERT_DEBUG) console.log(`[alerts] tick soc=${t.soc_pct} grid=${t.grid_available}`);
      const reserve = h.profile?.reserveSocPct ?? 20;

      if (!Number.isFinite(t.soc_pct)) {
        // A reading with no usable state of charge: nothing to judge the battery by this tick.
      } else if (t.soc_pct <= reserve) {
        if (due(criticalAt)) {
          criticalAt = Date.now(); lowAt = criticalAt;
          await notify("critical", `Battery is at ${t.soc_pct}%, ${t.soc_pct < reserve ? "below" : "at"} your ${reserve}% reserve. Switch off non-essential loads.`, { soc: t.soc_pct, reserve });
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

      // History: one sample per hour, written only when the hour slot is new, so N sessions
      // polling the same household produce one record, not N.
      if (Number.isFinite(t.soc_pct) && !Number.isNaN(Date.parse(t.at))) {
        const slot = new Date(t.at).toISOString().slice(0, 13);
        const have = (list: typeof h.samples) => !!list?.some((s) => s.at.slice(0, 13) === slot); // anywhere, not just the tail: seeded history may run past a simulated clock
        if (!have(h.samples)) {
          await updateHousehold(userId, (hh) => {
            if (have(hh.samples)) return;
            (hh.samples ??= []).push({ at: `${slot}:00:00.000Z`, pv_w: t.pv_w, load_w: t.load_w, soc_pct: t.soc_pct, grid_on: t.grid_available });
          });
        }
      }

      // Armed plan: the part where Powerline does something on its own.
      // The grace window stretches to cover the gap since the last tick, so a start
      // time is never skipped when the host sleeps or the (simulated) clock jumps.
      const nowMs = Date.parse(t.at);
      // First tick has no previous reading to measure from: allow an hour so nothing armed
      // just before this session connected is missed.
      const gapMin = lastSeenAt && Number.isFinite(nowMs) ? (nowMs - lastSeenAt) / 60_000 : 60;
      lastSeenAt = Number.isFinite(nowMs) ? nowMs : lastSeenAt;
      if (h.armedPlan) {
        // A plan whose every item has fired or is more than a day old is finished. Clear it so
        // the planner card stops showing yesterday's plan as armed.
        // Finished = every start time is comfortably behind us (not "every item fired": another session's
        // delivery must not clear a plan this session has not announced yet).
        const finished = Number.isFinite(nowMs) && h.armedPlan.items.every((i) => nowMs - Date.parse(i.startAt) > 3 * 3_600_000);
        if (finished) {
          const stale = h.armedPlan.armedAt;
          await updateHousehold(userId, (hh) => { if (hh.armedPlan?.armedAt === stale) hh.armedPlan = null; }); // never wipe a plan armed since this tick's read
        } else for (const item of dueReminders(h.armedPlan.items, t.at, Math.max(20, gapMin + 1), true)) {
          const key = `${item.name}@${item.startAt}`;
          if (remindedHere.has(key)) continue;
          remindedHere.add(key);
          await notify("reminder", `It's ${localClock(item.startAt, h.profile?.tzOffset)} — run the ${item.name} now, ${reasonFor(item.source)}.`, { appliance: item.name, startAt: item.startAt, source: item.source });
          // Mark fired in the shared record; conditional writes make this safe across sessions.
          await updateHousehold(userId, (hh) => {
            const target = hh.armedPlan?.items.find((i) => i.name === item.name && i.startAt === item.startAt);
            if (target && !target.firedAt) target.firedAt = t.at;
          });
        }
      }
    } catch (e) { console.error("[alerts] tick failed:", (e as Error).message); }
  };

  const timer = setInterval(tick, intervalMs); // first check after one interval
  return { stop: () => clearInterval(timer) };
}
