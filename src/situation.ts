/**
 * The household's situation right now: live telemetry joined with the stored
 * profile, appliances and learned grid pattern, shaped into a ForecastInput.
 *
 * Every decision tool starts here. Keeping it in one place means "what does
 * Powerline believe about the next 24 hours" has exactly one definition.
 */
import { getHousehold, type Household } from "./store/index.js";
import { gridProbabilityByHour, type ForecastInput, type SystemProfile } from "./forecast.js";
import { clearSkyPvW, typicalLoadW } from "./telemetry/simulated.js";
import type { Telemetry, TelemetrySource } from "./telemetry/index.js";
import { DEFAULT_PROFILE, TZ_OFFSET, localHourOf } from "./config.js";
import { learnedLoadProfile, learnedPvFactor } from "./history.js";
import { weather as defaultWeather, type OpenMeteo } from "./weather.js";

/** `delivered` is the per-session set of reminders already announced ("name@startAt"), shared between the tools and this session's alert monitor so neither repeats the other. */
export interface SessionContext { userId: string; source: TelemetrySource; weather?: OpenMeteo; delivered?: Set<string> }

export interface Situation {
  t: Telemetry;
  h: Household;
  profile: SystemProfile;
  input: ForecastInput;
  localHour: number;
  /** The household's UTC offset in hours (its profile, else the server default). */
  tz: number;
  /** True until the household runs setup_system; tools say so, once, rather than pretend. */
  profileIsDefault: boolean;
  /** What the forecast learned from the household's own history (null = generic curve in use). */
  learned: { loadProfile: boolean; pvFactor: number | null; days: number };
  /** Where the solar forecast came from. */
  pvSource: "provider" | "weather" | "clear-sky";
}

export async function assess(ctx: SessionContext): Promise<Situation> {
  const [raw, h] = await Promise.all([ctx.source.current(), getHousehold(ctx.userId)]);
  // A provider that returns a missing field as NaN would otherwise poison every forecast
  // point (clamp(NaN) is NaN). Coerce here, once, for every consumer.
  const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  const t: Telemetry = { ...raw, pv_w: finite(raw.pv_w, 0), load_w: finite(raw.load_w, 0), battery_w: finite(raw.battery_w, 0), soc_pct: Math.min(100, Math.max(0, finite(raw.soc_pct, 0))) };
  const profile = h.profile ?? DEFAULT_PROFILE;
  const tz = typeof profile.tzOffset === "number" ? profile.tzOffset : TZ_OFFSET;
  // Telemetry time follows the simulator clock when SIM_CLOCK_START is set. An unparseable
  // timestamp falls back to the wall clock rather than a NaN weekday/hour.
  const now = Number.isNaN(Date.parse(t.at)) ? new Date() : new Date(t.at);
  const localHour = localHourOf(t.at, tz);

  // A provider forecast is used only when it is a full, finite 24-hour series; anything less
  // silently degrades to the clear-sky model rather than to a short or NaN-ridden forecast.
  let providerPv: number[] | null = null;
  try {
    const p = (await ctx.source.pvForecast?.()) ?? null;
    if (Array.isArray(p) && p.length >= 24 && p.slice(0, 24).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) providerPv = p.slice(0, 24);
  } catch (e) { console.error(`[situation] provider forecast failed: ${(e as Error).message}`); }
  // Learning: once the household has enough of its own history, its own curves replace the
  // generic ones. The clear-sky model is scaled by the array's observed yield; the load shape
  // is the household's median hour-by-hour. Both degrade gracefully to the generic model.
  const samples = h.samples ?? [];
  const pvFactor = learnedPvFactor(samples, tz, profile.arrayKw);
  const ownLoad = learnedLoadProfile(samples, tz);
  const days = new Set(samples.map((x) => new Date(Date.parse(x.at) + tz * 3_600_000).toISOString().slice(0, 10))).size;
  // Solar: the inverter vendor's own forecast when it has one; else the weather service for the
  // household's coordinates; else the clear-sky model scaled by what the array has actually yielded.
  let weatherPv: number[] | null = null;
  const wx = ctx.weather ?? defaultWeather;
  if (!providerPv && wx.enabled) {
    try { weatherPv = await wx.pvForecast(profile.arrayKw, t.at); } catch (e) { console.error(`[situation] weather failed: ${(e as Error).message}`); }
    if (weatherPv && !(weatherPv.length === 24 && weatherPv.every((v) => Number.isFinite(v) && v >= 0))) weatherPv = null;
  }
  const pvSource: Situation["pvSource"] = providerPv ? "provider" : weatherPv ? "weather" : "clear-sky";
  const pvForecastW = providerPv ?? weatherPv ?? Array.from({ length: 24 }, (_, i) => Math.round(clearSkyPvW((localHour + i) % 24, profile.arrayKw) * (pvFactor ?? 1)));

  // Load: the household's own shape when learned, else the typical profile; either way scaled
  // so hour 0 matches what is measured right now.
  const shape = (hr: number) => (ownLoad ? ownLoad[hr % 24] : typicalLoadW(hr % 24));
  const scale = t.load_w > 0 && shape(localHour) > 0 ? t.load_w / shape(localHour) : 1;
  const loadForecastW = Array.from({ length: 24 }, (_, i) => Math.round(shape((localHour + i) % 24) * Math.min(2, Math.max(0.5, scale))));

  // Grid: hour 0 is what we can see; later hours come from the learned pattern where
  // there is enough evidence; otherwise the current state persists ~2 h, then unknown (off).
  const probs = gridProbabilityByHour(h.gridEvents, now.getUTCDay());
  const probsTomorrow = gridProbabilityByHour(h.gridEvents, (now.getUTCDay() + 1) % 7);
  const gridForecast = Array.from({ length: 24 }, (_, i) => {
    if (i === 0 && t.grid_available !== null) return t.grid_available;
    const p = (now.getUTCHours() + i >= 24 ? probsTomorrow : probs)[(now.getUTCHours() + i) % 24]; // hours past midnight belong to tomorrow's weekday
    if (p !== null) return p >= 0.5;
    return i < 2 ? t.grid_available : null;
  });

  return { t, h, profile, input: { profile, socPct: t.soc_pct, pvForecastW, loadForecastW, gridForecast }, localHour, tz, profileIsDefault: h.profile === null,
    learned: { loadProfile: ownLoad !== null, pvFactor, days }, pvSource };
}
