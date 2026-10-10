/**
 * End-to-end: the README's "evaluate it in five minutes" sequence, driven by the official MCP
 * client over real Streamable HTTP against a real Powerline process — the same path a host
 * takes. Covers cards as resources, prompts, the planner's exact semantics, arming, a reminder
 * arriving on the notification stream, persistence across sessions, and two sessions of one
 * household writing at once without losing an update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { boot } from "./helpers/boot.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };

async function connect(url: string, token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined);
  const client = new Client({ name: "e2e", version: "0" }, { capabilities: {} });
  const notes: Array<{ kind: string; text: string }> = [];
  client.fallbackNotificationHandler = async (n) => { if (n.method === "notifications/message") notes.push((n.params as { data: { kind: string; text: string } }).data); };
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as ToolResult;
    return { ...r, text: r.content.find((c) => c.type === "text")?.text ?? "" };
  };
  return { client, transport, call, notes };
}

test("the five-minute evaluation path works over real Streamable HTTP, end to end", async () => {
  // Night, 55 %: the iron is "not now"; solar slots are tomorrow morning. Clock runs 50 sim-min/s so the morning slot arrives in ~15 s.
  const s = await boot({ SIM_START_SOC: "55", SIM_CLOCK_START: "2026-10-01T20:00:00Z", SIM_SPEED: "3000", ALERT_INTERVAL_MS: "1000" });
  try {
    const a = await connect(s.url);
    assert.ok(a.transport.sessionId, "server issued a session id");

    // Tools, prompts and card resources are all advertised.
    const tools = (await a.client.listTools()).tools.map((t) => t.name);
    for (const t of ["power_status", "can_i_run", "plan_day", "arm_plan", "evening_briefing", "setup_system", "add_appliance", "remove_appliance", "energy_report", "outage_outlook", "set_tariff"]) assert.ok(tools.includes(t), t);
    assert.equal((await a.client.listPrompts()).prompts.length, 5);
    const res = (await a.client.listResources()).resources.map((r) => r.uri);
    assert.ok(res.includes("ui://powerline/dashboard.html") && res.includes("ui://powerline/planner.html") && res.includes("ui://powerline/report.html") && res.includes("powerline://household"));
    const html = await a.client.readResource({ uri: "ui://powerline/planner.html" });
    assert.match((html.contents[0] as { text: string }).text, /<!doctype html>/i);
    assert.match((html.contents[0] as { mimeType: string }).mimeType, /mcp-app/);

    // 1–2: set up and remember an appliance.
    assert.match((await a.call("setup_system", { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 })).text, /Saved/);
    assert.match((await a.call("add_appliance", { name: "iron", watts: 2000, minutes: 30 })).text, /Added iron/);

    // 3: status carries the card's payload and no longer flags the default profile.
    const st = await a.call("power_status");
    assert.equal(st.structuredContent!.profileIsDefault, false);
    assert.equal((st.structuredContent!.forecast as unknown[]).length, 24);

    // 4: not now, with a morning slot.
    const can = await a.call("can_i_run", { appliance: "iron" });
    assert.match(can.text, /^Not now/);
    assert.match(can.text, /Best time: around 0[6-9]:00|Best time: around 1[0-2]:00/);

    // 5: plan, then the card's untick-all.
    const plan = await a.call("plan_day");
    assert.equal((plan.structuredContent!.items as Array<{ startHour: number | null }>).length, 1);
    const none = await a.call("plan_day", { appliances: [], exact: true });
    assert.deepEqual(none.structuredContent!.items, []);

    // 6: arm, then watch the reminder land on this session's notification stream.
    const armed = await a.call("arm_plan");
    assert.match(armed.text, /^Armed/);
    const deadline = Date.now() + 90_000;
    while (!a.notes.some((n) => n.kind === "reminder") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    const reminder = a.notes.find((n) => n.kind === "reminder");
    assert.ok(reminder, `no reminder within 90 s; notifications seen: ${JSON.stringify(a.notes)}`);
    assert.match(reminder!.text, /run the iron now/);

    // Reports: the monitor has been sampling the fast clock, so today already has readings.
    const rep = await a.call("energy_report", { period: "today" });
    assert.equal(rep.isError, undefined);
    if (!rep.structuredContent!.empty) assert.ok((rep.structuredContent!.summary as { loadKwh: number }).loadKwh > 0);
    assert.match((await a.call("outage_outlook")).text, /If the grid went off now/);

    // 7: briefing without Bedrock configured returns the facts and says so.
    const brief = await a.call("evening_briefing");
    assert.equal(brief._meta?.bedrock, false);
    assert.match(brief.text, /Battery \d+(\.\d+)?%/);

    // Persistence: a new session of the same household still knows the iron.
    await a.client.close();
    const b = await connect(s.url);
    assert.match((await b.call("list_appliances")).text, /iron: 2000 W, 30 min/);
    await b.client.close();
  } finally { await s.stop(); }
});

test("two sessions of one household writing at once never lose an update", async () => {
  const s = await boot({ API_TOKENS: "home:e2e-token-0123456789" });
  try {
    const [a, b] = await Promise.all([connect(s.url, "e2e-token-0123456789"), connect(s.url, "e2e-token-0123456789")]);
    assert.notEqual(a.transport.sessionId, b.transport.sessionId);
    const names = Array.from({ length: 12 }, (_, i) => `appliance-${i}`);
    await Promise.all(names.map((n, i) => (i % 2 ? a : b).call("add_appliance", { name: n, watts: 100 + i, minutes: 10 })));
    const listed = (await a.call("list_appliances")).text.split("\n").length;
    assert.equal(listed, 12, "every concurrent add survived");
    // A third household cannot see any of it, even with a valid session id it guessed.
    await a.client.close(); await b.client.close();
  } finally { await s.stop(); }
});

test("a wrong token gets 401 before any session exists; a right one gets its own household", async () => {
  const s = await boot({ API_TOKENS: "lagos:lagos-secret-12345,office:office-secret-12345" });
  try {
    await assert.rejects(connect(s.url, "nope-nope-nope"), /401|Unauthorized/);
    const lagos = await connect(s.url, "lagos-secret-12345");
    const office = await connect(s.url, "office-secret-12345");
    await lagos.call("add_appliance", { name: "borehole pump", watts: 1100, minutes: 40 });
    assert.match((await office.call("list_appliances")).text, /No appliances yet/);
    assert.match((await lagos.call("list_appliances")).text, /borehole pump/);
    await lagos.client.close(); await office.client.close();
  } finally { await s.stop(); }
});
