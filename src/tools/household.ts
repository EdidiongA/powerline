/** Onboarding and household memory: profile, appliances, grid events. */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getHousehold, updateHousehold } from "../store/index.js";
import type { SessionContext } from "../situation.js";
import { localClock } from "../config.js";
import { HOUSEHOLD_URI } from "../views.js";
import { presetFor } from "../presets.js";

export function registerHouseholdTools(server: McpServer, ctx: SessionContext): void {
  // A read-only snapshot a host can show or cache: profile, appliances, tariff, armed plan,
  // how much history exists. Never the samples themselves (that is what energy_report is for).
  server.registerResource("household", HOUSEHOLD_URI, { title: "Household snapshot", description: "Profile, appliances, tariff, armed plan and history depth for this household", mimeType: "application/json" },
    async () => {
      const h = await getHousehold(ctx.userId);
      const body = { profile: h.profile, appliances: h.appliances, tariff: h.tariff ?? null, armedPlan: h.armedPlan ?? null, gridEvents: h.gridEvents.length, historyHours: h.samples?.length ?? 0, updatedAt: h.updatedAt };
      return { contents: [{ uri: HOUSEHOLD_URI, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    });

  server.registerTool("setup_system", {
    title: "Set up the solar system",
    description: "Store the household's system profile: array size, battery, inverter, reserve floor.",
    inputSchema: z.object({
      arrayKw: z.number().min(0.05).max(1_000_000).describe("Total PV array size in kW (e.g. 9 panels × 500 W = 4.5). Values over 100 are read as watts."),
      batteryKwh: z.number().min(0.1).max(1_000_000).describe("Usable battery capacity in kWh. Values over 1000 are read as Wh."),
      inverterKw: z.number().min(0.1).max(1_000_000).describe("Inverter rating in kW. Values over 100 are read as watts."),
      reserveSocPct: z.number().min(0).max(90).default(20).describe("Battery % the household wants to keep in reserve"),
      tzOffset: z.number().min(-12).max(14).optional().describe("Household UTC offset in hours (Lagos = 1, Nairobi = 3, London = 0 or 1). Omit to keep the current or server setting."),
    }),
    annotations: { idempotentHint: true },
  }, async (p) => {
    // People say "4500" for a 4.5 kW array and "10000" for a 10 kWh battery. Treat anything
    // outside residential kW/kWh range as watts/Wh rather than storing a 4.5 MW roof.
    const notes: string[] = [];
    const kw = (v: number, label: string) => { if (v >= 1000) { notes.push(`${label} ${v} read as watts → ${v / 1000} kW`); return v / 1000; } return v; }; // 4500 is watts; 101 is a (large) kW figure, not 0.101 kW
    const arrayKw = kw(p.arrayKw, "array");
    const inverterKw = kw(p.inverterKw, "inverter");
    const batteryKwh = p.batteryKwh > 1000 ? (notes.push(`battery ${p.batteryKwh} read as Wh → ${p.batteryKwh / 1000} kWh`), p.batteryKwh / 1000) : p.batteryKwh;
    let tzOffset: number | undefined;
    await updateHousehold(ctx.userId, (h) => {
      tzOffset = p.tzOffset ?? h.profile?.tzOffset;
      h.profile = { arrayKw, batteryKwh, inverterKw, reserveSocPct: p.reserveSocPct, ...(tzOffset !== undefined ? { tzOffset } : {}) };
    });
    const tzNote = tzOffset !== undefined ? ` Clock: UTC${tzOffset >= 0 ? "+" : ""}${tzOffset}.` : "";
    return { content: [{ type: "text", text: `Saved: ${arrayKw} kW array, ${batteryKwh} kWh battery, ${inverterKw} kW inverter, ${p.reserveSocPct}% reserve.${tzNote}${notes.length ? ` (${notes.join("; ")}.)` : ""}` }] };
  });

  server.registerTool("add_appliance", {
    title: "Add an appliance",
    description: "Remember an appliance's power draw and typical run time so it can be planned by name. Watts and minutes are optional for common appliances (iron, kettle, washing machine, pump, AC, fridge…): a typical figure is used and reported back.",
    inputSchema: z.object({
      name: z.string().trim().min(1, "Give the appliance a name").max(60),
      watts: z.number().positive().max(50_000, "That is more than a household inverter can supply; give watts, not kilowatts × 1000").optional(),
      minutes: z.number().positive().max(1_440, "A run longer than a day cannot be planned").optional(),
    }),
    annotations: { idempotentHint: true },
  }, async (raw) => {
    const preset = presetFor(raw.name);
    if (raw.watts === undefined && !preset) {
      return { content: [{ type: "text", text: `I don't have a typical figure for "${raw.name}". Tell me the watts (it is usually on the label) and I'll remember it.` }], isError: true };
    }
    const a = { name: raw.name, watts: raw.watts ?? preset!.watts, minutes: raw.minutes ?? preset?.minutes ?? 60 };
    const assumed = raw.watts === undefined ? ` (typical ${preset!.canonical}: ${preset!.watts} W${raw.minutes === undefined ? ` for ${preset!.minutes} min` : ""} — tell me the real figure if yours differs)` : raw.minutes === undefined && preset ? ` (assumed ${preset.minutes} min)` : "";
    const name = a.name.replace(/\s+/g, " ");
    const replaced = (await getHousehold(ctx.userId)).appliances.some((x) => x.name.toLowerCase() === name.toLowerCase());
    await updateHousehold(ctx.userId, (h) => {
      h.appliances = h.appliances.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
      h.appliances.push({ name, watts: Math.max(1, Math.round(a.watts)), minutes: Math.max(1, Math.round(a.minutes)) });
    });
    return { content: [{ type: "text", text: `${replaced ? "Updated" : "Added"} ${name}: ${Math.max(1, Math.round(a.watts))} W for ${Math.max(1, Math.round(a.minutes))} min.${assumed}` }] };
  });

  server.registerTool("list_appliances", { title: "List appliances", description: "Appliances Powerline knows about.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const h = await getHousehold(ctx.userId);
      return { content: [{ type: "text", text: h.appliances.length ? h.appliances.map((a) => `${a.name}: ${a.watts} W, ${a.minutes} min`).join("\n") : "No appliances yet. Say something like “remember the washing machine uses 500 watts for 45 minutes”." }] };
    });

  server.registerTool("log_grid_event", {
    title: "Log grid on/off",
    description: "Record that grid power just came on or went off. Powerline learns the supply pattern from these.",
    annotations: { idempotentHint: true },
    inputSchema: z.object({ on: z.boolean(), at: z.string().datetime({ offset: true }).optional().describe("When it happened (ISO 8601); defaults to now") }),
  }, async ({ on, at }) => {
    // "Now" is telemetry time, so it lines up with the alert monitor's own grid observations
    // (and with the simulator's clock in a demo). Only a change of state is recorded, so
    // saying "the grid went off" twice does not teach the pattern two outages.
    const telemetryNow = await ctx.source.current().then((t) => t.at).catch(() => new Date().toISOString());
    const nowIso = at ?? telemetryNow;
    // A time in the future, or more than 30 days back, would sit at the end of the log and block every later event.
    const delta = Date.parse(nowIso) - Date.parse(telemetryNow);
    if (!Number.isFinite(delta) || delta > 10 * 60_000 || delta < -30 * 86_400_000) {
      return { content: [{ type: "text", text: `I can only log grid events from the last 30 days up to now (telemetry time ${telemetryNow}).` }], isError: true };
    }
    let recorded = false; let since = "";
    await updateHousehold(ctx.userId, (h) => {
      // Compare with the event immediately before this moment, not the chronologically last one.
      const previous = [...h.gridEvents].filter((e) => Date.parse(e.at) <= Date.parse(nowIso)).pop();
      if (previous && previous.on === on) { since = localClock(previous.at, h.profile?.tzOffset); return; } // already in that state: a repeat is not a new event
      h.gridEvents.push({ at: nowIso, on });
      h.gridEvents.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
      recorded = true;
    });
    return { content: [{ type: "text", text: recorded ? `Logged grid ${on ? "ON" : "OFF"}.` : `Grid has been logged ${on ? "ON" : "OFF"} since ${since}; nothing new to record.` }] };
  });
}
