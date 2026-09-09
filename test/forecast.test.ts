import { test } from "node:test";
import assert from "node:assert/strict";
import { canRun, forecast, gridProbabilityByHour } from "../src/forecast.js";
import { clearSkyPvW, typicalLoadW } from "../src/telemetry/simulated.js";

const profile = { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 };
const night = () => ({ profile, socPct: 60, pvForecastW: new Array(24).fill(0), loadForecastW: new Array(24).fill(400), gridForecast: new Array(24).fill(false) });

test("SOC stays within [0,100] for random inputs", () => {
  for (let i = 0; i < 200; i++) {
    const r = forecast({ profile, socPct: Math.random() * 100,
      pvForecastW: Array.from({ length: 24 }, () => Math.random() * 6000),
      loadForecastW: Array.from({ length: 24 }, () => Math.random() * 3000),
      gridForecast: Array.from({ length: 24 }, () => Math.random() > 0.5) });
    for (const p of r.points) assert.ok(p.socPct >= 0 && p.socPct <= 100);
  }
});

test("no PV, no grid: 400 W on a 10 kWh battery from 60% hits 20% floor in ~10h", () => {
  const r = forecast(night());
  assert.ok(r.hitsFloor);
  assert.ok(r.hoursToFloor! > 9 && r.hoursToFloor! < 11, `got ${r.hoursToFloor}`);
});

test("grid on covers the load: SOC never drops", () => {
  const r = forecast({ ...night(), gridForecast: new Array(24).fill(true) });
  assert.equal(r.minSocPct, 60);
});

test("adding an appliance never raises minimum SOC (monotonic)", () => {
  const base = { profile, socPct: 70, pvForecastW: Array.from({ length: 24 }, (_, h) => clearSkyPvW((8 + h) % 24, 4.5)), loadForecastW: Array.from({ length: 24 }, (_, h) => typicalLoadW((8 + h) % 24)), gridForecast: new Array(24).fill(false) };
  const a = forecast(base);
  const b = forecast({ ...base, extraLoads: [{ startHour: 0, watts: 1500, minutes: 60 }] });
  assert.ok(b.minSocPct <= a.minSocPct);
});

test("canRun refuses a 2 kW load at night on a low battery and suggests a daytime slot", () => {
  const base = { profile, socPct: 25, pvForecastW: Array.from({ length: 24 }, (_, h) => clearSkyPvW((22 + h) % 24, 4.5)), loadForecastW: new Array(24).fill(300), gridForecast: new Array(24).fill(false) };
  const r = canRun(base, { name: "iron", watts: 2000, minutes: 60 });
  assert.equal(r.ok, false);
  assert.ok(r.bestStartHour !== null && r.bestStartHour >= 8, `best start ${r.bestStartHour}`);
});

test("canRun rejects loads above inverter rating", () => {
  const r = canRun({ ...night(), socPct: 95 }, { name: "welder", watts: 6000, minutes: 10 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /inverter/);
});

test("grid probability learned from events", () => {
  const ev = [
    { at: "2026-09-07T00:00:00Z", on: true },  // Monday 00:00 UTC
    { at: "2026-09-07T06:00:00Z", on: false },
    { at: "2026-09-07T13:00:00Z", on: true },
    { at: "2026-09-07T16:00:00Z", on: false },
  ];
  const p = gridProbabilityByHour(ev, 1);
  assert.equal(p[2], 1);
  assert.equal(p[9], 0);
  assert.equal(p[14], 1);
});

test("planDay schedules heavy loads into daylight and never breaches the floor", async () => {
  const { planDay } = await import("../src/forecast.js");
  const base = { profile, socPct: 40, pvForecastW: Array.from({ length: 24 }, (_, h) => clearSkyPvW((6 + h) % 24, 4.5)), loadForecastW: Array.from({ length: 24 }, (_, h) => typicalLoadW((6 + h) % 24)), gridForecast: new Array(24).fill(false) };
  const plan = planDay(base, [
    { name: "washing machine", watts: 500, minutes: 45 },
    { name: "iron", watts: 2000, minutes: 30 },
    { name: "pump", watts: 750, minutes: 60 },
  ]);
  assert.equal(plan.hitsFloor, false);
  for (const it of plan.items) {
    assert.ok(it.startHour !== null, `${it.name} unscheduled`);
    assert.ok(it.startHour! >= 2 && it.startHour! <= 12, `${it.name} at +${it.startHour}h (06:00 base) should be daytime`);
  }
});

test("planDay still schedules surplus-only slots when the battery will breach overnight anyway", async () => {
  const { planDay } = await import("../src/forecast.js");
  const base = { profile, socPct: 25, pvForecastW: Array.from({ length: 24 }, (_, h) => clearSkyPvW((21 + h) % 24, 4.5)), loadForecastW: new Array(24).fill(300), gridForecast: new Array(24).fill(false) };
  const plan = planDay(base, [{ name: "iron", watts: 2000, minutes: 30 }, { name: "washing machine", watts: 500, minutes: 45 }]);
  for (const it of plan.items) { assert.ok(it.startHour !== null, `${it.name} unscheduled`); assert.equal(it.onSurplus, true); }
});

test("starting at or below the reserve reports hitsFloor immediately", () => {
  const r = forecast({ ...night(), socPct: 5 });
  assert.equal(r.hitsFloor, true);
  assert.equal(r.hoursToFloor, 0);
});

test("planDay labels a night slot covered by grid as grid, not solar", async () => {
  const { planDay } = await import("../src/forecast.js");
  const base = { profile, socPct: 68, pvForecastW: new Array(24).fill(0), loadForecastW: new Array(24).fill(300), gridForecast: new Array(24).fill(true) };
  const plan = planDay(base, [{ name: "iron", watts: 2000, minutes: 30 }]);
  assert.equal(plan.items[0].source, "grid");
  assert.equal(plan.items[0].onSurplus, false);
});
