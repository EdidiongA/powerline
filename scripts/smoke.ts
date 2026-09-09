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
console.log("tools ->", (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name));
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
console.log("evening_briefing ->", (await call("evening_briefing")).content[0].text);
const res = await rpc("resources/read", { uri: "ui://powerline/dashboard.html" });
console.log("resource ->", res.result.contents[0].mimeType, `${res.result.contents[0].text.length} bytes`);
const del = await fetch(URL_, { method: "DELETE", headers: { "mcp-session-id": session! } });
console.log("DELETE session ->", del.status);
