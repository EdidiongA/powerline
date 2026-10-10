/**
 * Growatt adapter, replayed against recorded payload shapes (test/fixtures/growatt).
 * Covers both device families the OpenAPI v1 exposes, day/night/outage states, numbers
 * arriving as strings (MIN/TLX does this), a sparse payload, and an API error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GrowattSource } from "../src/telemetry/growatt.js";

const fx = (name: string) => readFileSync(path.resolve("test/fixtures/growatt", name), "utf8");

/** A fetch that answers each OpenAPI path from a fixture and records what was asked. */
function replay(routes: Record<string, string>) {
  const calls: Array<{ path: string; method: string; body: string; token: string | null }> = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const p = url.pathname.replace(/^\/v1\//, "");
    const body = init?.body ? String(init.body) : "";
    calls.push({ path: p, method: init?.method ?? "GET", body, token: (init?.headers as Record<string, string>)?.token ?? null });
    const file = routes[p];
    if (!file) return new Response(JSON.stringify({ error_code: 10002, error_msg: `no fixture for ${p}` }), { status: 200 });
    return new Response(fx(file), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: f, calls };
}

test("SPH daytime: discovers plant and device, maps PV/load/charge/SOC/grid", async () => {
  const r = replay({ "plant/list": "plant_list.json", "device/list": "device_list_sph.json", "device/mix/mix_last_data": "mix_last_data_daytime.json" });
  const t = await new GrowattSource({ token: "tok", fetch: r.fetch }).current();
  assert.equal(t.pv_w, 3120);
  assert.equal(t.load_w, 641);
  assert.equal(t.battery_w, 2400, "charging");
  assert.equal(t.soc_pct, 78);
  assert.equal(t.grid_w, 0);
  assert.equal(t.grid_available, true, "vac1 present");
  assert.equal(t.source, "growatt");
  // wire-level: token header, plant_id query, mix_sn form body
  assert.equal(r.calls[0].token, "tok");
  assert.match(r.calls.find((c) => c.path === "device/list")!.path, /device\/list/);
  assert.equal(r.calls.at(-1)!.body, "mix_sn=ZT00100001");
  assert.equal(r.calls.at(-1)!.method, "POST");
});

test("SPH night on grid: load imported, battery idle", async () => {
  const r = replay({ "device/mix/mix_last_data": "mix_last_data_night_grid.json" });
  const t = await new GrowattSource({ token: "tok", deviceSn: "ZT00100001", deviceType: 5, fetch: r.fetch }).current();
  assert.equal(t.pv_w, 0);
  assert.equal(t.load_w, 412);
  assert.equal(t.battery_w, 0);
  assert.equal(t.grid_w, 412, "importing");
  assert.equal(t.grid_available, true);
  assert.equal(r.calls.length, 1, "explicit device: no discovery calls");
});

test("SPH night outage: grid gone, battery carries the house", async () => {
  const r = replay({ "device/mix/mix_last_data": "mix_last_data_night_outage.json" });
  const t = await new GrowattSource({ token: "tok", deviceSn: "ZT00100001", deviceType: 5, fetch: r.fetch }).current();
  assert.equal(t.grid_available, false, "vac1 = 0");
  assert.equal(t.battery_w, -355, "discharging");
  assert.equal(t.soc_pct, 43);
});

test("MIN/TLX: numbers arrive as strings, alternate field names, export to grid", async () => {
  const r = replay({ "plant/list": "plant_list.json", "device/list": "device_list_min.json", "device/tlx/tlx_last_data": "tlx_last_data.json" });
  const t = await new GrowattSource({ token: "tok", fetch: r.fetch }).current();
  assert.equal(t.pv_w, 2877);
  assert.equal(t.load_w, 513);
  assert.equal(t.battery_w, 400);
  assert.equal(t.soc_pct, 94);
  assert.equal(t.grid_w, -1897, "negative = exporting (Math.round(-1897.5) → -1897: JS rounds half toward +∞)");
  assert.equal(t.grid_available, true);
  assert.equal(r.calls.at(-1)!.body, "tlx_sn=MIN0000001");
});

test("sparse payload: sums PV strings, leaves grid unknown rather than guessing", async () => {
  const r = replay({ "device/mix/mix_last_data": "mix_last_data_sparse.json" });
  const t = await new GrowattSource({ token: "tok", deviceSn: "ZT00100001", deviceType: 5, fetch: r.fetch }).current();
  assert.equal(t.pv_w, 1750, "ppv1 + ppv2 when ppv absent");
  assert.equal(t.load_w, 0);
  assert.equal(t.soc_pct, 55);
  assert.equal(t.grid_available, null);
  assert.ok(Number.isFinite(t.battery_w));
});

test("API error surfaces with Growatt's code, and a later failure serves the last good reading as stale", async () => {
  const bad = replay({ "device/mix/mix_last_data": "error_token.json" });
  await assert.rejects(() => new GrowattSource({ token: "tok", deviceSn: "X", deviceType: 5, fetch: bad.fetch }).current(), /Growatt error 10011/);

  let fail = false;
  const good = replay({ "device/mix/mix_last_data": "mix_last_data_daytime.json" });
  const flaky: typeof fetch = async (i, init) => (fail ? Promise.reject(new Error("ECONNRESET")) : good.fetch(i, init));
  const src = new GrowattSource({ token: "tok", deviceSn: "ZT00100001", deviceType: 5, fetch: flaky });
  const first = await src.current();
  fail = true;
  const second = await src.current();
  assert.equal(second.soc_pct, first.soc_pct);
  assert.match(second.source, /stale/);
});
