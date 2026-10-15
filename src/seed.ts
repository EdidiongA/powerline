/**
 * Plausible hourly history for a household — the simulator's own curves plus day-to-day noise —
 * so reports and learning can be shown without waiting a week. Used by `npm run seed:history`
 * and, with SEED_HISTORY_DAYS set, by the server on start for households that have no readings
 * yet (simulated telemetry only: real inverters get real history).
 */
import { updateHousehold, getHousehold } from "./store/index.js";
import { clearSkyPvW, typicalLoadW } from "./telemetry/simulated.js";
import { TZ_OFFSET } from "./config.js";
import type { Sample } from "./store/types.js";

export function buildSeedSamples(days: number, endIso: string, arrayKw = 4.5, batteryKwh = 10, tz = TZ_OFFSET): Sample[] {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const end = new Date(endIso); if (Number.isNaN(end.getTime())) end.setTime(Date.now()); end.setUTCMinutes(0, 0, 0);
  const samples: Sample[] = [];
  let soc = 70;
  for (let i = Math.max(1, Math.round(days)) * 24; i >= 1; i--) {
    const at = new Date(end.getTime() - i * 3_600_000);
    const hr = (((at.getUTCHours() + tz) % 24) + 24) % 24;
    const cloud = 0.55 + 0.45 * rnd();                       // some days are dull
    const pv = Math.round(clearSkyPvW(hr, arrayKw) * cloud);
    const load = Math.round(typicalLoadW(hr) * (0.8 + 0.5 * rnd()) + (hr === 10 && rnd() < 0.5 ? 1800 : 0)); // an iron some mornings
    const grid = [[0, 6], [13, 16], [22, 24]].some(([a, b]) => hr >= a && hr < b) && rnd() < 0.8;
    const gridW = grid ? Math.max(0, load - pv) : 0;
    soc = Math.min(100, Math.max(10, soc + ((pv + gridW - load) / (batteryKwh * 1000)) * 100)); // 10 %: the inverter's cut-off
    samples.push({ at: at.toISOString(), pv_w: pv, load_w: load, soc_pct: Math.round(soc * 10) / 10, grid_on: grid });
  }
  return samples;
}

/** Write seed history for one household. With `onlyIfEmpty`, a household that already has readings is left alone. */
export async function seedHousehold(id: string, days: number, endIso: string, opts: { arrayKw?: number; batteryKwh?: number; onlyIfEmpty?: boolean } = {}): Promise<number> {
  if (opts.onlyIfEmpty && ((await getHousehold(id)).samples?.length ?? 0) > 0) return 0;
  const samples = buildSeedSamples(days, endIso, opts.arrayKw, opts.batteryKwh);
  await updateHousehold(id, (h) => {
    h.samples = samples;
    if (!h.gridEvents.length) { let on: boolean | null = null; for (const s of samples) { if (s.grid_on !== on) { h.gridEvents.push({ at: s.at, on: s.grid_on === true }); on = s.grid_on; } } }
  });
  return samples.length;
}
