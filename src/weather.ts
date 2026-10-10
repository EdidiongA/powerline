/**
 * Weather-aware solar forecast via Open-Meteo (free, no key): hourly shortwave radiation for
 * the household's coordinates becomes the next 24 hours of PV, replacing the clear-sky curve.
 *
 *   WEATHER_LAT=6.52 WEATHER_LON=3.38      (Lagos)   — unset = clear-sky model
 *
 * PV ≈ array_kW × (GHI / 1000 W/m²) × performance ratio. Cached for 30 minutes, 5-second
 * deadline, and any failure falls back to the clear-sky model: the weather is a refinement,
 * never a dependency.
 */
export interface WeatherForecast { pvW: number[]; cloudPct: number[]; fetchedAt: string; provider: "open-meteo" }

const PERFORMANCE_RATIO = 0.8;
const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 5_000;
const RETRY_AFTER_FAILURE_MS = 3 * 60_000; // an outage costs one timeout every few minutes, not one per tool call
const coord = (raw: string | undefined) => (raw?.trim() ? Number(raw) : NaN); // a blank .env line is "unset", not Null Island

export class OpenMeteo {
  private cache: { at: number; value: WeatherForecast } | null = null;
  private inFlight: Promise<WeatherForecast | null> | null = null;
  private nextTryAt = 0;
  readonly enabled: boolean;

  constructor(private lat = coord(process.env.WEATHER_LAT), private lon = coord(process.env.WEATHER_LON), private fetchImpl: typeof fetch = fetch, private base = process.env.WEATHER_BASE_URL ?? "https://api.open-meteo.com/v1/forecast") {
    this.enabled = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  /** 24 hourly PV values starting at `fromIso` (telemetry time), or null when unavailable. */
  async pvForecast(arrayKw: number, fromIso: string): Promise<number[] | null> {
    const f = await this.forecast();
    if (!f) return null;
    const start = Math.floor(Date.parse(fromIso) / 3_600_000);
    const base = Math.floor(Date.parse(f.fetchedAt) / 3_600_000);
    const offset = start - base;
    if (!Number.isFinite(offset) || offset < 0 || offset + 24 > f.pvW.length) return null; // the forecast window no longer covers "now"
    return f.pvW.slice(offset, offset + 24).map((ghi) => Math.round(arrayKw * 1000 * (ghi / 1000) * PERFORMANCE_RATIO));
  }

  async forecast(): Promise<WeatherForecast | null> {
    if (!this.enabled) return null;
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value;
    if (Date.now() < this.nextTryAt) return this.cache?.value ?? null; // recent failure: do not pay the timeout again yet
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async load(): Promise<WeatherForecast | null> {
    try {
      const url = `${this.base}?latitude=${this.lat}&longitude=${this.lon}&hourly=shortwave_radiation,cloud_cover&forecast_days=3&timezone=UTC`;
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json() as { hourly?: { time?: string[]; shortwave_radiation?: Array<number | null>; cloud_cover?: Array<number | null> } };
      const time = j.hourly?.time ?? [], ghi = j.hourly?.shortwave_radiation ?? [], cc = j.hourly?.cloud_cover ?? [];
      if (time.length < 24 || ghi.length !== time.length) throw new Error("unexpected payload");
      // Series start at 00:00 UTC today. Open-Meteo stamps radiation as the average of the
      // PRECEDING hour (the 13:00 value covers 12:00–13:00), so the hour that starts now is at
      // index (now − first) + 1. Trim so index 0 is the hour that starts now.
      const nowHour = Math.floor(Date.now() / 3_600_000);
      const firstHour = Math.floor(Date.parse(`${time[0]}Z`) / 3_600_000);
      const skip = nowHour - firstHour + 1;
      if (!Number.isFinite(skip) || skip < 0 || skip > time.length - 24) throw new Error("forecast window does not cover now");
      const clean = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
      const value: WeatherForecast = { pvW: ghi.slice(skip).map(clean), cloudPct: cc.slice(skip).map(clean), fetchedAt: new Date(nowHour * 3_600_000).toISOString(), provider: "open-meteo" };
      this.cache = { at: Date.now(), value };
      this.nextTryAt = 0;
      return value;
    } catch (e) {
      this.nextTryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      console.error(`[weather] unavailable (${(e as Error).message}); using the clear-sky model`);
      return this.cache?.value ?? null; // a stale forecast beats none
    }
  }
}

export const weather = new OpenMeteo();
