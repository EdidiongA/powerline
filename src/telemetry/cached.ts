/**
 * Shared, de-duplicated telemetry.
 *
 * Every MCP session runs its own alert monitor, and every tool call reads telemetry.
 * Without this, N open sessions make N upstream calls per poll. That matters because
 * the Victron VRM API allows roughly 200 requests in a rolling window: two sessions
 * polling every 30 s would exhaust it and start failing mid-demo, and Growatt refreshes
 * only every ~5 minutes anyway, so the extra calls buy nothing.
 *
 * This wrapper collapses concurrent reads onto one in-flight request and serves a
 * short-lived cached reading, so upstream load is independent of session count.
 */
import type { Telemetry, TelemetrySource } from "./types.js";

export class CachedSource implements TelemetrySource {
  readonly name: string;
  private fresh: { at: number; value: Telemetry } | null = null;
  private inFlight: Promise<Telemetry> | null = null;
  private forecastCache: { at: number; value: number[] | null } | null = null;

  constructor(private inner: TelemetrySource, private ttlMs = Number(process.env.TELEMETRY_TTL_MS ?? 10_000)) {
    this.name = inner.name;
  }

  async current(): Promise<Telemetry> {
    if (this.fresh && Date.now() - this.fresh.at < this.ttlMs) return this.fresh.value;
    if (this.inFlight) return this.inFlight;                  // collapse concurrent callers
    this.inFlight = this.inner
      .current()
      .then((value) => { this.fresh = { at: Date.now(), value }; return value; })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async pvForecast(): Promise<number[] | null> {
    if (!this.inner.pvForecast) return null;
    // Forecasts change slowly; cache them far longer than live readings.
    const ttl = Math.max(this.ttlMs, 5 * 60_000);
    if (this.forecastCache && Date.now() - this.forecastCache.at < ttl) return this.forecastCache.value;
    const value = await this.inner.pvForecast();
    this.forecastCache = { at: Date.now(), value };
    return value;
  }
}
