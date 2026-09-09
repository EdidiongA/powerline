import { SimulatedSource } from "./simulated.js";
import { VictronSource } from "./victron.js";
import { GrowattSource } from "./growatt.js";
import type { TelemetrySource } from "./types.js";

export type { Telemetry, TelemetrySource } from "./types.js";
export { SimulatedSource, VictronSource, GrowattSource };

/**
 * Pick the telemetry source from env:
 *   POWER_SOURCE=sim      (default)  — SIM_ARRAY_KW, SIM_BATTERY_KWH, SIM_SPEED, SIM_START_SOC, SIM_CLOCK_START
 *   POWER_SOURCE=victron             — VRM_TOKEN or VRM_DEMO=1, VRM_SITE_ID
 *   POWER_SOURCE=growatt             — GROWATT_TOKEN [, GROWATT_PLANT_ID, GROWATT_DEVICE_SN, GROWATT_DEVICE_TYPE]
 */
export function sourceFromEnv(env = process.env): TelemetrySource {
  switch ((env.POWER_SOURCE ?? "sim").toLowerCase()) {
    case "victron":
      return new VictronSource({
        token: env.VRM_TOKEN,
        demo: env.VRM_DEMO === "1",
        siteId: Number(env.VRM_SITE_ID ?? 219742), // 219742 = VRM demo "ESS System"
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
        arrayKw: Number(env.SIM_ARRAY_KW ?? 4.5),
        batteryKwh: Number(env.SIM_BATTERY_KWH ?? 10),
        speed: Number(env.SIM_SPEED ?? 60), // 1 real second = 1 simulated minute
        startSoc: env.SIM_START_SOC ? Number(env.SIM_START_SOC) : undefined,
        clockStart: env.SIM_CLOCK_START ? new Date(env.SIM_CLOCK_START) : undefined, // e.g. 2026-09-09T21:00:00Z
      });
  }
}
