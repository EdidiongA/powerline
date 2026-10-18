/**
 * History must not depend on anyone being connected: the server-level recorder samples every
 * household once per hour slot and logs grid flips, idempotently; seed-on-start fills a fresh
 * simulated household with a week of plausible readings; the simulator's battery respects its
 * cut-off instead of hitting 0 %.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiskStore } from "../src/store/disk.js";
import { getHousehold, setStore } from "../src/store/index.js";
import { startHistoryRecorder } from "../src/recorder.js";
import { seedHousehold, buildSeedSamples } from "../src/seed.js";
import { SimulatedSource } from "../src/telemetry/simulated.js";
import type { Telemetry, TelemetrySource } from "../src/telemetry/index.js";

const fresh = () => setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-rec-"))));

test("recorder: one sample per hour slot per household, grid flips logged, nothing doubled, telemetry failures survived", async () => {
  fresh();
  let t: Telemetry = { at: "2026-10-01T20:10:00.000Z", pv_w: 0, load_w: 300, battery_w: -300, soc_pct: 60, grid_w: 0, grid_available: false, source: "fake" };
  let fail = false;
  const source: TelemetrySource = { name: "fake", current: async () => { if (fail) throw new Error("boom"); return t; } };
  const rec = startHistoryRecorder(source, () => ["home-a", "home-b"], 60_000);
  try {
    await rec.tick(); await rec.tick();                                   // same slot twice → one sample
    t = { ...t, at: "2026-10-01T20:40:00.000Z" }; await rec.tick();        // still 20:xx → still one
    t = { ...t, at: "2026-10-01T21:05:00.000Z", grid_available: true }; await rec.tick(); // new slot + grid flip
    fail = true; await rec.tick(); fail = false;                           // telemetry outage: no throw, no write
    t = { ...t, at: "2026-10-01T22:05:00.000Z", soc_pct: Number.NaN }; await rec.tick(); // unusable reading: skipped
    for (const id of ["home-a", "home-b"]) {
      const h = await getHousehold(id);
      assert.deepEqual(h.samples!.map((s) => s.at), ["2026-10-01T20:00:00.000Z", "2026-10-01T21:00:00.000Z"], id);
      assert.deepEqual(h.gridEvents.map((e) => e.on), [true], `${id}: the flip to grid-on was logged once`);
    }
  } finally { rec.stop(); }
});

test("seed: a household with no readings gets N days ending at the given instant; one with readings is left alone", async () => {
  fresh();
  const n = await seedHousehold("judge", 7, "2026-10-01T20:00:00Z", { onlyIfEmpty: true });
  assert.equal(n, 7 * 24);
  const h = await getHousehold("judge");
  assert.equal(h.samples!.length, 168);
  assert.equal(h.samples![h.samples!.length - 1].at, "2026-10-01T19:00:00.000Z", "the last seeded hour is the one before the clock start");
  assert.ok(h.samples!.every((s) => s.soc_pct >= 10 && s.soc_pct <= 100 && Number.isFinite(s.pv_w) && Number.isFinite(s.load_w)));
  assert.ok(h.gridEvents.length > 0, "grid pattern seeded too");
  assert.equal(await seedHousehold("judge", 7, "2026-10-05T00:00:00Z", { onlyIfEmpty: true }), 0, "never overwrites real readings");
  assert.equal(buildSeedSamples(0, "garbage").length, 24, "nonsense inputs still yield a day");
});

test("simulator: the battery stops at the inverter cut-off, never 0 %", async () => {
  const sim = new SimulatedSource({ arrayKw: 4.5, batteryKwh: 2, startSoc: 15, clockStart: new Date("2026-10-01T18:00:00Z"), speed: 100_000 });
  let min = 100, t = await sim.current();
  for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 5)); t = await sim.current(); min = Math.min(min, t.soc_pct); }
  assert.ok(min >= 10, `lowest SOC seen was ${min}%`);
  assert.ok(t.load_w <= t.pv_w + t.grid_w + 1, "at the cut-off the house only draws what the sun or grid can carry — nothing from nowhere");
  assert.ok(min <= 10.5, "it did reach the cut-off, so the clamp was exercised");
  const strict = new SimulatedSource({ arrayKw: 4.5, batteryKwh: 2, startSoc: 25, clockStart: new Date("2026-10-01T18:00:00Z"), speed: 100_000, cutoffSocPct: 20 });
  let m2 = 100; for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 5)); m2 = Math.min(m2, (await strict.current()).soc_pct); }
  assert.ok(m2 >= 20);
});

test("simulator: SIM_STEADY gives the same reading every time for a frozen clock (filming), the default wobbles", async () => {
  const mk = (steady: boolean) => new SimulatedSource({ arrayKw: 4.5, batteryKwh: 10, startSoc: 64, clockStart: new Date("2026-10-01T19:00:00Z"), speed: 1e-9, steady });
  const steady = mk(true), wobbly = mk(false);
  const s = await Promise.all([1, 2, 3, 4, 5].map(() => steady.current()));
  assert.equal(new Set(s.map((r) => r.load_w)).size, 1, "steady: one load value");
  const w: number[] = []; for (let i = 0; i < 5; i++) w.push((await wobbly.current()).load_w);
  assert.ok(new Set(w).size > 1, "default: readings vary");
});
