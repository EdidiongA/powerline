import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assess } from "../src/situation.js";
import { DiskStore } from "../src/store/disk.js";
import { setStore } from "../src/store/index.js";
import { hourLabel, localClock, localHourOf } from "../src/config.js";
import type { Telemetry, TelemetrySource } from "../src/telemetry/types.js";

const fakeSource = (t: Partial<Telemetry>): TelemetrySource => ({
  name: "fake",
  current: async () => ({ at: "2026-10-01T20:00:00.000Z", pv_w: 0, load_w: 300, battery_w: -300, soc_pct: 60, grid_w: 0, grid_available: false, source: "fake", ...t }),
});

test("time helpers apply the household offset consistently", () => {
  assert.equal(localHourOf("2026-10-01T23:30:00Z", 1), 0);
  assert.equal(localClock("2026-10-01T23:30:00Z", 1), "00:30");
  assert.equal(localClock("garbage"), "--:--");
  assert.equal(hourLabel(23, 2), "01:00");
  assert.equal(hourLabel(1, -3), "22:00");
});

test("assess builds a 24-point input anchored on what it can see now", async () => {
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-"))));
  const s = await assess({ userId: "h", source: fakeSource({ grid_available: true }) });
  assert.equal(s.input.pvForecastW.length, 24);
  assert.equal(s.input.gridForecast[0], true, "hour 0 is the observed grid state");
  assert.equal(s.input.loadForecastW[0] > 0, true);
  assert.equal(s.localHour, 21);
  setStore(null);
});

test("assess neutralises NaN telemetry instead of poisoning the forecast", async () => {
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-"))));
  const s = await assess({ userId: "h", source: fakeSource({ soc_pct: Number.NaN, load_w: Number.NaN, pv_w: Number.NaN }) });
  assert.equal(s.t.soc_pct, 0);
  assert.equal(s.input.socPct, 0);
  assert.ok(s.input.loadForecastW.every(Number.isFinite));
  setStore(null);
});

test("weather: a radiation forecast for the household's coordinates replaces the clear-sky curve, and failures fall back", async () => {
  const { OpenMeteo } = await import("../src/weather.js");
  const nowHour = Math.floor(Date.now() / 3_600_000);
  const t0 = new Date((nowHour - 3) * 3_600_000); // series starts three hours ago, like a real 00:00-anchored day would
  const time = Array.from({ length: 72 }, (_, i) => new Date(t0.getTime() + i * 3_600_000).toISOString().slice(0, 16));
  const payload = { hourly: { time, shortwave_radiation: time.map((_, i) => (i % 24 >= 8 && i % 24 <= 16 ? 600 : 0)), cloud_cover: time.map(() => 40) } };
  let calls = 0;
  const fakeFetch = (async () => { calls++; return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
  const wx = new OpenMeteo(6.5, 3.4, fakeFetch);
  assert.equal(wx.enabled, true);
  const pv = await wx.pvForecast(4.5, new Date().toISOString());
  assert.ok(pv && pv.length === 24, "24 hourly values");
  // Open-Meteo stamps each value with the END of its hour: index 0 must be the hour that starts now, i.e. the series entry stamped now+1h.
  const stampedNext = payload.hourly.shortwave_radiation[4]; // series index 4 = (now − t0) + 1
  assert.equal(pv![0], Math.round(4.5 * 1000 * (stampedNext / 1000) * 0.8), "no one-hour phase shift");
  assert.ok(pv!.some((v) => v === Math.round(4.5 * 1000 * 0.6 * 0.8)) && pv!.some((v) => v === 0), "GHI → PV with the performance ratio");
  await wx.pvForecast(4.5, new Date().toISOString());
  assert.equal(calls, 1, "cached");
  // Wired into assess: the forecast input carries the weather curve and says so.
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-wx-"))));
  const s = await assess({ userId: "wx", source: fakeSource({ at: new Date().toISOString() }), weather: wx });
  assert.equal(s.pvSource, "weather");
  assert.deepEqual(s.input.pvForecastW, pv);
  // A simulated clock far from now gets no weather (the window does not cover it) → clear-sky.
  const sim = await assess({ userId: "wx", source: fakeSource({ at: "2026-10-01T20:00:00Z" }), weather: wx });
  assert.equal(sim.pvSource, "clear-sky");
  // Failures fall back, and a stale forecast beats none.
  let failed = 0;
  const broken = new OpenMeteo(6.5, 3.4, (async () => { failed++; throw new Error("offline"); }) as unknown as typeof fetch);
  assert.equal(await broken.pvForecast(4.5, new Date().toISOString()), null);
  await broken.pvForecast(4.5, new Date().toISOString());
  assert.equal(failed, 1, "an outage is not retried on every call — one attempt, then a back-off");
  assert.equal((await assess({ userId: "wx", source: fakeSource({ at: new Date().toISOString() }), weather: broken })).pvSource, "clear-sky");
  assert.equal(new OpenMeteo(Number.NaN, 3.4, fakeFetch).enabled, false);
  assert.equal(new OpenMeteo(95, 3.4, fakeFetch).enabled, false);
  process.env.WEATHER_LAT = " "; process.env.WEATHER_LON = "";
  assert.equal(new OpenMeteo(undefined, undefined, fakeFetch).enabled, false, "blank coordinates are unset, not 0,0");
  delete process.env.WEATHER_LAT; delete process.env.WEATHER_LON;
  setStore(null);
});

test("a blank TZ_OFFSET line in .env is 'unset', not UTC: the default offset survives", async () => {
  const { execFileSync } = await import("node:child_process");
  // Write a string, not a number: console.log(1) is colourised on some terminals (seen on Windows), which breaks the comparison.
  const read = (tz: string) => execFileSync(process.execPath, ["--import", "tsx", "-e", "import('./src/config.ts').then(m => process.stdout.write(String(m.TZ_OFFSET)))"], { env: { ...process.env, TZ_OFFSET: tz, FORCE_COLOR: "0", NO_COLOR: "1" }, cwd: process.cwd(), encoding: "utf8" }).trim();
  assert.equal(read(""), "1");
  assert.equal(read("abc"), "1");
  assert.equal(read("3"), "3");
});
