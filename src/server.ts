/**
 * Powerline MCP server — tools, MCP App resource, cross-session household state.
 * One McpServer per MCP session (see http.ts); household data persists via store.ts.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getHousehold, updateHousehold } from "./store.js";
import { canRun, forecast, gridProbabilityByHour, type ForecastInput, type SystemProfile } from "./forecast.js";
import { clearSkyPvW, typicalLoadW } from "./telemetry/simulated.js";
import type { TelemetrySource } from "./telemetry/index.js";
import { bedrockEnabled, summarize } from "./bedrock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_URI = "ui://powerline/dashboard.html";
const DEFAULT_PROFILE: SystemProfile = { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 };

async function loadCardHtml(): Promise<string> {
  for (const p of [path.resolve(__dirname, "ui/card.html"), path.resolve(__dirname, "../dist/ui/card.html")]) {
    try { return await fs.readFile(p, "utf8"); } catch { /* next */ }
  }
  throw new Error("MCP App view not built. Run `npm run build:ui`.");
}

export interface SessionContext { userId: string; source: TelemetrySource }

/** Assemble a ForecastInput from live telemetry + household profile + learned grid pattern. */
async function buildForecastInput(ctx: SessionContext) {
  const [t, h] = await Promise.all([ctx.source.current(), getHousehold(ctx.userId)]);
  const profile = h.profile ?? DEFAULT_PROFILE;
  const now = new Date();
  const localHour = (now.getUTCHours() + 1) % 24; // Lagos UTC+1; TODO: per-household timezone
  const providerPv = (await ctx.source.pvForecast?.()) ?? null;
  const pvForecastW = providerPv ?? Array.from({ length: 24 }, (_, i) => clearSkyPvW((localHour + i) % 24, profile.arrayKw));
  // Load forecast: scale the typical profile so hour 0 matches what we measure right now.
  const scale = t.load_w > 0 ? t.load_w / typicalLoadW(localHour) : 1;
  const loadForecastW = Array.from({ length: 24 }, (_, i) => Math.round(typicalLoadW((localHour + i) % 24) * Math.min(2, Math.max(0.5, scale))));
  // Grid forecast: learned probabilities if we have events, else assume current state persists 2h then unknown.
  const probs = h.gridEvents.length >= 2 ? gridProbabilityByHour(h.gridEvents, now.getUTCDay()) : null;
  const gridForecast = Array.from({ length: 24 }, (_, i) =>
    probs ? probs[(now.getUTCHours() + i) % 24] >= 0.5 : i < 2 ? (t.grid_available ?? false) : null,
  );
  const input: ForecastInput = { profile, socPct: t.soc_pct, pvForecastW, loadForecastW, gridForecast };
  return { t, h, profile, input, localHour };
}

export function createServer(ctx: SessionContext): McpServer {
  const server = new McpServer(
    { name: "powerline", version: "0.2.0" },
    { instructions: "Powerline is a home power copilot. It knows the household's solar array, battery, inverter and grid pattern. Use power_status for the current picture, can_i_run before recommending an appliance, and evening_briefing for a spoken summary. Ask setup_system if no profile exists." },
  );

  // ---- Onboarding / household memory -------------------------------------
  server.registerTool("setup_system", {
    title: "Set up the solar system",
    description: "Store the household's system profile: array size, battery, inverter, reserve floor.",
    inputSchema: z.object({
      arrayKw: z.number().positive().describe("Total PV array size in kW (e.g. 9 panels × 500 W = 4.5)"),
      batteryKwh: z.number().positive(),
      inverterKw: z.number().positive(),
      reserveSocPct: z.number().min(0).max(90).default(20).describe("Battery % the household wants to keep in reserve"),
    }),
  }, async (p) => {
    await updateHousehold(ctx.userId, (h) => { h.profile = p; });
    return { content: [{ type: "text", text: `Saved: ${p.arrayKw} kW array, ${p.batteryKwh} kWh battery, ${p.inverterKw} kW inverter, ${p.reserveSocPct}% reserve.` }] };
  });

  server.registerTool("add_appliance", {
    title: "Add an appliance",
    description: "Remember an appliance's power draw and typical run time so it can be planned by name.",
    inputSchema: z.object({ name: z.string(), watts: z.number().positive(), minutes: z.number().positive().default(60) }),
  }, async (a) => {
    await updateHousehold(ctx.userId, (h) => {
      h.appliances = h.appliances.filter((x) => x.name.toLowerCase() !== a.name.toLowerCase());
      h.appliances.push(a);
    });
    return { content: [{ type: "text", text: `Added ${a.name}: ${a.watts} W for ${a.minutes} min.` }] };
  });

  server.registerTool("list_appliances", { title: "List appliances", description: "Appliances Powerline knows about.", inputSchema: z.object({}) },
    async () => {
      const h = await getHousehold(ctx.userId);
      return { content: [{ type: "text", text: h.appliances.length ? h.appliances.map((a) => `${a.name}: ${a.watts} W, ${a.minutes} min`).join("\n") : "No appliances yet. Use add_appliance." }] };
    });

  server.registerTool("log_grid_event", {
    title: "Log grid on/off",
    description: "Record that grid power just came on or went off. Powerline learns the supply pattern from these.",
    inputSchema: z.object({ on: z.boolean(), at: z.string().datetime().optional() }),
  }, async ({ on, at }) => {
    await updateHousehold(ctx.userId, (h) => { h.gridEvents.push({ at: at ?? new Date().toISOString(), on }); });
    return { content: [{ type: "text", text: `Logged grid ${on ? "ON" : "OFF"}.` }] };
  });

  // ---- Status (MCP App dashboard) -----------------------------------------
  registerAppTool(server, "power_status", {
    title: "Power status",
    description: "Current solar, load, battery and grid state with a 24h battery forecast. Shows a dashboard card.",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: CARD_URI } },
  }, async () => {
    const { t, profile, input } = await buildForecastInput(ctx);
    const f = forecast(input);
    const src = t.grid_available === null ? "battery/solar" : t.grid_available ? "grid" : t.pv_w > t.load_w ? "solar" : "battery";
    const floorMsg = f.hitsFloor ? `Battery reaches the ${profile.reserveSocPct}% reserve in about ${f.hoursToFloor!.toFixed(1)} hours.` : `Battery stays above the ${profile.reserveSocPct}% reserve for the next 24 hours.`;
    const text = `Solar ${t.pv_w} W, load ${t.load_w} W, battery ${t.soc_pct}% (${t.battery_w >= 0 ? "charging" : "discharging"} ${Math.abs(t.battery_w)} W), running on ${src}. ${floorMsg}`;
    return { content: [{ type: "text", text }], structuredContent: { telemetry: { ...t, raw: undefined }, profile, forecast: f.points, hoursToFloor: f.hoursToFloor, minSocPct: f.minSocPct } };
  });

  // ---- Decision tools ------------------------------------------------------
  server.registerTool("can_i_run", {
    title: "Can I run this appliance?",
    description: "Whether an appliance can run now without breaching the battery reserve; if not, the best time today. Accepts a known appliance name or explicit watts/minutes.",
    inputSchema: z.object({
      appliance: z.string().describe("Name, e.g. 'washing machine'"),
      watts: z.number().positive().optional(),
      minutes: z.number().positive().optional(),
    }),
  }, async ({ appliance, watts, minutes }) => {
    const { h, input, localHour } = await buildForecastInput(ctx);
    const known = h.appliances.find((a) => a.name.toLowerCase() === appliance.toLowerCase());
    const app = { name: appliance, watts: watts ?? known?.watts ?? 0, minutes: minutes ?? known?.minutes ?? 60 };
    if (!app.watts) return { content: [{ type: "text", text: `I don't know how much power "${appliance}" uses. Tell me the watts, or add it with add_appliance.` }] };
    const r = canRun(input, app);
    const when = r.bestStartHour !== null ? ` Best time: around ${String((localHour + r.bestStartHour) % 24).padStart(2, "0")}:00.` : r.ok ? "" : " No good slot in the next 24 hours.";
    return { content: [{ type: "text", text: `${r.ok ? "Yes" : "Not now"} — ${r.reason}${when}` }], structuredContent: r };
  });

  server.registerTool("evening_briefing", {
    title: "Evening power briefing",
    description: "One spoken paragraph: overnight battery outlook, expected grid windows, what to avoid. Uses Amazon Bedrock when configured.",
    inputSchema: z.object({}),
  }, async () => {
    const { t, h, profile, input } = await buildForecastInput(ctx);
    const f = forecast(input);
    const gridOn = input.gridForecast.map((g, i) => (g ? i : -1)).filter((i) => i >= 0);
    const facts = [
      `Battery ${t.soc_pct}%, reserve ${profile.reserveSocPct}%.`,
      f.hitsFloor ? `Reserve reached in ${f.hoursToFloor!.toFixed(1)} h; lowest ${f.minSocPct}%.` : `Battery stays above reserve overnight; lowest ${f.minSocPct}%.`,
      gridOn.length ? `Grid expected on in ${gridOn.length} of the next 24 hours.` : `No grid expected tonight.`,
      h.appliances.length ? `Known heavy appliances: ${h.appliances.filter((a) => a.watts >= 1000).map((a) => a.name).join(", ") || "none"}.` : "",
    ].filter(Boolean).join(" ");
    const text = bedrockEnabled ? await summarize(facts) : facts;
    return { content: [{ type: "text", text }], _meta: { bedrock: bedrockEnabled } };
  });

  registerAppResource(server, "Powerline dashboard", CARD_URI, { description: "Live power dashboard with 24h battery forecast" },
    async () => ({ contents: [{ uri: CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: await loadCardHtml() }] }));

  return server;
}
