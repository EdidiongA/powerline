/** Normalised snapshot every adapter must produce. Positive battery_w = charging. */
export interface Telemetry {
  at: string;             // ISO timestamp of the reading
  pv_w: number;           // solar production
  load_w: number;         // household consumption
  battery_w: number;      // + charging / - discharging
  soc_pct: number;        // 0..100
  grid_w: number | null;  // + importing / - exporting; null if unknown
  grid_available: boolean | null;
  source: string;         // adapter name shown to the user
  raw?: unknown;          // provider payload, for debugging/friction logs
}

export interface TelemetrySource {
  readonly name: string;
  /** Latest reading. Must not throw for transient provider errors: return last known + note. */
  current(): Promise<Telemetry>;
  /** Optional provider-supplied PV forecast in W, one value per hour for the next 24h. */
  pvForecast?(): Promise<number[] | null>;
}
