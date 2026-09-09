import type { Telemetry, TelemetrySource } from "./types.js";

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
    const start = (this.opts.clockStart ?? new Date()).getTime();
    return start + (Date.now() - this.t0real) * (this.opts.speed ?? 1);
  }

  private gridOn(hour: number): boolean {
    const windows = this.opts.gridWindows ?? [[0, 6], [13, 16], [22, 24]];
    return windows.some(([a, b]) => hour >= a && hour < b);
  }

  async current(): Promise<Telemetry> {
    const now = this.simNow();
    const d = new Date(now);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + 1; // Lagos = UTC+1
    const cloud = 0.85 + 0.15 * this.rnd();
    const pv = Math.round(clearSkyPvW(hour % 24, this.opts.arrayKw) * cloud);
    const load = Math.round(typicalLoadW(hour % 24) * (0.9 + 0.2 * this.rnd()));
    const grid = this.gridOn(hour % 24);

    // Grid covers load when present; battery absorbs the rest.
    const gridW = grid ? Math.max(0, load - pv) : 0;
    const batteryW = pv + gridW - load;
    const dtH = (now - this.lastTick) / 3.6e6;
    this.lastTick = now;
    const dSoc = (batteryW * dtH) / (this.opts.batteryKwh * 1000) * 100;
    this.soc = Math.min(100, Math.max(0, this.soc + dSoc));

    return {
      at: d.toISOString(),
      pv_w: pv,
      load_w: load,
      battery_w: Math.round(batteryW),
      soc_pct: Math.round(this.soc * 10) / 10,
      grid_w: grid ? gridW : 0,
      grid_available: grid,
      source: this.name,
    };
  }

  async pvForecast(): Promise<number[]> {
    const now = new Date(this.simNow());
    const startHour = now.getUTCHours() + 1;
    return Array.from({ length: 24 }, (_, i) => clearSkyPvW((startHour + i) % 24, this.opts.arrayKw));
  }
}
