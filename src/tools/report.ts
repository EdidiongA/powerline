/** History tools: energy_report (report card), outage_outlook, set_tariff. */
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { assess, type SessionContext } from "../situation.js";
import { updateHousehold } from "../store/index.js";
import { normalizeCurrency } from "../store/types.js";
import { autonomyHours, dailyReports, periodSamples, summarize } from "../history.js";
import { gridProbabilityByHour } from "../forecast.js";
import { hourLabel, localClock } from "../config.js";
import { REPORT_URI, cardHtml } from "../views.js";

const fmtKwh = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)} kWh`;
const money = (v: number, cur: string) => `${cur} ${v >= 100 ? Math.round(v).toLocaleString("en") : v.toFixed(2)}`;

export function registerReportTools(server: McpServer, ctx: SessionContext): void {
  registerAppTool(server, "energy_report", {
    title: "Energy report",
    description: "What actually happened: solar generated, house consumption, grid hours and cost, worst battery point — for today, yesterday or the last week, from the household's own hourly readings. Shows a report card. Also says what the forecast has learned from that history.",
    inputSchema: z.object({ period: z.enum(["today", "yesterday", "week"]).default("week") }),
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: REPORT_URI } },
  }, async ({ period }) => {
    const { h, t, profile, learned, tz } = await assess(ctx);
    const rows = periodSamples(h.samples ?? [], period, t.at, tz);
    const days = dailyReports(rows, tz, profile.reserveSocPct);
    const sum = summarize(days, h.tariff);
    const label = period === "week" ? "the last 7 days" : period;
    // The local calendar days the period covers, so the card can draw an empty slot for a day with no readings.
    const nowMsSafe = Number.isNaN(Date.parse(t.at)) ? Date.now() : Date.parse(t.at);
    const dayMs = 86_400_000, todayMs = Math.floor((nowMsSafe + tz * 3_600_000) / dayMs) * dayMs;
    const dates = period === "week" ? Array.from({ length: 7 }, (_, i) => new Date(todayMs - (6 - i) * dayMs).toISOString().slice(0, 10)) : [new Date(todayMs - (period === "yesterday" ? dayMs : 0)).toISOString().slice(0, 10)];
    if (rows.length === 0) {
      const text = `No readings for ${label} yet. Powerline records one reading an hour, whether or not anyone is connected; reports and learning start from the first full day.`;
      return { content: [{ type: "text", text }], structuredContent: { period, dates, days: [], summary: sum, learned, reserve: profile.reserveSocPct, tariff: h.tariff ?? null, empty: true } };
    }
    const lines = [
      `${label[0].toUpperCase()}${label.slice(1)} (${rows.length} h of readings): solar ${fmtKwh(sum.solarKwh)}, house ${fmtKwh(sum.loadKwh)}, ${sum.solarSharePct}% covered without the grid.`,
      `Grid on ${sum.gridHours} h and supplied ${fmtKwh(sum.gridKwh)}${sum.gridCost !== null && sum.currency ? ` (≈ ${money(sum.gridCost, sum.currency)}; the sun was worth ≈ ${money(sum.solarValue!, sum.currency)})` : ""}.`,
      `Lowest battery ${sum.minSocPct}%${sum.hoursBelowReserve ? `, ${sum.hoursBelowReserve} h at or below the ${profile.reserveSocPct}% reserve` : `, never below the ${profile.reserveSocPct}% reserve`}.`,
      learned.loadProfile ? `Forecast now uses this household's own load shape (${learned.days} days of data)${learned.pvFactor !== null ? ` and the array's real yield (${Math.round(learned.pvFactor * 100)}% of clear-sky)` : ""}.` : `Forecast still uses the generic load shape; it switches to this household's own after 3 full days (${learned.days} so far).`,
    ];
    if (period === "week" && days.length < 7) lines.push(`Readings cover ${days.length} of the 7 days.`);
    return { content: [{ type: "text", text: lines.join(" ") }], structuredContent: { period, dates, days, summary: sum, learned, reserve: profile.reserveSocPct, tariff: h.tariff ?? null, empty: false } };
  });

  server.registerTool("outage_outlook", {
    title: "Outage outlook",
    description: "If the grid went off now, how long the battery would last at today's pattern; plus the hours tonight when the grid is usually off, from the learned pattern. Use for 'how are we if NEPA goes', 'how long can we last', 'is there light tonight'.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => {
    const { h, t, profile, input, localHour, tz } = await assess(ctx);
    const hours = autonomyHours(input, profile);
    const probs = gridProbabilityByHour(h.gridEvents, new Date(t.at).getUTCDay());
    const probsTomorrow = gridProbabilityByHour(h.gridEvents, (new Date(t.at).getUTCDay() + 1) % 7);
    const nowUtc = new Date(t.at).getUTCHours();
    const offHours: number[] = [];
    for (let i = 0; i < 24; i++) { const p = (nowUtc + i >= 24 ? probsTomorrow : probs)[(nowUtc + i) % 24]; if (p !== null && p < 0.5) offHours.push(i); }
    const ranges = offHours.reduce<Array<[number, number]>>((acc, hr) => { const last = acc[acc.length - 1]; if (last && last[1] === hr - 1) last[1] = hr; else acc.push([hr, hr]); return acc; }, [])
      .map(([a, b]) => `${hourLabel(localHour, a)}–${hourLabel(localHour, b + 1)}`);
    const nowMs = Date.parse(t.at);
    const until = hours === null || hours >= 48 || !Number.isFinite(nowMs) ? null : localClock(new Date(nowMs + hours * 3_600_000).toISOString(), tz);
    const autonomy = hours === null ? `The battery is already at or below your ${profile.reserveSocPct}% reserve, so there is no margin if the grid goes off now.`
      : hours >= 48 ? `If the grid went off now, the battery would hold above the ${profile.reserveSocPct}% reserve for more than two days at this pattern.`
      : `If the grid went off now, the battery would reach the ${profile.reserveSocPct}% reserve in about ${hours < 1 ? "an hour" : `${Math.round(hours)} hours`}${until ? ` — around ${until}` : ""}.`;
    const pattern = ranges.length ? `From this household's history the grid is usually off ${ranges.join(", ")}.` : h.gridEvents.length < 4 ? "Not enough grid history yet to say when it is usually off; log a few on/off events, or let it watch the grid for a day or two." : "No usual off-hours stand out in the next 24 h.";
    return { content: [{ type: "text", text: `${autonomy} ${pattern}` }], structuredContent: { autonomyHours: hours, reserveReachedAt: until, usualOffHoursFromNow: offHours, usualOffLocalHours: offHours.map((i) => (localHour + i) % 24), gridOn: t.grid_available } };
  });

  server.registerTool("set_tariff", {
    title: "Set the grid tariff",
    description: "What a grid kWh costs, so reports can say what the grid cost and what the sun was worth. E.g. 225 NGN per kWh.",
    inputSchema: z.object({ perKwh: z.number().min(0).max(100_000), currency: z.string().trim().min(1).max(8).default("NGN") }),
    annotations: { idempotentHint: true },
  }, async ({ perKwh, currency: raw }) => {
    const currency = normalizeCurrency(raw);
    await updateHousehold(ctx.userId, (hh) => { hh.tariff = { currency, perKwh }; });
    return { content: [{ type: "text", text: `Saved: ${currency} ${perKwh} per kWh from the grid.` }] };
  });

  registerAppResource(server, "Powerline report", REPORT_URI, { description: "Energy report: solar, consumption, grid and cost by day" },
    async () => ({ contents: [{ uri: REPORT_URI, mimeType: RESOURCE_MIME_TYPE, text: await cardHtml("report.html") }] }));
}
