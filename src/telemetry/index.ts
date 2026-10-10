import { CachedSource } from "./cached.js";
import { SimulatedSource } from "./simulated.js";
import { VictronSource } from "./victron.js";
import { GrowattSource } from "./growatt.js";
import type { TelemetrySource } from "./types.js";

/** Numeric env with a fallback for unset, empty or non-numeric values. */
const num = (v: string | undefined, fallback: number): number => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

export type { Telemetry, TelemetrySource } from "./types.js";
export { SimulatedSource, VictronSource, GrowattSource, CachedSource };

/**
 * Pick the telemetry source from env:
 *   POWER_SOURCE=sim      (default)  — SIM_ARRAY_KW, SIM_BATTERY_KWH, SIM_SPEED, SIM_START_SOC, SIM_CLOCK_START
 *   POWER_SOURCE=victron             — VRM_TOKEN or VRM_DEMO=1, VRM_SITE_ID
 *   POWER_SOURCE=growatt             — GROWATT_TOKEN [, GROWATT_PLANT_ID, GROWATT_DEVICE_SN, GROWATT_DEVICE_TYPE]
 */
export function sourceFromEnv(env = process.env): TelemetrySource {
  // Wrapped so upstream load stays flat as sessions come and go (see CachedSource).
  // The simulator is exempt: it is free to call and its clock should advance smoothly.
  const inner = buildSource(env);
  return inner.name === "simulated" ? inner : new CachedSource(inner);
}

function buildSource(env: NodeJS.ProcessEnv): TelemetrySource {
  switch ((env.POWER_SOURCE ?? "sim").toLowerCase()) {
    case "victron":
      return new VictronSource({
        token: env.VRM_TOKEN,
        demo: env.VRM_DEMO === "1",
        siteId: num(env.VRM_SITE_ID, 219742), // 219742 = VRM demo "ESS System"
      });
    case "growatt":
      if (!env.GROWATT_TOKEN) throw new Error("GROWATT_TOKEN required");
      return new GrowattSource({
        token: env.GROWATT_TOKEN,
        baseUrl: env.GROWATT_BASE_URL,
        plantId: env.GROWATT_PLANT_ID,
        deviceSn: env.GROWATT_DEVICE_SN,
        deviceType: env.GROWATT_DEVICE_TYPE ? (Number(env.GROWATT_DEVICE_TYPE) as 5 | 7) : undefined,
      });
    default:
      return new SimulatedSource({
        arrayKw: Math.max(0.1, num(env.SIM_ARRAY_KW, 4.5)),
        batteryKwh: Math.max(0.1, num(env.SIM_BATTERY_KWH, 10)),
        speed: num(env.SIM_SPEED, 60), // 1 real second = 1 simulated minute
        startSoc: env.SIM_START_SOC ? Math.min(100, Math.max(0, num(env.SIM_START_SOC, 65))) : undefined,
        clockStart: env.SIM_CLOCK_START ? new Date(env.SIM_CLOCK_START) : undefined, // e.g. 2026-09-09T21:00:00Z; invalid → now
      });
  }
}
