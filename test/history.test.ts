import { test } from "node:test";
import assert from "node:assert/strict";
import { autonomyHours, dailyReports, learnedLoadProfile, learnedPvFactor, periodSamples, summarize } from "../src/history.js";
import { clearSkyPvW } from "../src/telemetry/simulated.js";
import type { Sample } from "../src/store/types.js";

const TZ = 1;
/** `days` full days of hourly samples ending at `endIso` (exclusive); pass a local-midnight instant for whole days. */
function make(days: number, endIso: string, shape: (localHour: number, day: number) => Partial<Sample>): Sample[] {
  const end = Date.parse(endIso);
  const out: Sample[] = [];
  for (let i = days * 24; i >= 1; i--) {
    const at = new Date(end - i * 3_600_000);
    const hr = (at.getUTCHours() + TZ) % 24;
    const day = Math.floor((days * 24 - i) / 24);
    out.push({ at: at.toISOString(), pv_w: 0, load_w: 300, soc_pct: 60, grid_on: false, ...shape(hr, day) });
  }
  return out;
}

test("dailyReports adds up energy per local day and counts grid hours and reserve breaches", () => {
  const s = make(2, "2026-10-02T23:00:00Z", (hr) => ({ pv_w: hr >= 7 && hr <= 17 ? 2000 : 0, load_w: 500, grid_on: hr < 6, soc_pct: hr === 5 ? 18 : 50 }));
  const days = dailyReports(s, TZ, 20);
  assert.equal(days.length, 2);
  for (const d of days) {
    assert.equal(d.hours, 24);
    assert.equal(d.solarKwh, 22);          // 11 h × 2 kW
    assert.equal(d.loadKwh, 12);           // 24 h × 0.5 kW
    assert.equal(d.gridHours, 6);
    assert.equal(d.gridKwh, 3);            // 6 h × 0.5 kW, no pv at night
    assert.equal(d.minSocPct, 18);
    assert.equal(d.hoursBelowReserve, 1);
    assert.equal(d.solarSharePct, 100);
  }
  assert.ok(days[0].date < days[1].date, "oldest first");
});

test("summarize prices grid energy and values self-used solar; null without a tariff", () => {
  const s = make(1, "2026-10-01T23:00:00Z", (hr) => ({ pv_w: hr >= 8 && hr <= 15 ? 1000 : 0, load_w: 400, grid_on: hr < 4 }));
  const sum = summarize(dailyReports(s, TZ, 20), { currency: "NGN", perKwh: 225 });
  assert.equal(sum.gridKwh, 1.6);                      // 4 h × 0.4 kW
  assert.equal(sum.gridCost, 360);
  assert.equal(sum.solarValue, Math.round((9.6 - 1.6) * 225 * 100) / 100);
  assert.equal(sum.solarSharePct, Math.round(((9.6 - 1.6) / 9.6) * 100));
  assert.equal(summarize(dailyReports(s, TZ, 20), null).gridCost, null);
  assert.equal(summarize([], null).minSocPct, 100);
});

test("periodSamples slices today / yesterday / week in local time", () => {
  const s = make(10, "2026-10-10T12:00:00Z", () => ({}));
  const now = "2026-10-10T11:30:00Z"; // 12:30 Lagos
  assert.equal(periodSamples(s, "today", now, TZ).length, 13, "00:00–12:00 local inclusive");
  assert.equal(periodSamples(s, "yesterday", now, TZ).length, 24);
  assert.equal(periodSamples(s, "week", now, TZ).length, 6 * 24 + 13, "seven local days: today plus the six before it, never eight");
});

test("learnedLoadProfile needs three full days, then returns the per-hour median", () => {
  const two = make(2, "2026-10-03T00:00:00Z", (hr) => ({ load_w: 100 + hr * 10 }));
  assert.equal(learnedLoadProfile(two, TZ), null);
  const five = make(5, "2026-10-06T00:00:00Z", (hr, day) => ({ load_w: day === 2 ? 5000 : 100 + hr * 10 })); // one wild day
  const p = learnedLoadProfile(five, TZ)!;
  assert.equal(p.length, 24);
  assert.equal(p[7], 170, "median ignores the wild day");
  assert.equal(p[20], 300);
});

test("learnedPvFactor measures real yield against clear-sky, ignoring night and dawn", () => {
  const half = make(3, "2026-10-04T00:00:00Z", (hr) => ({ pv_w: Math.round(clearSkyPvW(hr, 4.5) * 0.5) }));
  assert.equal(learnedPvFactor(half, TZ, 4.5), 0.5);
  assert.equal(learnedPvFactor(half.slice(0, 10), TZ, 4.5), null, "too few daylight hours");
  const better = make(3, "2026-10-04T00:00:00Z", (hr) => ({ pv_w: Math.round(clearSkyPvW(hr, 4.5) * 1.2) }));
  assert.equal(learnedPvFactor(better, TZ, 4.5), 1.2);
});

test("autonomyHours: no grid, night load only, reaches the reserve at the expected hour", () => {
  const profile = { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 };
  const input = { profile, socPct: 60, pvForecastW: Array(24).fill(0), loadForecastW: Array(24).fill(1000), gridForecast: Array(24).fill(true) };
  // 40 % of 10 kWh = 4 kWh at 1 kW → 4 h, regardless of the grid forecast (the question assumes no grid).
  assert.equal(autonomyHours(input, profile), 4);
  assert.equal(autonomyHours({ ...input, socPct: 15 }, profile), null);
  assert.equal(autonomyHours({ ...input, loadForecastW: Array(24).fill(10) }, profile), 48, "tiny load → effectively indefinite");
});

test("history functions survive hostile samples and never teach the forecast that the sun died", () => {
  const bad = [
    { at: "garbage", pv_w: 1, load_w: 1, soc_pct: 1, grid_on: null },
    { at: "2026-10-01T10:00:00Z", pv_w: NaN, load_w: 1, soc_pct: 1, grid_on: null },
    null as unknown as Sample,
  ] as Sample[];
  assert.deepEqual(dailyReports(bad, TZ, 20), []);
  assert.deepEqual(periodSamples(bad, "week", "2026-10-02T00:00:00Z", TZ), []);
  assert.deepEqual(periodSamples(bad, "week", "not a time", TZ), []);
  assert.equal(learnedLoadProfile(bad, TZ), null);
  assert.equal(learnedPvFactor(bad, TZ, 4.5), null);
  // A broken adapter reporting 0 W all week must not produce a zero yield factor or a zero load shape.
  const dead = make(5, "2026-10-06T00:00:00Z", () => ({ pv_w: 0, load_w: 0 }));
  assert.equal(learnedPvFactor(dead, TZ, 4.5), null, "dead readings are not evidence");
  assert.equal(learnedLoadProfile(dead, TZ), null);
  const dim = make(5, "2026-10-06T00:00:00Z", (hr) => ({ pv_w: Math.round(clearSkyPvW(hr, 4.5) * 0.05), load_w: 300 }));
  assert.equal(learnedPvFactor(dim, TZ, 4.5), 0.25, "floor at a quarter of clear-sky");
  const profile = { arrayKw: 4.5, batteryKwh: 0, inverterKw: 5, reserveSocPct: 20 };
  assert.equal(autonomyHours({ profile, socPct: NaN, pvForecastW: [], loadForecastW: [], gridForecast: [] }, profile), null);
});
