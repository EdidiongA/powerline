/**
 * Seed N days of plausible hourly history for a household, so reports and learning can be
 * demonstrated without waiting a week. Uses the simulator's own curves plus day-to-day noise.
 *
 *   npm run seed:history                   # 7 days for the demo household
 *   SEED_DAYS=14 SEED_HOUSEHOLD=lagos-home npm run seed:history
 *   STORE=dynamodb npm run seed:history    # same, into DynamoDB
 *   node dist/seed-history.js               # after npm run build (what the Docker image has)
 */
import { updateHousehold, storeHealth } from "./store/index.js";
import { clearSkyPvW, typicalLoadW } from "./telemetry/simulated.js";
import { TZ_OFFSET } from "./config.js";
import type { Sample } from "./store/types.js";

const days = Number(process.env.SEED_DAYS ?? 7);
const id = process.env.SEED_HOUSEHOLD ?? process.env.DEMO_USER_ID ?? "demo-household";
const arrayKw = Number(process.env.SIM_ARRAY_KW ?? 4.5), batteryKwh = Number(process.env.SIM_BATTERY_KWH ?? 10);
const endIso = process.env.SEED_END ?? new Date().toISOString();

let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const end = new Date(endIso); end.setUTCMinutes(0, 0, 0);
const samples: Sample[] = [];
let soc = 70;
for (let i = days * 24; i >= 1; i--) {
  const at = new Date(end.getTime() - i * 3_600_000);
  const hr = (at.getUTCHours() + TZ_OFFSET + 24) % 24;
  const cloud = 0.55 + 0.45 * rnd();                       // some days are dull
  const pv = Math.round(clearSkyPvW(hr, arrayKw) * cloud);
  const load = Math.round(typicalLoadW(hr) * (0.8 + 0.5 * rnd()) + (hr === 10 && rnd() < 0.5 ? 1800 : 0)); // an iron some mornings
  const grid = [[0, 6], [13, 16], [22, 24]].some(([a, b]) => hr >= a && hr < b) && rnd() < 0.8;
  const gridW = grid ? Math.max(0, load - pv) : 0;
  soc = Math.min(100, Math.max(5, soc + ((pv + gridW - load) / (batteryKwh * 1000)) * 100));
  samples.push({ at: at.toISOString(), pv_w: pv, load_w: load, soc_pct: Math.round(soc * 10) / 10, grid_on: grid });
}
await updateHousehold(id, (h) => { h.samples = samples; if (!h.gridEvents.length) { let on: boolean | null = null; for (const s of samples) { if (s.grid_on !== on) { h.gridEvents.push({ at: s.at, on: s.grid_on === true }); on = s.grid_on; } } } });
const health = await storeHealth();
console.log(`Seeded ${samples.length} hourly samples (${days} days) for "${id}" into ${health.backend} — ${health.detail}`);
