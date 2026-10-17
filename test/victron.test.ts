/**
 * Victron VRM adapter against a stand-in API: millisecond timestamps (what VRM v2 really sends),
 * second timestamps (older docs), a payload without SOC (served as stale, never 0 %), and a bad read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { VictronSource } from "../src/telemetry/victron.js";

async function vrm(payloads: Array<Record<string, unknown>>) {
  let i = 0;
  const srv = createServer((req, res) => {
    if (req.url?.includes("/stats")) { const body = payloads[Math.min(i++, payloads.length - 1)]; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ success: true, records: body })); return; }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test("victron: epoch-millisecond sample stamps are read as milliseconds; seconds still work; a sample without SOC is stale, not 0 %", async () => {
  const nowMs = Date.now() - 5 * 60_000;
  const rec = (ts: number, bs: Array<[number, number]> | false) => ({ Pdc: [[ts, 1200]], ac_loads: [[ts, 400]], bp: [[ts, 800]], bs, gp: [[ts, 0]] });
  const api = await vrm([
    rec(nowMs, [[nowMs, 61.5]]),
    rec(Math.floor(nowMs / 1000), [[Math.floor(nowMs / 1000), 62]]),
    rec(nowMs, false),
  ]);
  try {
    const src = new VictronSource({ token: "t", siteId: 1, baseUrl: api.base });
    const a = await src.current();
    assert.equal(a.soc_pct, 61.5);
    assert.ok(Math.abs(Date.parse(a.at) - nowMs) < 60_000, `ms stamp kept as-is, got ${a.at}`);
    assert.ok(new Date(a.at).getUTCFullYear() < 2100, "never year 58759");
    const b = await src.current();
    assert.ok(Math.abs(Date.parse(b.at) - nowMs) < 60_000, `seconds stamp scaled, got ${b.at}`);
    const c = await src.current();
    assert.equal(c.soc_pct, 62, "the last good SOC is served");
    assert.match(c.source, /stale/);
  } finally { await api.close(); }
});

test("victron: zero grid flow is 'unknown', not an outage — a sunny afternoon must not be logged and announced as the grid going off", async () => {
  const nowMs = Date.now() - 60_000;
  const rec = (gp: number | null) => ({ Pdc: [[nowMs, 3000]], ac_loads: [[nowMs, 900]], bp: [[nowMs, 0]], bs: [[nowMs, 80]], gp: gp === null ? [] : [[nowMs, gp]] });
  const api = await vrm([rec(0), rec(-420), rec(2), rec(null)]);
  try {
    const src = new VictronSource({ token: "t", siteId: 1, baseUrl: api.base });
    assert.equal((await src.current()).grid_available, null, "0 W: unknown");
    assert.equal((await src.current()).grid_available, true, "-420 W (importing): on");
    assert.equal((await src.current()).grid_available, null, "2 W noise: unknown");
    assert.equal((await src.current()).grid_available, null, "no attribute: unknown");
  } finally { await api.close(); }
});
