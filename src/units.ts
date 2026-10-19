/**
 * Prepaid units — pure arithmetic, no I/O, unit-tested.
 *
 * A prepaid meter is a second battery: the grid is only "on" for this house while there are units
 * on the meter. Powerline already forecasts when the grid will carry the load, so it can say how
 * long the units will last, what happens to the battery when they run out, and what top-up covers
 * the next day. The balance is the household's last known figure (they read it off the meter, or a
 * purchase set it); usage since then is estimated from Powerline's own hourly history.
 */
import { forecast, type ForecastInput, type ForecastResult } from "./forecast.js";
import { normalizeCurrency, type Meter, type Sample, type Tariff } from "./store/types.js";

/** Naira per kWh when the household has not set a tariff. Band A is around this; the reply says it was assumed. */
export const DEFAULT_RATE_NGN = 225;
/** Smallest top-up suggested; the distribution companies' minimum is ₦500, and less than this is rarely worth a transaction. */
export const MIN_SUGGESTION = 1000;

export interface UnitsOutlook {
  /** A balance is known (the household gave one, or a purchase set it). */
  known: boolean;
  /** Estimated balance now, kWh. Null when unknown. */
  balanceKwh: number | null;
  /** Grid energy used since the last known balance, from history, kWh. */
  usedSinceKwh: number;
  /** Grid energy the forecast expects the house to draw in the next 24 h, kWh. */
  needNext24hKwh: number;
  /** Hours from now when the balance runs out while the grid is carrying the house; null if it lasts the 24 h (or is unknown). */
  runsOutHour: number | null;
  /** What the next 24 h needs beyond the balance (all of it when the balance is unknown), kWh. */
  shortfallKwh: number;
  /** A top-up in naira that covers the next 24 h with a 20 % margin, rounded up to ₦500; null when none is needed. */
  suggestedAmount: number | null;
  ratePerKwh: number;
  rateAssumed: boolean;
  /** The tariff's currency when it is set but not naira (so the naira rate had to be assumed). */
  tariffCurrency: string | null;
  /** The balance is a floor: units were bought while the previous balance was unknown. */
  lowerBound: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** The grid's share of each forecast hour (it covers deficits only), kWh. */
export const gridKwhByHour = (f: ForecastResult): number[] => f.points.map((p) => (p.gridOn ? Math.max(0, p.loadW - p.pvW) / 1000 : 0));

/** Grid energy recorded in history after `sinceIso` up to `nowIso`, kWh (each hourly sample stands for its hour). */
export function gridUseSince(samples: Sample[], sinceIso: string, nowIso: string): number {
  const since = Date.parse(sinceIso), now = Date.parse(nowIso);
  if (!Number.isFinite(since) || !Number.isFinite(now)) return 0;
  // The sample for the hour the balance was read in mostly predates it: start from the first full hour after the reading
  // (the same hour when it was read exactly on the hour). Stop before the current hour, which the forecast's hour 0 counts.
  const firstSlot = Math.ceil(since / 3_600_000) * 3_600_000;
  const currentSlot = Math.floor(now / 3_600_000) * 3_600_000;
  let wh = 0;
  for (const s of samples) {
    const at = Date.parse(s.at);
    if (at >= firstSlot && at < currentSlot && s.grid_on === true) wh += Math.max(0, s.load_w - s.pv_w); // unknown grid (null) is not counted
  }
  return wh / 1000;
}

export function rateFrom(tariff: Tariff | null | undefined): { rate: number; assumed: boolean } {
  return tariff && normalizeCurrency(tariff.currency) === "NGN" && tariff.perKwh > 0 ? { rate: tariff.perKwh, assumed: false } : { rate: DEFAULT_RATE_NGN, assumed: true };
}

/** Round a naira amount up to the next ₦500, never under MIN_SUGGESTION. */
export const roundTopUp = (naira: number): number => Math.max(MIN_SUGGESTION, Math.ceil(naira / 500) * 500);

export function unitsOutlook(args: { meter: Meter | null | undefined; samples: Sample[]; base: ForecastResult; nowIso: string; tariff: Tariff | null | undefined }): UnitsOutlook {
  const { meter, samples, base, nowIso } = args;
  const { rate, assumed } = rateFrom(args.tariff);
  const hourly = gridKwhByHour(base);
  const need = hourly.reduce((a, b) => a + b, 0);
  const known = !!meter && typeof meter.unitsKwh === "number" && typeof meter.unitsAt === "string";
  const used = known ? gridUseSince(samples, meter!.unitsAt!, nowIso) : 0;
  const balance = known ? Math.max(0, meter!.unitsKwh! - used) : null;

  let runsOutHour: number | null = null;
  if (balance !== null) {
    let left = balance;
    for (let i = 0; i < hourly.length; i++) {
      if (hourly[i] <= 0) continue;
      if (left <= 0 || hourly[i] > left) { runsOutHour = i; break; }
      left -= hourly[i];
    }
  }
  const shortfall = balance === null ? need : Math.max(0, need - balance);
  // Suggest only when the next day actually needs more: the margin covers a forecast that is a little short.
  const suggested = shortfall > 0.05 ? roundTopUp((need * 1.2 - (balance ?? 0)) * rate * 1.075) : null;
  return { known, balanceKwh: balance === null ? null : r1(balance), usedSinceKwh: r1(used), needNext24hKwh: r1(need), runsOutHour, shortfallKwh: r1(shortfall), suggestedAmount: suggested, ratePerKwh: rate, rateAssumed: assumed,
    tariffCurrency: args.tariff && normalizeCurrency(args.tariff.currency) !== "NGN" ? normalizeCurrency(args.tariff.currency) : null, lowerBound: known && meter!.lowerBound === true };
}

/**
 * The battery forecast if the units run out at `hour`: from then on the grid may be up, but this
 * house cannot draw from it. This is what makes an empty meter a power problem, not a billing one.
 */
export function forecastWithoutUnits(input: ForecastInput, hour: number): ForecastResult {
  const grid = input.gridForecast.map((g, i) => (i >= hour ? false : g));
  return forecast({ ...input, gridForecast: grid });
}
