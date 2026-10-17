/** Raw Streamable HTTP round-trip against a running Powerline server. Run: npm run smoke */
const URL_ = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const PROTO = "2025-11-25";
let session: string | undefined; let id = 0;
async function rpc(method: string, params: unknown = {}, notify = false) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params }; if (!notify) body.id = ++id;
  const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTO, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
  session ??= res.headers.get("mcp-session-id") ?? undefined;
  if (notify) return res.status;
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) { const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop(); return JSON.parse(data!); }
  return JSON.parse(text);
}
const call = async (name: string, args: unknown = {}) => (await rpc("tools/call", { name, arguments: args })).result;

const init = await rpc("initialize", { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
console.log("initialize ->", init.result.protocolVersion, "session:", session);
await rpc("notifications/initialized", {}, true);

// Open the standalone GET SSE stream immediately, like a real client, and collect notifications/message.
const alerts: Array<{ kind: string; text: string }> = [];
const streamAbort = new AbortController();
(async () => {
  const sse = await fetch(URL_, { method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": session!, "mcp-protocol-version": PROTO }, signal: streamAbort.signal });
  console.log("GET stream ->", sse.status, sse.headers.get("content-type"));
  const reader = sse.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) if (line.startsWith("data:")) {
          const m = JSON.parse(line.slice(5));
          if (m.method === "notifications/message") alerts.push(m.params.data);
        }
      }
    }
  } catch { /* aborted */ }
})();
console.log("tools ->", (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name));
console.log("prompts ->", (await rpc("prompts/list")).result.prompts.map((p: { name: string }) => p.name));
console.log("setup_system ->", (await call("setup_system", { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 })).content[0].text);
console.log("add_appliance ->", (await call("add_appliance", { name: "washing machine", watts: 500, minutes: 45 })).content[0].text);
console.log("add_appliance ->", (await call("add_appliance", { name: "iron", watts: 2000, minutes: 30 })).content[0].text);
console.log("log_grid_event ->", (await call("log_grid_event", { on: false })).content[0].text);
const st = await call("power_status");
console.log("power_status ->", st.content[0].text);
console.log("  forecast points:", st.structuredContent.forecast.length, "minSoc:", st.structuredContent.minSocPct);
console.log("can_i_run washing machine ->", (await call("can_i_run", { appliance: "washing machine" })).content[0].text);
console.log("can_i_run iron ->", (await call("can_i_run", { appliance: "iron" })).content[0].text);
console.log("can_i_run unknown ->", (await call("can_i_run", { appliance: "welder", watts: 6000, minutes: 10 })).content[0].text);
console.log("add_appliance ->", (await call("add_appliance", { name: "pump", watts: 750, minutes: 60 })).content[0].text);
const plan = await call("plan_day");
console.log("plan_day ->\n" + plan.content[0].text);
console.log("plan_day (subset, as the card would) ->\n" + (await call("plan_day", { appliances: [{ name: "iron", watts: 2000, minutes: 30 }] })).content[0].text);
console.log("evening_briefing ->", (await call("evening_briefing")).content[0].text);
console.log("outage_outlook ->", (await call("outage_outlook")).content[0].text);
console.log("energy_report ->", (await call("energy_report", { period: "week" })).content[0].text);
for (const uri of ["ui://powerline/dashboard.html", "ui://powerline/planner.html", "ui://powerline/report.html"]) {
  const res = await rpc("resources/read", { uri });
  console.log("resource ->", uri, res.result.contents[0].mimeType, `${res.result.contents[0].text.length} bytes`);
}

// Wait for any server-initiated alerts collected on the GET stream (opened right after initialize).
const waitMs = Number(process.env.SMOKE_ALERT_WAIT_MS ?? 5000);
await new Promise((r) => setTimeout(r, waitMs));
console.log(alerts.length ? `ALERTS (${alerts.length}) ->\n` + alerts.map((a) => `  [${a.kind}] ${a.text}`).join("\n") : "no alerts within wait window (expected when the battery is healthy; use SIM_START_SOC=29 to force one)");
streamAbort.abort();
const del = await fetch(URL_, { method: "DELETE", headers: { "mcp-session-id": session! } });
console.log("DELETE session ->", del.status);
process.exit(0); // the aborted SSE stream can leave a pending handle; the round-trip itself succeeded
