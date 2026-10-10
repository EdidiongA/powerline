/**
 * Property tests for the forecast engine: thousands of random households, a handful of
 * invariants that must hold for every one of them. A seeded generator keeps failures
 * reproducible (the seed is printed on failure).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canRun, dueReminders, forecast, gridProbabilityByHour, planDay, type Appliance, type ForecastInput } from "../src/forecast.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomInput(r: () => number): ForecastInput {
  const arrayKw = 0.5 + r() * 12;
  const profile = { arrayKw, batteryKwh: 1 + r() * 30, inverterKw: 1 + r() * 10, reserveSocPct: Math.floor(r() * 60) };
  const mid = r() * 24;
  return {
    profile,
    socPct: r() * 100,
    pvForecastW: Array.from({ length: 24 }, (_, h) => Math.max(0, Math.round(arrayKw * 800 * Math.sin(Math.PI * (((h + mid) % 24) / 13))))),
    loadForecastW: Array.from({ length: 24 }, () => Math.round(100 + r() * 2500)),
    gridForecast: Array.from({ length: 24 }, () => (r() < 0.2 ? null : r() < 0.5)),
  };
}

function randomAppliances(r: () => number): Appliance[] {
  return Array.from({ length: Math.floor(r() * 6) }, (_, i) => ({ name: `a${i}`, watts: Math.round(50 + r() * 4000), minutes: Math.round(5 + r() * 240) }));
}

const finite = (v: number) => Number.isFinite(v);

test("forecast: every point is finite and within [0, 100]; hoursToFloor agrees with hitsFloor", () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const r = rng(seed);
    const input = randomInput(r);
    const f = forecast(input);
    assert.equal(f.points.length, 24, `seed ${seed}`);
    for (const p of f.points) {
      assert.ok(finite(p.socPct) && p.socPct >= 0 && p.socPct <= 100, `seed ${seed}: soc ${p.socPct}`);
      assert.ok(finite(p.batteryW) && finite(p.loadW) && finite(p.pvW), `seed ${seed}`);
      assert.ok(p.loadW <= input.profile.inverterKw * 1500 + 1, `seed ${seed}: load above sanity cap`);
    }
    assert.ok(finite(f.minSocPct) && f.minSocPct <= f.points[0].socPct + 0.11, `seed ${seed}: min above first point`);
    assert.equal(f.hitsFloor, f.hoursToFloor !== null, `seed ${seed}`);
    if (input.socPct <= input.profile.reserveSocPct) assert.equal(f.hoursToFloor, 0, `seed ${seed}: already below → 0`);
    if (f.hoursToFloor !== null) assert.ok(f.hoursToFloor >= 0 && f.hoursToFloor <= 24, `seed ${seed}`);
  }
});

test("forecast: adding load never raises the state of charge at any point", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed);
    const input = randomInput(r);
    const a = { startHour: Math.floor(r() * 20), watts: 100 + r() * 3000, minutes: 10 + r() * 180 };
    const base = forecast(input);
    const withLoad = forecast({ ...input, extraLoads: [a] });
    for (let h = 0; h < 24; h++) assert.ok(withLoad.points[h].socPct <= base.points[h].socPct + 0.11, `seed ${seed} hour ${h}`);
    assert.ok(withLoad.minSocPct <= base.minSocPct + 0.11, `seed ${seed}`);
  }
});

test("planDay: one item per appliance, inverter respected, reserve kept whenever the baseline keeps it", () => {
  for (let seed = 1; seed <= 800; seed++) {
    const r = rng(seed);
    const input = randomInput(r);
    const apps = randomAppliances(r);
    const plan = planDay(input, apps);
    assert.equal(plan.items.length, apps.length, `seed ${seed}`);
    assert.ok(finite(plan.minSocPct), `seed ${seed}`);
    const floor = input.profile.reserveSocPct;
    const baselineOk = !forecast(input).hitsFloor;
    for (const it of plan.items) {
      if (it.startHour === null) { assert.equal(it.source, "none", `seed ${seed}`); assert.ok(it.reason.length > 0); continue; }
      assert.ok(it.startHour >= 0 && it.startHour + Math.ceil(it.minutes / 60) <= 24, `seed ${seed}: ${it.name} at ${it.startHour}`);
      assert.ok(it.watts + input.loadForecastW[it.startHour] <= input.profile.inverterKw * 1000, `seed ${seed}: inverter exceeded`);
      assert.notEqual(it.source, "none", `seed ${seed}`);
      if (it.source === "solar") assert.equal(it.onSurplus, true, `seed ${seed}`);
    }
    if (baselineOk && plan.items.some((i) => i.startHour !== null)) assert.ok(plan.minSocPct > floor, `seed ${seed}: plan breached a reserve the baseline kept (${plan.minSocPct} ≤ ${floor})`);
    // Sorted by start time, unscheduled last.
    const starts = plan.items.map((i) => i.startHour ?? 99);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `seed ${seed}: not sorted`);
  }
});

test("canRun: 'ok' means the reserve holds; a best start, when given, fits the horizon and the inverter", () => {
  for (let seed = 1; seed <= 800; seed++) {
    const r = rng(seed);
    const input = randomInput(r);
    const app = { name: "x", watts: Math.round(50 + r() * 5000), minutes: Math.round(5 + r() * 240) };
    const res = canRun(input, app);
    const floor = input.profile.reserveSocPct;
    if (res.ok) assert.ok(res.minSocWithPct > floor, `seed ${seed}`);
    assert.ok(finite(res.socAfterPct) && finite(res.minSocWithPct) && finite(res.minSocWithoutPct), `seed ${seed}`);
    assert.ok(res.minSocWithPct <= res.minSocWithoutPct + 0.11, `seed ${seed}: running it raised the minimum`);
    if (res.bestStartHour !== null) {
      const run = Math.ceil(app.minutes / 60);
      assert.ok(res.bestStartHour >= 1 && res.bestStartHour + run <= 24, `seed ${seed}: best start ${res.bestStartHour}`);
      assert.ok(app.watts + input.loadForecastW[res.bestStartHour] <= input.profile.inverterKw * 1000, `seed ${seed}`);
    }
    assert.ok(res.reason.length > 0);
  }
});

test("gridProbabilityByHour: values in [0,1] or null; unsorted and mixed-format timestamps handled", () => {
  const ev = [
    { at: "2026-10-05T10:00:00+00:00", on: true },
    { at: "2026-10-05T06:00:00Z", on: false },
    { at: "2026-10-05T02:00:00.000Z", on: true },
    { at: "2026-10-05T14:00:00Z", on: false },
  ];
  const p = gridProbabilityByHour(ev, new Date("2026-10-05T00:00:00Z").getUTCDay());
  assert.equal(p.length, 24);
  for (const v of p) assert.ok(v === null || (v >= 0 && v <= 1));
  assert.equal(p[3], 1, "02–06 on");
  assert.equal(p[8], 0, "06–10 off");
  assert.equal(p[12], 1, "10–14 on");
  assert.equal(p[20], null, "no evidence after 14:00");
  assert.ok(gridProbabilityByHour(ev, Number.NaN).every((v) => v === null));
});

test("dueReminders never returns fired items, future items, or items older than the grace window", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const now = Date.UTC(2026, 9, 1, 12);
    const items = Array.from({ length: 8 }, (_, i) => ({ name: `i${i}`, startAt: new Date(now + (r() - 0.6) * 4 * 3.6e6).toISOString(), firedAt: r() < 0.3 ? "x" : undefined }));
    const grace = 5 + Math.floor(r() * 120);
    for (const d of dueReminders(items, new Date(now).toISOString(), grace)) {
      assert.equal(d.firedAt, undefined, `seed ${seed}`);
      const at = Date.parse(d.startAt);
      assert.ok(at <= now && now - at <= grace * 60_000, `seed ${seed}`);
    }
  }
});
