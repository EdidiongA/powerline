import type { Telemetry, TelemetrySource } from "./types.js";

/**
 * Victron VRM Portal adapter (VRM API v2).
 *
 * Auth: a personal access token from VRM Portal → Preferences → Integrations → Access tokens,
 * sent as `X-Authorization: Token <pat>`. With VRM_DEMO=1 the adapter logs in as the public
 * demo user instead (Bearer JWT) — handy for the demo video if you don't own Victron kit.
 *
 * Data: one `stats?type=custom` call with attribute codes
 *   Pdc = PV power (W), ac_loads = consumption (W), bp = battery power (W), bs = SOC (%),
 *   gp = grid power (W, absent on off-grid sites).
 */
export interface VictronOptions {
  token?: string;      // personal access token
  demo?: boolean;      // use /auth/loginAsDemo
  siteId: number;
  baseUrl?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

type StatsRecord = Record<string, Array<[number, number, ...number[]]> | false>;

export class VictronSource implements TelemetrySource {
  readonly name = "victron-vrm";
  private base: string;
  private authHeader: string | null = null;
  private last: Telemetry | null = null;

  constructor(private opts: VictronOptions) {
    this.base = (opts.baseUrl ?? "https://vrmapi.victronenergy.com/v2").replace(/\/$/, "");
  }

  private async auth(): Promise<string> {
    if (this.authHeader) return this.authHeader;
    if (this.opts.demo) {
      const r = await fetch(`${this.base}/auth/loginAsDemo`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const j = (await r.json()) as { token: string };
      this.authHeader = `Bearer ${j.token}`;
    } else if (this.opts.token) {
      this.authHeader = `Token ${this.opts.token}`;
    } else {
      throw new Error("VictronSource needs VRM_TOKEN or VRM_DEMO=1");
    }
    return this.authHeader;
  }

  private async get<T>(path: string): Promise<T> {
    // A hung upstream must not hang a tool call (and with it the card's busy state) forever.
    const r = await fetch(`${this.base}${path}`, { headers: { "X-Authorization": await this.auth() }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (r.status === 401) this.authHeader = null; // token expired (demo JWT) → re-login next call
    const j = (await r.json()) as { success: boolean; errors?: unknown; records?: T };
    if (!j.success) throw new Error(`VRM error: ${JSON.stringify(j.errors)}`);
    return j.records as T;
  }

  async current(): Promise<Telemetry> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 3600;
    const codes = ["Pdc", "ac_loads", "bp", "bs", "gp"].map((c) => `attributeCodes[]=${c}`).join("&");
    try {
      const rec = await this.get<StatsRecord>(
        `/installations/${this.opts.siteId}/stats?type=custom&interval=15mins&start=${start}&end=${end}&${codes}`,
      );
      const lastOf = (k: string): number | null => {
        const s = rec[k];
        if (!s || s.length === 0) return null;
        const v = s[s.length - 1][1];
        return typeof v === "number" ? v : null;
      };
      const gp = lastOf("gp");
      // Stamp the reading with the sample's own time (VRM buckets are up to 15 min old), not ours.
      const sampleTs = rec.bs && rec.bs.length ? rec.bs[rec.bs.length - 1][0] : null;
      // VRM v2 stats stamp samples in epoch MILLISECONDS (older docs show seconds); accept either and never a date in year 58759.
      const sampleMs = typeof sampleTs === "number" && Number.isFinite(sampleTs) ? (sampleTs > 1e11 ? sampleTs : sampleTs * 1000) : NaN;
      const at = Number.isFinite(sampleMs) && Math.abs(Date.now() - sampleMs) < 7 * 86_400_000 ? new Date(sampleMs).toISOString() : new Date().toISOString();
      const soc = lastOf("bs");
      if (soc === null) throw new Error("no state of charge in the VRM payload"); // a reading without SOC is not a reading: serve the last good one as stale
      this.last = {
        at,
        pv_w: Math.round(lastOf("Pdc") ?? 0),
        load_w: Math.round(lastOf("ac_loads") ?? 0),
        battery_w: Math.round(lastOf("bp") ?? 0),
        soc_pct: Math.round(soc * 10) / 10,
        grid_w: gp === null ? null : Math.round(gp),
        // Power flowing proves the grid is there; zero flow does not prove it is gone (a grid-tied system with the
        // sun covering the whole load and no feed-in sits at 0 W all afternoon). Report "unknown" rather than a
        // spurious outage, which would otherwise be logged, announced and learned as a daily pattern.
        grid_available: gp === null ? null : Math.abs(gp) > 5 ? true : null,
        source: this.name,
        raw: rec,
      };
      return this.last;
    } catch (err) {
      if (this.last) return { ...this.last, source: `${this.name} (stale: ${(err as Error).message})` };
      throw err;
    }
  }
}
