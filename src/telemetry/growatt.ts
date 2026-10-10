import type { Telemetry, TelemetrySource } from "./types.js";

/**
 * Growatt OpenAPI V1 adapter (ShinePhone token).
 *
 * Token: ShinePhone → Me → (your username) → API Token. Tokens generated in the
 * app are reported to work more reliably than ones from the web portal.
 * Base URL: https://openapi.growatt.com/v1/ (regional: openapi-us / openapi-cn).
 * Auth header: `token: <token>`.
 *
 * Flow: plant/list → device/list?plant_id → per device type:
 *   type 5 (SPH hybrid): POST device/mix/mix_last_data  {mix_sn}
 *   type 7 (MIN/TLX):    POST device/tlx/tlx_last_data  {tlx_sn}
 *
 * Field names in the last_data payload vary by model/firmware; the mapping below
 * tries the common ones and keeps `raw` so unknown layouts can be inspected.
 * Tested against recorded payloads for both device families (test/fixtures/growatt/*.json),
 * taken from the shapes documented by Growatt's OpenAPI v1 and the PyPi_GrowattServer
 * community library. Not yet verified against a live unit — see FRICTION_LOG.md.
 */
export interface GrowattOptions {
  token: string;
  baseUrl?: string;
  plantId?: string;
  deviceSn?: string;
  deviceType?: 5 | 7;
  /** Test seam: replaces global fetch so recorded payloads can be replayed. */
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

export class GrowattSource implements TelemetrySource {
  readonly name = "growatt";
  private base: string;
  private last: Telemetry | null = null;
  private resolved: { sn: string; type: 5 | 7 } | null = null;

  constructor(private opts: GrowattOptions) {
    this.base = (opts.baseUrl ?? "https://openapi.growatt.com/v1").replace(/\/$/, "");
  }

  private async call(path: string, init: { method?: string; body?: URLSearchParams; query?: Record<string, string> } = {}): Promise<Json> {
    const url = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const r = await (this.opts.fetch ?? fetch)(url, {
      method: init.method ?? "GET",
      headers: { token: this.opts.token, ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: init.body,
      signal: AbortSignal.timeout(10_000), // a hung upstream must not hang a tool call
    });
    const j = (await r.json()) as { error_code: number; error_msg?: string; data?: Json };
    if (j.error_code !== 0) throw new Error(`Growatt error ${j.error_code}: ${j.error_msg}`);
    return j.data ?? {};
  }

  private async resolveDevice(): Promise<{ sn: string; type: 5 | 7 }> {
    if (this.resolved) return this.resolved;
    if (this.opts.deviceSn && this.opts.deviceType) {
      return (this.resolved = { sn: this.opts.deviceSn, type: this.opts.deviceType });
    }
    let plantId = this.opts.plantId;
    if (!plantId) {
      const plants = (await this.call("plant/list")) as { plants?: Array<{ plant_id: number | string }> };
      plantId = String(plants.plants?.[0]?.plant_id ?? "");
      if (!plantId) throw new Error("No Growatt plant on this account");
    }
    const devices = (await this.call("device/list", { query: { plant_id: plantId, page: "", perpage: "" } })) as {
      devices?: Array<{ device_sn: string; type: number }>;
    };
    const dev = devices.devices?.find((d) => d.type === 5 || d.type === 7);
    if (!dev) throw new Error("No SPH/MIN inverter found in plant; set GROWATT_DEVICE_SN + GROWATT_DEVICE_TYPE");
    return (this.resolved = { sn: dev.device_sn, type: dev.type as 5 | 7 });
  }

  async current(): Promise<Telemetry> {
    try {
      const dev = await this.resolveDevice();
      const path = dev.type === 5 ? "device/mix/mix_last_data" : "device/tlx/tlx_last_data";
      const body = new URLSearchParams(dev.type === 5 ? { mix_sn: dev.sn } : { tlx_sn: dev.sn });
      const d = await this.call(path, { method: "POST", body });
      const num = (...keys: string[]): number | null => {
        for (const k of keys) {
          const v = d[k];
          if (typeof v === "number") return v;
          if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v);
        }
        return null;
      };
      const pv = num("ppv", "pPv", "ppvTotal") ?? ((num("ppv1") ?? 0) + (num("ppv2") ?? 0));
      const load = num("pLocalLoad", "plocalLoad", "pLoad", "pac") ?? 0;
      const charge = num("pcharge1", "pCharge1", "chargePower") ?? 0;
      const discharge = num("pdischarge1", "pDischarge1", "dischargePower") ?? 0;
      const toUser = num("pacToUserTotal", "pactouser") ?? 0;
      const toGrid = num("pacToGridTotal", "pactogrid") ?? 0;
      const grid = toUser - toGrid;
      this.last = {
        at: new Date().toISOString(),
        pv_w: Math.round(pv),
        load_w: Math.round(load),
        battery_w: Math.round(charge - discharge),
        soc_pct: num("soc", "SOC", "capacity") ?? 0,
        grid_w: Math.round(grid),
        // vac1 is the surest signal; when a model omits it, any import from grid proves it is present.
        grid_available: num("vac1", "vAc1") !== null ? (num("vac1", "vAc1") ?? 0) > 100 : toUser > 0 ? true : null,
        source: this.name,
        raw: d,
      };
      return this.last;
    } catch (err) {
      if (this.last) return { ...this.last, source: `${this.name} (stale: ${(err as Error).message})` };
      throw err;
    }
  }
}
