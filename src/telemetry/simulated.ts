import type { Telemetry, TelemetrySource } from "./types.js";
import { TZ_OFFSET } from "../config.js";

/**
 * Deterministic-ish simulator for demos and tests.
 * - Clear-sky PV curve for ~6.5°N (Lagos): sunrise ~06:30, sunset ~18:45
 * - Household load profile with morning/evening peaks
 * - Scripted grid outage windows (typical "band" supply pattern)
 * Battery SOC integrates over simulated time so the dashboard visibly moves.
 */
export interface SimOptions {
  arrayKw: number;
  batteryKwh: number;
  startSoc?: number;
  gridWindows?: Array<[number, number]>; // hours of day when grid is ON
  seed?: number;
  clockStart?: Date;
  speed?: number; // simulated seconds per real second
  cutoffSocPct?: number; // the inverter's low-battery disconnect; below it the loads drop, the battery does not go to zero
  steady?: boolean; // no reading-to-reading wobble in load and cloud: the same hour always reads the same (for filming and docs)
}

export function clearSkyPvW(hourOfDay: number, arrayKw: number): number {
  const sunrise = 6.5, sunset = 18.75;
  if (hourOfDay <= sunrise || hourOfDay >= sunset) return 0;
  const x = (hourOfDay - sunrise) / (sunset - sunrise); // 0..1
  return Math.round(arrayKw * 1000 * 0.78 * Math.sin(Math.PI * x)); // 0.78 = derate
}

export function typicalLoadW(hourOfDay: number): number {
  const base = 250; // fridge, router, standby
  const morning = 500 * Math.exp(-((hourOfDay - 7) ** 2) / 1.2);
  const evening = 900 * Math.exp(-((hourOfDay - 20) ** 2) / 3);
  return Math.round(base + morning + evening);
}

export class SimulatedSource implements TelemetrySource {
  readonly name = "simulated";
  private soc: number;
  private lastTick: number;
  private t0real: number;
  private rnd: () => number;

  constructor(private opts: SimOptions) {
    this.soc = opts.startSoc ?? 65;
    this.t0real = Date.now();
    this.lastTick = this.simNow();
    let s = opts.seed ?? 42;
    this.rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  }

  private simNow(): number {
    const clock = this.opts.clockStart;
    const start = clock && Number.isFinite(clock.getTime()) ? clock.getTime() : this.t0real;
    const speed = Number.isFinite(this.opts.speed) && (this.opts.speed as number) > 0 ? (this.opts.speed as number) : 1;
    return start + (Date.now() - this.t0real) * speed;
  }

  private gridOn(hour: number): boolean {
    const windows = this.opts.gridWindows ?? [[0, 6], [13, 16], [22, 24]];
    return windows.some(([a, b]) => hour >= a && hour < b);
  }

  async current(): Promise<Telemetry> {
    const now = this.simNow();
    const d = new Date(now);
    const hour = ((d.getUTCHours() + d.getUTCMinutes() / 60 + TZ_OFFSET) % 24 + 24) % 24; // local hour, follows TZ_OFFSET
    const cloud = this.opts.steady ? 0.925 : 0.85 + 0.15 * this.rnd();
    const pv = Math.round(clearSkyPvW(hour % 24, this.opts.arrayKw) * cloud);
    const load = Math.round(typicalLoadW(hour % 24) * (this.opts.steady ? 1 : 0.9 + 0.2 * this.rnd()));
    const grid = this.gridOn(hour % 24);

    // Grid covers load when present; battery absorbs the rest.
    const gridW = grid ? Math.max(0, load - pv) : 0;
    let batteryW = pv + gridW - load;
    const dtH = (now - this.lastTick) / 3.6e6;
    this.lastTick = now;
    const cutoff = Math.min(50, Math.max(0, this.opts.cutoffSocPct ?? 10));
    // Below the cut-off a real inverter disconnects the loads rather than flattening the battery:
    // the house goes dark except for what the grid or the sun can carry directly.
    let served = load;
    if (batteryW < 0 && this.soc <= cutoff) { served = Math.min(load, pv + gridW); batteryW = 0; }
    const dSoc = (batteryW * dtH) / (this.opts.batteryKwh * 1000) * 100;
    this.soc = Math.min(100, Math.max(batteryW < 0 ? cutoff : 0, this.soc + dSoc));

    return {
      at: d.toISOString(),
      pv_w: pv,
      load_w: served,
      battery_w: Math.round(batteryW),
      soc_pct: Math.round(this.soc * 10) / 10,
      grid_w: grid ? gridW : 0,
      grid_available: grid,
      source: this.name,
    };
  }

  async pvForecast(): Promise<number[]> {
    const now = new Date(this.simNow());
    const startHour = ((now.getUTCHours() + TZ_OFFSET) % 24 + 24) % 24;
    return Array.from({ length: 24 }, (_, i) => clearSkyPvW((startHour + i) % 24, this.opts.arrayKw));
  }
}
