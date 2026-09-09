/**
 * Forecast engine — pure functions, no I/O, property-tested.
 *
 * Model: net_w(t) = pv_w(t) + grid_w(t) - load_w(t); SOC integrates net energy
 * over battery capacity, clamped to [floor, 100]. Grid, when available, covers
 * any deficit so the battery only discharges when the grid is off.
 */
export interface SystemProfile {
  arrayKw: number;
  batteryKwh: number;
  inverterKw: number;
  reserveSocPct: number;       // floor the household wants to protect (e.g. 20)
  usableDepthPct?: number;     // e.g. 80 for LiFePO4 (SOC below 100-usable is unusable)
}

export interface Appliance {
  name: string;
  watts: number;
  minutes: number;             // typical run length
}

export interface ForecastInput {
  profile: SystemProfile;
  socPct: number;
  pvForecastW: number[];       // hourly, index 0 = current hour
  loadForecastW: number[];     // hourly
  gridForecast: Array<boolean | null>; // hourly; null = unknown → treated as off (conservative)
  extraLoads?: Array<{ startHour: number; watts: number; minutes: number }>;
}

export interface ForecastPoint {
  hour: number;
  socPct: number;
  pvW: number;
  loadW: number;
  gridOn: boolean;
  batteryW: number;
}

export interface ForecastResult {
  points: ForecastPoint[];
  minSocPct: number;
  hoursToFloor: number | null; // null = never reaches floor within horizon
  hitsFloor: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function forecast(input: ForecastInput, horizonHours = 24, stepsPerHour = 4): ForecastResult {
  const { profile } = input;
  const capWh = profile.batteryKwh * 1000;
  const floor = profile.reserveSocPct;
  let soc = input.socPct;
  const points: ForecastPoint[] = [];
  let minSoc = soc;
  let hoursToFloor: number | null = null;
  const dt = 1 / stepsPerHour;

  for (let h = 0; h < horizonHours; h++) {
    const pv = input.pvForecastW[h] ?? 0;
    const gridOn = input.gridForecast[h] ?? false;
    let load = input.loadForecastW[h] ?? 0;
    for (const x of input.extraLoads ?? []) {
      // Distribute the appliance's energy across the hours it overlaps.
      const start = x.startHour, end = x.startHour + x.minutes / 60;
      const overlap = Math.max(0, Math.min(h + 1, end) - Math.max(h, start));
      load += x.watts * overlap; // W-equivalent averaged over this hour
    }
    load = Math.min(load, profile.inverterKw * 1000 * 1.5); // sanity cap
    const gridW = gridOn ? Math.max(0, load - pv) : 0;
    const batteryW = pv + gridW - load;

    for (let s = 0; s < stepsPerHour; s++) {
      const prev = soc;
      soc = clamp(soc + ((batteryW * dt) / capWh) * 100, 0, 100);
      if (hoursToFloor === null && prev > floor && soc <= floor) hoursToFloor = h + (s + 1) * dt;
      minSoc = Math.min(minSoc, soc);
    }
    points.push({ hour: h, socPct: round1(soc), pvW: pv, loadW: Math.round(load), gridOn, batteryW: Math.round(batteryW) });
  }
  return { points, minSocPct: round1(minSoc), hoursToFloor, hitsFloor: hoursToFloor !== null };
}

export interface CanRunResult {
  ok: boolean;
  socAfterPct: number;
  minSocWithPct: number;
  minSocWithoutPct: number;
  bestStartHour: number | null; // earliest hour in horizon where running keeps SOC above floor
  reason: string;
}

/** Can appliance run starting now (hour 0) without breaching the reserve floor? If not, when? */
export function canRun(base: ForecastInput, appliance: Appliance, horizonHours = 24): CanRunResult {
  const without = forecast(base, horizonHours);
  const withNow = forecast({ ...base, extraLoads: [...(base.extraLoads ?? []), { startHour: 0, watts: appliance.watts, minutes: appliance.minutes }] }, horizonHours);
  const floor = base.profile.reserveSocPct;
  const overInverter = appliance.watts + (base.loadForecastW[0] ?? 0) > base.profile.inverterKw * 1000;
  const runHours = Math.ceil(appliance.minutes / 60);
  const socAfter = withNow.points[Math.max(0, runHours - 1)]?.socPct ?? withNow.points[0].socPct;

  let bestStart: number | null = null;
  if (!(withNow.minSocPct > floor) || overInverter) {
    for (let h = 1; h < horizonHours - runHours; h++) {
      const trial = forecast({ ...base, extraLoads: [...(base.extraLoads ?? []), { startHour: h, watts: appliance.watts, minutes: appliance.minutes }] }, horizonHours);
      const fitsInverter = appliance.watts + (base.loadForecastW[h] ?? 0) <= base.profile.inverterKw * 1000;
      // Acceptable if it keeps SOC above the floor, or — when the baseline already breaches —
      // if it runs on surplus and does not lower the minimum SOC further.
      const onSurplus = trial.points.slice(h, h + runHours).every((pt) => pt.batteryW >= 0); // PV covers it
      const harmless = trial.minSocPct > floor || onSurplus;
      if (fitsInverter && harmless) { bestStart = h; break; }
    }
  }

  if (overInverter) {
    return { ok: false, socAfterPct: socAfter, minSocWithPct: withNow.minSocPct, minSocWithoutPct: without.minSocPct, bestStartHour: bestStart,
      reason: `${appliance.name} (${appliance.watts} W) plus current load would exceed the ${base.profile.inverterKw} kW inverter.` };
  }
  const ok = withNow.minSocPct > floor;
  const reason = ok
    ? `Battery stays above the ${floor}% reserve (lowest ${withNow.minSocPct}% in the next ${horizonHours}h).`
    : `Running now would drop the battery to ${withNow.minSocPct}% (reserve is ${floor}%).`;
  return { ok, socAfterPct: socAfter, minSocWithPct: withNow.minSocPct, minSocWithoutPct: without.minSocPct, bestStartHour: bestStart, reason };
}

/** Learn hourly grid-availability probabilities from logged on/off events (per weekday). */
export interface GridEvent { at: string; on: boolean }

export function gridProbabilityByHour(events: GridEvent[], weekday: number): number[] {
  // Reconstruct on/off intervals from the event log, then bin by hour for the given weekday.
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const onMinutes = new Array<number>(24).fill(0);
  const totMinutes = new Array<number>(24).fill(0);
  for (let i = 0; i < sorted.length; i++) {
    const start = new Date(sorted[i].at);
    const end = i + 1 < sorted.length ? new Date(sorted[i + 1].at) : new Date(start.getTime() + 24 * 3.6e6);
    const on = sorted[i].on;
    for (let t = start.getTime(); t < end.getTime(); t += 15 * 60 * 1000) {
      const d = new Date(t);
      if (d.getUTCDay() !== weekday) continue;
      const h = d.getUTCHours();
      totMinutes[h] += 15;
      if (on) onMinutes[h] += 15;
    }
  }
  return onMinutes.map((m, h) => (totMinutes[h] ? m / totMinutes[h] : 0.5));
}

const round1 = (v: number) => Math.round(v * 10) / 10;
