/**
 * History and learning — pure functions over the household's own hourly samples.
 *
 * The alert monitor records one sample per hour. From those, Powerline:
 *   - reports what actually happened (solar made, house used, grid hours, cost, worst SOC);
 *   - learns the household's own load shape and the array's real yield, replacing the
 *     generic curves once there is enough evidence, so forecasts improve with use;
 *   - answers "if the grid went off now, how long would the battery last?".
 */
import type { Sample, Tariff } from "./store/types.js";
import type { ForecastInput, SystemProfile } from "./forecast.js";
import { clearSkyPvW } from "./telemetry/simulated.js";

const HOUR = 3_600_000;
const localDay = (iso: string, tz: number) => new Date(Date.parse(iso) + tz * HOUR).toISOString().slice(0, 10);
const localHour = (iso: string, tz: number) => new Date(Date.parse(iso) + tz * HOUR).getUTCHours();
/** Samples the arithmetic can trust: a parseable time and finite numbers. Dead readings (0 W in and out) are kept for reports but excluded from learning. */
const usable = (s: Sample) => !!s && typeof s.at === "string" && !Number.isNaN(Date.parse(s.at)) && Number.isFinite(s.pv_w) && Number.isFinite(s.load_w) && Number.isFinite(s.soc_pct);
const alive = (s: Sample) => usable(s) && !(s.pv_w === 0 && s.load_w === 0);

export interface DayReport {
  date: string;            // local YYYY-MM-DD
  hours: number;           // samples that day (24 = complete)
  solarKwh: number;
  loadKwh: number;
  gridHours: number;       // hours the grid was on (null readings count as off)
  gridKwh: number;         // energy the grid covered (load − pv while on, floored at 0)
  minSocPct: number;
  hoursBelowReserve: number;
  solarSharePct: number;   // of load, 0..100
}

/** One row per local day, oldest first. Energy is the hourly W reading treated as the hour's average. */
export function dailyReports(samples: Sample[], tz: number, reserve: number): DayReport[] {
  const days = new Map<string, Sample[]>();
  for (const s of samples.filter(usable)) {
    const d = localDay(s.at, tz);
    (days.get(d) ?? days.set(d, []).get(d)!).push(s);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
    const solarWh = rows.reduce((a, r) => a + r.pv_w, 0);
    const loadWh = rows.reduce((a, r) => a + r.load_w, 0);
    const gridWh = rows.reduce((a, r) => a + (r.grid_on ? Math.max(0, r.load_w - r.pv_w) : 0), 0);
    return {
      date, hours: rows.length,
      solarKwh: round2(solarWh / 1000), loadKwh: round2(loadWh / 1000),
      gridHours: rows.filter((r) => r.grid_on === true).length,
      gridKwh: round2(gridWh / 1000),
      minSocPct: Math.min(...rows.map((r) => r.soc_pct)),
      hoursBelowReserve: rows.filter((r) => r.soc_pct <= reserve).length,
      solarSharePct: loadWh > 0 ? Math.round(Math.min(100, (Math.min(solarWh, loadWh) / loadWh) * 100)) : 0,
    };
  });
}

export interface PeriodSummary {
  days: DayReport[];
  solarKwh: number; loadKwh: number; gridKwh: number; gridHours: number;
  minSocPct: number; hoursBelowReserve: number; solarSharePct: number;
  gridCost: number | null; solarValue: number | null; currency: string | null;
}

export function summarize(days: DayReport[], tariff: Tariff | null | undefined): PeriodSummary {
  const sum = (k: keyof DayReport) => days.reduce((a, d) => a + (d[k] as number), 0);
  const solarKwh = round2(sum("solarKwh")), loadKwh = round2(sum("loadKwh")), gridKwh = round2(sum("gridKwh"));
  const selfUsedSolarKwh = Math.max(0, loadKwh - gridKwh); // what the sun (and the battery it filled) covered
  return {
    days, solarKwh, loadKwh, gridKwh, gridHours: sum("gridHours"),
    minSocPct: days.length ? Math.min(...days.map((d) => d.minSocPct)) : 100,
    hoursBelowReserve: sum("hoursBelowReserve"),
    solarSharePct: loadKwh > 0 ? Math.round((selfUsedSolarKwh / loadKwh) * 100) : 0,
    gridCost: tariff ? round2(gridKwh * tariff.perKwh) : null,
    solarValue: tariff ? round2(selfUsedSolarKwh * tariff.perKwh) : null,
    currency: tariff?.currency ?? null,
  };
}

/** Pick the samples for a named period, in local days relative to `nowIso`. */
export function periodSamples(samples: Sample[], period: "today" | "yesterday" | "week", nowIso: string, tz: number): Sample[] {
  if (Number.isNaN(Date.parse(nowIso))) return [];
  samples = samples.filter(usable);
  const today = localDay(nowIso, tz);
  const dayOf = (s: Sample) => localDay(s.at, tz);
  if (period === "today") return samples.filter((s) => dayOf(s) === today);
  const nowMs = Date.parse(nowIso) + tz * HOUR;
  if (period === "yesterday") {
    const y = new Date(nowMs - 24 * HOUR).toISOString().slice(0, 10);
    return samples.filter((s) => dayOf(s) === y);
  }
  const from = new Date(nowMs - 6 * 24 * HOUR).toISOString().slice(0, 10); // today plus the six before it = seven local days
  return samples.filter((s) => dayOf(s) >= from && dayOf(s) <= today);
}

/**
 * The household's own 24-hour load shape (W per local hour), or null until there are at
 * least `minDays` days with a reading in every hour slot. Median per slot, so one
 * unusual day (a party, a wash-day) does not reshape tomorrow's forecast.
 */
export function learnedLoadProfile(samples: Sample[], tz: number, minDays = 3): number[] | null {
  const slots: number[][] = Array.from({ length: 24 }, () => []);
  for (const s of samples.filter(alive)) slots[localHour(s.at, tz)].push(Math.max(0, s.load_w));
  if (slots.some((v) => v.length < minDays)) return null;
  return slots.map((v) => Math.round(median(v)));
}

/**
 * How the array really performs against the clear-sky model: the median, over sunny hours,
 * of observed / modelled. 1.0 = textbook; 0.6 = dust, shade or cloud; >1 = the model was
 * conservative. Null until there are `minHours` daylight observations.
 */
export function learnedPvFactor(samples: Sample[], tz: number, arrayKw: number, minHours = 24): number | null {
  const ratios: number[] = [];
  for (const s of samples.filter(alive)) {
    const model = clearSkyPvW(localHour(s.at, tz), arrayKw);
    if (model >= 300) ratios.push(Math.min(1.5, Math.max(0, s.pv_w) / model));
  }
  if (ratios.length < minHours) return null;
  // A week of harmattan haze can halve yield; nothing real takes it to zero. The floor keeps a
  // broken adapter reporting 0 W from teaching the forecast that the sun never rises.
  return Math.round(Math.min(1.5, Math.max(0.25, median(ratios))) * 100) / 100;
}

/**
 * "If the grid went off now": hours until the reserve floor with no grid at all, from the
 * same integration the forecast uses. Null when the battery is already at or below reserve.
 */
export function autonomyHours(input: ForecastInput, profile: SystemProfile, stepsPerHour = 4): number | null {
  if (!Number.isFinite(input.socPct) || !Number.isFinite(profile.batteryKwh) || profile.batteryKwh <= 0) return null;
  if (input.socPct <= profile.reserveSocPct) return null;
  const capWh = profile.batteryKwh * 1000;
  let soc = input.socPct;
  for (let h = 0; h < 48; h++) {
    const pv = input.pvForecastW[h % 24] ?? 0, load = input.loadForecastW[h % 24] ?? 0;
    for (let s = 0; s < stepsPerHour; s++) {
      soc = Math.min(100, Math.max(0, soc + (((pv - load) / stepsPerHour) / capWh) * 100));
      if (soc <= profile.reserveSocPct) return Math.round((h + (s + 1) / stepsPerHour) * 10) / 10;
    }
  }
  return 48; // more than two days: effectively indefinite
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round2 = (v: number) => Math.round(v * 100) / 100;
