/** power_status: the live picture, with the dashboard card. */
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { forecast } from "../forecast.js";
import { assess, type SessionContext } from "../situation.js";
import { DASHBOARD_URI, cardHtml } from "../views.js";

export function registerStatusTools(server: McpServer, ctx: SessionContext): void {
  registerAppTool(server, "power_status", {
    title: "Power status",
    description: "Current solar, load, battery and grid state with a 24h battery forecast. Shows a dashboard card.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI } },
  }, async () => {
    const { t, profile, input, localHour, tz, profileIsDefault, pvSource } = await assess(ctx);
    const f = forecast(input);
    const src = t.grid_available === null ? "battery/solar" : t.grid_available ? "grid" : t.pv_w > t.load_w ? "solar" : "battery";
    const recovers = f.points.findIndex((p) => p.socPct > profile.reserveSocPct);
    const floorMsg = t.soc_pct <= profile.reserveSocPct
      ? `Battery is at or below the ${profile.reserveSocPct}% reserve now${recovers === 0 ? "; charging, back above it within the hour" : recovers > 0 ? `; expected back above it in about ${recovers} ${recovers === 1 ? "hour" : "hours"}` : "; switch off non-essential loads"}.`
      : f.hitsFloor ? `Battery reaches the ${profile.reserveSocPct}% reserve in about ${f.hoursToFloor!.toFixed(1)} hours.`
      : `Battery stays above the ${profile.reserveSocPct}% reserve for the next 24 hours.`;
    const flow = Math.abs(t.battery_w) < 5 ? "battery idle" : `${t.battery_w > 0 ? "charging" : "discharging"} ${Math.abs(t.battery_w)} W`;
    const note = profileIsDefault ? " (Forecast uses a default 4.5 kW / 10 kWh / 5 kW system — say “set up my solar” to use yours.)" : "";
    const text = `Solar ${t.pv_w} W, load ${t.load_w} W, battery ${t.soc_pct}% (${flow}), running on ${src}. ${floorMsg}${note}`;
    return { content: [{ type: "text", text }], structuredContent: { telemetry: { ...t, raw: undefined }, profile, forecast: f.points, hoursToFloor: f.hoursToFloor, minSocPct: f.minSocPct, localHour, tzOffset: tz, profileIsDefault, pvSource } };
  });

  registerAppResource(server, "Powerline dashboard", DASHBOARD_URI, { description: "Live power dashboard with 24h battery forecast" },
    async () => ({ contents: [{ uri: DASHBOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: await cardHtml("card.html") }] }));
}
