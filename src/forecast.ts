/**
 * Forecast engine — pure functions, no I/O, property-tested.
 *
 * Model: net_w(t) = pv_w(t) + grid_w(t) - load_w(t); SOC integrates net energy
 * over battery capacity, clamped to [0, 100]; the reserve floor is a line the
 * household wants to stay above, not a physical limit. Grid, when available, covers
 * any deficit so the battery only discharges when the grid is off.
 */
export interface SystemProfile {
  arrayKw: number;
  batteryKwh: number;
  inverterKw: number;
  reserveSocPct: number;       // floor the household wants to protect (e.g. 20)
  tzOffset?: number;           // household UTC offset in hours; server default (TZ_OFFSET) when absent
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
  let hoursToFloor: number | null = soc <= floor ? 0 : null; // already at/below reserve
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
  // When the battery is already heading under the reserve regardless, a run that costs the battery
  // nothing (the grid or the sun carries it) is fine: it is the baseline, not the appliance.
  const baselineBreaches = !(without.minSocPct > floor);
  const coveredNow = baselineBreaches && withNow.minSocPct >= without.minSocPct && withNow.points.slice(0, runHours).every((p) => p.batteryW >= 0);

  let bestStart: number | null = null;
  if (!(withNow.minSocPct > floor || coveredNow) || overInverter) {
    for (let h = 1; h <= horizonHours - runHours; h++) {
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
  const ok = withNow.minSocPct > floor || coveredNow;
  const reason = coveredNow
    ? `The grid or the sun is covering it, so it costs the battery nothing — the battery heads to ${without.minSocPct}% tonight regardless (reserve ${floor}%).`
    : ok
    ? `Battery stays above the ${floor}% reserve (lowest ${withNow.minSocPct}% in the next ${horizonHours}h).`
    : withNow.minSocPct < without.minSocPct
    ? `Running now would drop the battery to ${withNow.minSocPct}% (reserve is ${floor}%).`
    : `The battery is already heading to ${without.minSocPct}% (reserve ${floor}%) and this run would draw on it.`;
  return { ok, socAfterPct: socAfter, minSocWithPct: withNow.minSocPct, minSocWithoutPct: without.minSocPct, bestStartHour: bestStart, reason };
}

/** Learn hourly grid-availability probabilities from logged on/off events (per weekday). */
export interface GridEvent { at: string; on: boolean }

/**
 * Returns, per UTC hour, the observed probability the grid was ON on the given weekday,
 * or null where there is less than `minMinutes` of evidence. Intervals longer than 24 h
 * (clock jumps, gaps in logging) are ignored rather than treated as one long state.
 */
export function gridProbabilityByHour(events: GridEvent[], weekday: number, minMinutes = 60): Array<number | null> {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const onMinutes = new Array<number>(24).fill(0);
  const totMinutes = new Array<number>(24).fill(0);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = new Date(sorted[i].at).getTime();
    const end = new Date(sorted[i + 1].at).getTime();
    if (end <= start || end - start > 24 * 3.6e6) continue;
    const on = sorted[i].on;
    for (let t = start; t < end; t += 15 * 60 * 1000) {
      const d = new Date(t);
      if (d.getUTCDay() !== weekday) continue;
      const h = d.getUTCHours();
      totMinutes[h] += 15;
      if (on) onMinutes[h] += 15;
    }
  }
  return onMinutes.map((m, h) => (totMinutes[h] >= minMinutes ? m / totMinutes[h] : null));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// ---- Day planner -----------------------------------------------------------

export interface PlanItem {
  name: string;
  watts: number;
  minutes: number;
  startHour: number | null;   // offset from now; null = could not be scheduled
  onSurplus: boolean;         // runs entirely on PV surplus (free)
  source: "solar" | "grid" | "battery" | "none";
  reason: string;
}

export interface DayPlan {
  items: PlanItem[];
  minSocPct: number;          // with all scheduled items applied
  hitsFloor: boolean;
}

/**
 * Greedy schedule: heaviest appliances first, each placed at the earliest slot
 * that keeps SOC above the reserve (preferring PV-surplus hours), with earlier
 * placements folded into the baseline so later ones see the real picture.
 */
export function planDay(base: ForecastInput, appliances: Appliance[], horizonHours = 24): DayPlan {
  const floor = base.profile.reserveSocPct;
  const extra: NonNullable<ForecastInput["extraLoads"]> = [...(base.extraLoads ?? [])];
  const items: PlanItem[] = [];
  const sorted = [...appliances].sort((a, b) => b.watts * b.minutes - a.watts * a.minutes);
  const baselineBreaches = forecast(base, horizonHours).hitsFloor;

  for (const a of sorted) {
    const runHours = Math.max(1, Math.ceil(a.minutes / 60));
    let placed: { h: number; onSurplus: boolean; source: "solar" | "grid" | "battery" } | null = null;
    let fitsSomewhere = false; // false → the inverter, not the battery, is what rules it out
    // Pass 1: prefer slots fully on PV surplus. Pass 2: any slot that keeps SOC above floor.
    for (const wantSurplus of [true, false]) {
      for (let h = 0; h <= horizonHours - runHours; h++) {
        if (a.watts + (base.loadForecastW[h] ?? 0) > base.profile.inverterKw * 1000) continue;
        fitsSomewhere = true;
        const trial = forecast({ ...base, extraLoads: [...extra, { startHour: h, watts: a.watts, minutes: a.minutes }] }, horizonHours);
        const run = trial.points.slice(h, h + runHours);
        const onSurplus = run.every((p) => p.pvW >= p.loadW);          // sun alone covers everything
        const onGrid = !onSurplus && run.every((p) => p.gridOn);        // grid covers the shortfall
        // Keep the floor intact; if the household is already going to breach it tonight,
        // still allow appliances that run entirely on PV surplus (they cost the battery nothing).
        const costsBatteryNothing = run.every((p) => p.batteryW >= 0);
        const ok = trial.minSocPct > floor || (baselineBreaches && costsBatteryNothing);
        if (ok && (!wantSurplus || onSurplus)) { placed = { h, onSurplus, source: onSurplus ? "solar" : onGrid ? "grid" : "battery" }; break; }
      }
      if (placed) break;
    }
    if (placed) {
      extra.push({ startHour: placed.h, watts: a.watts, minutes: a.minutes });
      const reason = { solar: "runs on solar surplus", grid: "runs on grid power", battery: "from battery; stays above reserve" }[placed.source];
      items.push({ name: a.name, watts: a.watts, minutes: a.minutes, startHour: placed.h, onSurplus: placed.onSurplus, source: placed.source, reason });
    } else {
      items.push({ name: a.name, watts: a.watts, minutes: a.minutes, startHour: null, onSurplus: false, source: "none",
        reason: !fitsSomewhere ? `${a.watts} W plus the household load exceeds the ${base.profile.inverterKw} kW inverter`
          : runHours > horizonHours ? "longer than the planning horizon"
          : baselineBreaches ? "no slot today where the sun or the grid covers it" : `no slot keeps the battery above ${floor}% today` });
    }
  }
  const f = forecast({ ...base, extraLoads: extra }, horizonHours);
  items.sort((x, y) => (x.startHour ?? 99) - (y.startHour ?? 99));
  return { items, minSocPct: f.minSocPct, hitsFloor: f.hitsFloor };
}


// ---- Armed plan: which reminders are due ------------------------------------

export interface DueCheckItem { name: string; startAt: string; firedAt?: string }

/**
 * Items whose start time has arrived (within `graceMinutes` — a reminder an hour
 * late is noise, not help) and which have not yet fired. Pure: safe to call from
 * every session's monitor; the store decides who marks it fired.
 */
export function dueReminders<T extends DueCheckItem>(items: T[], nowIso: string, graceMinutes = 20, ignoreFired = false): T[] {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return [];
  return items.filter((i) => {
    // `firedAt` is shared household state: it tells the card an item has started. It is NOT a
    // delivery receipt — several hosts may be open, and each must hear its own reminder.
    if (i.firedAt && !ignoreFired) return false;
    const at = Date.parse(i.startAt);
    return !Number.isNaN(at) && at <= now && now - at <= graceMinutes * 60_000;
  });
}
