/**
 * Tool-level tests over a real MCP client/server pair (in-memory transport).
 *
 * These cover the semantics the cards depend on — empty selections, coerced units,
 * stale armed plans, the Bedrock fallback — through the same JSON-RPC surface a host
 * uses, so a schema or wiring regression fails here rather than in a demo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { DiskStore } from "../src/store/disk.js";
import { setStore, updateHousehold } from "../src/store/index.js";
import type { Summarizer } from "../src/tools/briefing.js";
import type { Telemetry, TelemetrySource } from "../src/telemetry/types.js";

const NOW = "2026-10-01T09:00:00.000Z"; // 10:00 Lagos, sun up
const daytime = (t: Partial<Telemetry> = {}): TelemetrySource => ({
  name: "fake",
  current: async () => ({ at: NOW, pv_w: 3200, load_w: 400, battery_w: 2800, soc_pct: 70, grid_w: 0, grid_available: false, source: "fake", ...t }),
});

const NIGHT = "2026-10-01T20:00:00.000Z"; // 21:00 Lagos: solar-surplus slots are tomorrow morning, so armed items stay pending
const night = (): TelemetrySource => ({
  name: "fake",
  current: async () => ({ at: NIGHT, pv_w: 0, load_w: 300, battery_w: -300, soc_pct: 70, grid_w: 0, grid_available: false, source: "fake" }),
});

async function connect(userId: string, source: TelemetrySource, llm?: Summarizer) {
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-tools-"))));
  const server = createServer({ userId, source }, { llm });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };
    return { ...r, text: r.content.find((c) => c.type === "text")?.text ?? "" };
  };
  const close = async () => { await client.close(); await server.close(); setStore(null); };
  return { call, close };
}

test("setup_system reads out-of-range values as watts / Wh and says so", async () => {
  const { call, close } = await connect("h1", daytime());
  const r = await call("setup_system", { arrayKw: 4500, batteryKwh: 10000, inverterKw: 5, reserveSocPct: 20 });
  assert.match(r.text, /4\.5 kW array, 10 kWh battery, 5 kW inverter/);
  assert.match(r.text, /read as watts/);
  await close();
});

test("add_appliance rejects an empty name and an impossible wattage", async () => {
  const { call, close } = await connect("h2", daytime());
  const empty = await call("add_appliance", { name: "   ", watts: 500, minutes: 30 });
  assert.equal(empty.isError, true);
  const huge = await call("add_appliance", { name: "welder", watts: 500_000, minutes: 5 });
  assert.equal(huge.isError, true);
  const ok = await call("add_appliance", { name: "  washing   machine ", watts: 500, minutes: 45 });
  assert.equal(ok.isError, undefined);
  assert.match(ok.text, /Added washing machine/);
  const again = await call("add_appliance", { name: "Washing Machine", watts: 600 });
  assert.match(again.text, /Updated/);
  await close();
});

test("plan_day: empty list means 'stored list' for a model but 'nothing' for the card", async () => {
  const { call, close } = await connect("h3", daytime());
  await call("setup_system", { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 });
  await call("add_appliance", { name: "iron", watts: 2000, minutes: 30 });

  const model = await call("plan_day", { appliances: [] });
  assert.equal((model.structuredContent!.items as unknown[]).length, 1, "model's [] falls back to the stored list");

  const card = await call("plan_day", { appliances: [], exact: true });
  assert.equal((card.structuredContent!.items as unknown[]).length, 0);
  assert.deepEqual(card.structuredContent!.selected, []);
  assert.match(card.text, /Nothing selected/);
  assert.equal(typeof card.structuredContent!.minSocPct, "number", "baseline low point still reported");
  assert.equal(card.structuredContent!.profileIsDefault, false);
  await close();
});

test("plan_day with no appliances at all invites the user to add one", async () => {
  const { call, close } = await connect("h4", daytime());
  const r = await call("plan_day");
  assert.match(r.text, /No appliances to plan yet/);
  assert.equal(r.structuredContent!.profileIsDefault, true, "no setup_system → default profile flagged");
  await close();
});

test("arm_plan with exact empty list disarms; remove_appliance prunes the armed plan", async () => {
  const { call, close } = await connect("h5", night());
  await call("setup_system", { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 });
  await call("add_appliance", { name: "iron", watts: 2000, minutes: 30 });
  await call("add_appliance", { name: "pump", watts: 750, minutes: 60 });

  const armed = await call("arm_plan");
  assert.equal((armed.structuredContent!.armed as unknown[]).length, 2);
  assert.ok((armed.structuredContent!.armed as Array<{ firedAt?: string }>).every((i) => !i.firedAt), "night: nothing is due right now");
  let plan = await call("plan_day");
  assert.deepEqual([...(plan.structuredContent!.armed as string[])].sort(), ["iron", "pump"]);

  const removed = await call("remove_appliance", { name: "Pump" });
  assert.match(removed.text, /Removed/);
  plan = await call("plan_day");
  assert.deepEqual(plan.structuredContent!.armed, ["iron"]);
  assert.equal((plan.structuredContent!.all as unknown[]).length, 1);

  const none = await call("arm_plan", { appliances: [], exact: true });
  assert.deepEqual(none.structuredContent!.armed, []);
  plan = await call("plan_day");
  assert.deepEqual(plan.structuredContent!.armed, []);

  const missing = await call("remove_appliance", { name: "kettle" });
  assert.match(missing.text, /don't have an appliance/);
  await close();
});

test("plan_day hides armed items that already fired or are long past their start", async () => {
  const { call, close } = await connect("h6", daytime());
  await call("add_appliance", { name: "iron", watts: 2000, minutes: 30 });
  await updateHousehold("h6", (h) => {
    h.armedPlan = { armedAt: NOW, items: [
      { name: "iron", watts: 2000, minutes: 30, source: "solar", startAt: "2026-10-01T05:00:00.000Z" },          // 4 h ago → stale
      { name: "pump", watts: 750, minutes: 60, source: "solar", startAt: "2026-10-01T12:00:00.000Z", firedAt: NOW }, // fired
      { name: "fan", watts: 60, minutes: 120, source: "battery", startAt: "2026-10-01T11:00:00.000Z" },          // upcoming
    ] };
  });
  const plan = await call("plan_day");
  assert.deepEqual(plan.structuredContent!.armed, ["fan"]);
  await close();
});

test("power_status flags the default profile and never reports NaN", async () => {
  const { call, close } = await connect("h7", daytime({ soc_pct: Number.NaN, battery_w: 2 }));
  const r = await call("power_status");
  assert.equal(r.structuredContent!.profileIsDefault, true);
  assert.match(r.text, /set up my solar/);
  assert.match(r.text, /battery idle/);
  assert.doesNotMatch(JSON.stringify(r.structuredContent), /NaN|null,"pvW"/);
  await close();
});

test("evening_briefing falls back to plain facts when the model fails or returns nothing", async () => {
  const failing: Summarizer = { enabled: true, summarize: async () => { throw new Error("ThrottlingException"); } };
  let s = await connect("h8", daytime(), failing);
  let r = await s.call("evening_briefing");
  assert.equal(r._meta?.bedrock, false);
  assert.equal(r._meta?.bedrockError, "ThrottlingException");
  assert.match(r.text, /Battery 70%/);
  await s.close();

  const empty: Summarizer = { enabled: true, summarize: async () => "   " };
  s = await connect("h9", daytime(), empty);
  r = await s.call("evening_briefing");
  assert.equal(r._meta?.bedrock, false);
  assert.match(r.text, /Battery 70%/);
  await s.close();

  const fine: Summarizer = { enabled: true, summarize: async (f) => `Good evening. ${f}` };
  s = await connect("h10", daytime(), fine);
  r = await s.call("evening_briefing");
  assert.equal(r._meta?.bedrock, true);
  assert.match(r.text, /^Good evening/);
  await s.close();
});

test("arm_plan tells the user at once about anything that can run right now", async () => {
  const { call, close } = await connect("h11", daytime());
  await call("setup_system", { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 });
  await call("add_appliance", { name: "iron", watts: 2000, minutes: 30 });
  const r = await call("arm_plan");
  assert.match(r.text, /iron can run right now/);
  const items = r.structuredContent!.armed as Array<{ name: string; firedAt?: string }>;
  assert.equal(items[0].firedAt !== undefined, true, "announced now → marked fired");
  const plan = await call("plan_day");
  assert.deepEqual(plan.structuredContent!.armed, [], "nothing left pending");
  await close();
});

test("log_grid_event uses telemetry time, records only state changes, and keeps events ordered", async () => {
  const { call, close } = await connect("h12", night());
  const first = await call("log_grid_event", { on: false });
  assert.match(first.text, /Logged grid OFF/);
  const repeat = await call("log_grid_event", { on: false });
  assert.match(repeat.text, /since 21:00; nothing new/);
  const earlier = await call("log_grid_event", { on: true, at: "2026-10-01T18:00:00Z" });
  assert.match(earlier.text, /Logged grid ON/);
  const { getHousehold } = await import("../src/store/index.js");
  const h = await getHousehold("h12");
  assert.deepEqual(h.gridEvents.map((e) => [e.at, e.on]), [["2026-10-01T18:00:00Z", true], [NIGHT, false]]);
  await close();
});

test("prompts are listed and render the phrasing a household uses", async () => {
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-prompts-"))));
  const server = createServer({ userId: "p1", source: daytime() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const names = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(names, ["can_i_run", "evening_outlook", "how_did_we_do", "plan_my_day", "set_up_household"]);
  const res = await client.readResource({ uri: "powerline://household" });
  const snap = JSON.parse((res.contents[0] as { text: string }).text) as { appliances: unknown[]; historyHours: number };
  assert.deepEqual(snap.appliances, []); assert.equal(snap.historyHours, 0);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find((t) => t.name === "power_status")?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "arm_plan")?.annotations?.destructiveHint, true);
  const got = await client.getPrompt({ name: "can_i_run", arguments: { appliance: "iron", minutes: "30" } });
  const text = (got.messages[0].content as { text: string }).text;
  assert.match(text, /Can I run the iron for 30 minutes now\?/);
  assert.match(text, /can_i_run/);
  await client.close(); await server.close(); setStore(null);
});

test("arm_plan asks before replacing an armed plan when the host supports elicitation, and respects 'no'", async () => {
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-elicit-"))));
  const server = createServer({ userId: "e1", source: night() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  const asked: string[] = [];
  let answer = false;
  // Spec methods take (method, handler); the handler receives the whole request.
  // @ts-expect-error — the typed overloads lag the runtime for spec methods
  client.setRequestHandler("elicitation/create", async (req: { params?: { message: string }; message?: string }) => { asked.push(req.params?.message ?? req.message ?? ""); return { action: "accept", content: { replace: answer } }; });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };
    return { ...r, text: r.content.find((c) => c.type === "text")?.text ?? "" };
  };
  await call("setup_system", { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 });
  await call("add_appliance", { name: "iron", watts: 2000, minutes: 30 });
  await call("add_appliance", { name: "pump", watts: 750, minutes: 60 });

  assert.match((await call("arm_plan", { appliances: [{ name: "iron", watts: 2000, minutes: 30 }] })).text, /^Armed/);
  assert.equal(asked.length, 0, "nothing armed before → no question");

  const kept = await call("arm_plan", { appliances: [{ name: "pump", watts: 750, minutes: 60 }] });
  assert.equal(asked.length, 1); assert.match(asked[0], /already armed for iron\. Replace it with pump\?/);
  assert.match(kept.text, /Kept the armed plan for iron/);
  assert.deepEqual((await call("plan_day")).structuredContent!.armed, ["iron"]);

  answer = true;
  const replaced = await call("arm_plan", { appliances: [{ name: "pump", watts: 750, minutes: 60 }] });
  assert.equal(asked.length, 2); assert.match(replaced.text, /^Armed/);
  assert.deepEqual((await call("plan_day")).structuredContent!.armed, ["pump"]);

  // The card's own path (exact) never asks: it has its own Re-arm button.
  await call("arm_plan", { appliances: [{ name: "iron", watts: 2000, minutes: 30 }], exact: true });
  assert.equal(asked.length, 2);
  await client.close(); await server.close(); setStore(null);
});

test("arm_plan replaces silently when the host cannot ask", async () => {
  const { call, close } = await connect("e2", night());
  await call("add_appliance", { name: "iron", watts: 2000, minutes: 30 });
  await call("add_appliance", { name: "pump", watts: 750, minutes: 60 });
  await call("arm_plan", { appliances: [{ name: "iron", watts: 2000, minutes: 30 }] });
  assert.match((await call("arm_plan", { appliances: [{ name: "pump", watts: 750, minutes: 60 }] })).text, /^Armed/);
  assert.deepEqual((await call("plan_day")).structuredContent!.armed, ["pump"]);
  await close();
});

test("energy_report is honest when empty, then reports and learns from seeded history", async () => {
  const { call, close } = await connect("r1", daytime());
  const empty = await call("energy_report", { period: "week" });
  assert.match(empty.text, /No readings for the last 7 days yet/);
  assert.equal(empty.structuredContent!.empty, true);

  // Seed 5 days ending just before NOW, a steady 400 W house, strong sun, grid on 0–6 local.
  await updateHousehold("r1", (h) => {
    h.samples = [];
    const end = Date.parse(NOW);
    for (let i = 5 * 24; i >= 1; i--) {
      const at = new Date(end - i * 3_600_000);
      const hr = (at.getUTCHours() + 1) % 24;
      h.samples.push({ at: at.toISOString(), pv_w: hr >= 8 && hr <= 16 ? 2500 : 0, load_w: 400, soc_pct: hr === 6 ? 25 : 60, grid_on: hr < 6 });
    }
  });
  await call("set_tariff", { perKwh: 225, currency: "NGN" });
  const week = await call("energy_report", { period: "week" });
  assert.equal(week.structuredContent!.empty, false);
  const sum = week.structuredContent!.summary as { gridHours: number; gridCost: number | null; currency: string | null; solarSharePct: number };
  assert.ok(sum.gridHours >= 24, `grid hours ${sum.gridHours}`);
  assert.equal(sum.currency, "NGN");
  assert.ok((sum.gridCost ?? 0) > 0);
  assert.ok(sum.solarSharePct > 50);
  assert.match(week.text, /NGN/);
  assert.match(week.text, /own load shape \(\d+ days of data\)/);
  const learned = week.structuredContent!.learned as { loadProfile: boolean; pvFactor: number | null; days: number };
  assert.equal(learned.loadProfile, true);
  assert.ok(learned.pvFactor !== null && learned.pvFactor > 0.4 && learned.pvFactor < 1.1, `pvFactor ${learned.pvFactor}`);

  // The learned load shape now drives the forecast: a flat 400 W house stays flat in the input.
  const st = await call("power_status");
  const loads = (st.structuredContent!.forecast as Array<{ loadW: number }>).map((p) => p.loadW);
  assert.ok(Math.max(...loads) - Math.min(...loads) < 60, `learned profile should be flat, got ${loads.join(",")}`);
  await close();
});

test("outage_outlook gives hours of autonomy and the usual off-hours from grid history", async () => {
  const { call, close } = await connect("r2", daytime({ soc_pct: 70, pv_w: 0, load_w: 1000 }));
  const r = await call("outage_outlook");
  assert.match(r.text, /If the grid went off now/);
  const sc = r.structuredContent as { autonomyHours: number | null; usualOffHours: number[] };
  assert.ok(sc.autonomyHours !== null && sc.autonomyHours > 0);
  assert.match(r.text, /Not enough grid history yet/);
  const low = await connect("r3", daytime({ soc_pct: 10 }));
  assert.match((await low.call("outage_outlook")).text, /already at or below/);
  await low.close(); await close();
});

test("the alert monitor records one sample per hour, not one per session or per tick", async () => {
  const { startAlertMonitor } = await import("../src/alerts.js");
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-samples-"))));
  let at = "2026-10-01T09:05:00.000Z";
  const src: TelemetrySource = { name: "fake", current: async () => ({ at, pv_w: 1000, load_w: 400, battery_w: 600, soc_pct: 70, grid_w: 0, grid_available: false, source: "fake" }) };
  const server = createServer({ userId: "s1", source: src });
  const m1 = startAlertMonitor(server, src, "s1", 20);
  const m2 = startAlertMonitor(server, src, "s1", 20);
  await new Promise((r) => setTimeout(r, 120));
  at = "2026-10-01T09:40:00.000Z"; await new Promise((r) => setTimeout(r, 80));   // same hour → no new sample
  at = "2026-10-01T10:02:00.000Z"; await new Promise((r) => setTimeout(r, 80));   // new hour → one sample
  m1.stop(); m2.stop();
  const { getHousehold } = await import("../src/store/index.js");
  const h = await getHousehold("s1");
  assert.deepEqual(h.samples!.map((s) => s.at), ["2026-10-01T09:00:00.000Z", "2026-10-01T10:00:00.000Z"]);
  setStore(null);
});

test("presets: 'add the iron' and 'can I run the kettle' work without wattages, and real figures override", async () => {
  const { presetFor } = await import("../src/presets.js");
  assert.equal(presetFor("the Iron")?.canonical, "iron");
  assert.equal(presetFor("pumping machine")?.canonical, "water pump");
  assert.equal(presetFor("my split unit AC")?.canonical, "air conditioner");
  assert.equal(presetFor("a/c")?.canonical, "air conditioner");
  assert.equal(presetFor("quantum flux capacitor"), undefined);
  assert.equal(presetFor(""), undefined);

  const { call, close } = await connect("p1", night());
  const iron = await call("add_appliance", { name: "the iron" });
  assert.match(iron.text, /Added the iron: 1800 W for 30 min\. \(typical iron/);
  const unknown = await call("add_appliance", { name: "flux capacitor" });
  assert.equal(unknown.isError, true); assert.match(unknown.text, /Tell me the watts/);
  const mine = await call("add_appliance", { name: "iron", watts: 2200 });
  assert.match(mine.text, /2200 W for 30 min\. \(assumed 30 min\)/);
  const can = await call("can_i_run", { appliance: "kettle" });
  assert.match(can.text, /assuming a typical kettle, 2000 W/);
  assert.equal((can.structuredContent as { assumedWatts?: number }).assumedWatts, 2000);
  const known = await call("can_i_run", { appliance: "the iron" });
  assert.doesNotMatch(known.text, /assuming/);
  await close();
});

test("per-household timezone: the profile's offset drives local hours, labels and reports", async () => {
  const { call, close } = await connect("tz1", night());   // 20:00Z
  const lagos = await call("power_status");
  assert.equal(lagos.structuredContent!.localHour, 21); assert.equal(lagos.structuredContent!.tzOffset, 1);
  const saved = await call("setup_system", { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20, tzOffset: 3 });
  assert.match(saved.text, /Clock: UTC\+3/);
  const nairobi = await call("power_status");
  assert.equal(nairobi.structuredContent!.localHour, 23); assert.equal(nairobi.structuredContent!.tzOffset, 3);
  // Re-running setup without tzOffset keeps it; an out-of-range value is rejected by the schema.
  await call("setup_system", { arrayKw: 5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 });
  assert.equal((await call("power_status")).structuredContent!.tzOffset, 3);
  assert.equal((await call("setup_system", { arrayKw: 5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20, tzOffset: 40 })).isError, true);
  // Half-hour zones (India 5.5) are real households: 20:00Z is 01:30 local, and nothing downstream turns into NaN.
  await call("setup_system", { arrayKw: 5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20, tzOffset: 5.5 });
  const india = await call("power_status");
  assert.equal(india.structuredContent!.localHour, 1);
  assert.doesNotMatch(india.text, /NaN|\d+\.5:/);
  await call("add_appliance", { name: "iron", watts: 1000, minutes: 30 });
  for (const t of ["can_i_run", "plan_day", "outage_outlook", "energy_report"]) {
    const r = await call(t, t === "can_i_run" ? { appliance: "iron" } : t === "energy_report" ? { period: "week" } : {});
    assert.doesNotMatch(r.text, /NaN|undefined|\d+\.5:\d\d/, `${t} must stay numeric and print whole-hour clocks in a half-hour zone`);
  }
  await close();
});
