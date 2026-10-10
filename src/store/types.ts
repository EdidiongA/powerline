/**
 * Household state that outlives an MCP session.
 *
 * One record per household, written as a single item so every write is atomic.
 * `version` drives optimistic concurrency: two writers (a tool call and the
 * background alert monitor) routinely race, and last-write-wins would silently
 * drop one of them.
 */
import type { Appliance, GridEvent, SystemProfile } from "../forecast.js";

/** One appliance the household has committed to run at a time Powerline chose. */
export interface ArmedItem {
  name: string;
  watts: number;
  minutes: number;
  startAt: string;          // ISO, in telemetry time
  source: "solar" | "grid" | "battery";
  firedAt?: string;         // set once the reminder has been delivered
}

export interface ArmedPlan {
  armedAt: string;
  items: ArmedItem[];
}

/** One hourly reading kept for reports and for learning the household's own pattern. */
export interface Sample {
  at: string;             // ISO, telemetry time, truncated to the hour
  pv_w: number;
  load_w: number;
  soc_pct: number;
  grid_on: boolean | null;
}

/** Grid tariff, so reports can say what the grid cost and what the sun was worth. */
export interface Tariff { currency: string; perKwh: number }

export interface Household {
  profile: SystemProfile | null;
  appliances: Appliance[];
  gridEvents: GridEvent[];
  /** The plan the user approved via arm_plan; reminders fire from it. */
  armedPlan?: ArmedPlan | null;
  /** Hourly history, newest last, bounded to MAX_SAMPLES (14 days). */
  samples?: Sample[];
  tariff?: Tariff | null;
  updatedAt: string;
  /** Incremented on every successful write. Absent on records written before versioning. */
  version?: number;
}

export interface StoreHealth {
  backend: "disk" | "dynamodb";
  ok: boolean;
  detail: string;
}

export interface StoreBackend {
  readonly name: "disk" | "dynamodb";
  /** Latest record for the household, or an empty one. Never throws for "not found". */
  get(id: string): Promise<Household>;
  /**
   * Apply `mutate` to the current record and persist it atomically.
   * `mutate` MUST be safe to call more than once: on a write conflict it is
   * re-applied to freshly read data rather than the stale copy.
   */
  update(id: string, mutate: (h: Household) => void): Promise<Household>;
  /** Cheap liveness probe for /healthz. Never throws. */
  health(): Promise<StoreHealth>;
  close?(): Promise<void>;
}

export const emptyHousehold = (): Household => ({
  profile: null,
  appliances: [],
  gridEvents: [],
  samples: [],
  tariff: null,
  updatedAt: new Date().toISOString(),
  version: 0,
});

/** Raised when a write could not be landed after exhausting retries. */
export class StoreConflictError extends Error {
  constructor(id: string, attempts: number) {
    super(`Could not save household "${id}" after ${attempts} attempts — too many concurrent writes.`);
    this.name = "StoreConflictError";
  }
}

/** Raised for problems the operator must fix (missing table, bad credentials). */
export class StoreConfigError extends Error {
  constructor(message: string, readonly hint: string) {
    super(hint ? `${message}\n  → ${hint}` : message);
    this.name = "StoreConfigError";
  }
}

// --- Invariants applied before every write, whichever backend is in use -------

/** DynamoDB's hard item limit is 400 KB; stay well under it. */
export const MAX_ITEM_BYTES = 300_000;
export const MAX_GRID_EVENTS = 500;
export const MAX_SAMPLES = 14 * 24;

/**
 * Normalise and bound a record so a write can never be rejected for size and a
 * long-running household can never grow without limit. Grid events are the only
 * unbounded collection, so they are trimmed oldest-first.
 */
export function normalize(h: Household): Household {
  sanitize(h);
  h.updatedAt = new Date().toISOString();
  return h;
}

/**
 * Make a record safe to compute on, without claiming it was just written. Applied on every
 * read as well as every write: a store file edited by hand, a record written by an older
 * version, or a bad item in DynamoDB must never be able to crash a tool call.
 */
export function sanitize(h: Household): Household {
  // Coerce nullish fields explicitly: DynamoDB rejects `undefined` attributes, and
  // depending on the SDK's removeUndefinedValues to strip them would put a data-integrity
  // guarantee in a client marshalling option. Keep it here, where every backend gets it.
  h.profile = h.profile ?? null;
  h.armedPlan = h.armedPlan ?? null;
  if (h.armedPlan) {
    h.armedPlan.items = (h.armedPlan.items ?? []).filter((i) => i && typeof i.name === "string" && !Number.isNaN(Date.parse(i.startAt)));
    if (h.armedPlan.items.length === 0) h.armedPlan = null;
  }
  h.appliances = (h.appliances ?? []).filter((a) => a && typeof a.name === "string" && Number.isFinite(a.watts) && Number.isFinite(a.minutes));
  h.tariff = h.tariff && Number.isFinite(h.tariff.perKwh) && h.tariff.perKwh >= 0 && typeof h.tariff.currency === "string" ? { currency: h.tariff.currency.slice(0, 8), perKwh: h.tariff.perKwh } : null;
  // One sample per hour slot, finite numbers only, newest last.
  const byHour = new Map<string, Sample>();
  for (const x of h.samples ?? []) {
    if (!x || typeof x.at !== "string" || Number.isNaN(Date.parse(x.at))) continue;
    if (![x.pv_w, x.load_w, x.soc_pct].every(Number.isFinite)) continue;
    const key = new Date(x.at).toISOString().slice(0, 13);
    byHour.set(key, { at: `${key}:00:00.000Z`, pv_w: Math.round(x.pv_w), load_w: Math.round(x.load_w), soc_pct: Math.round(x.soc_pct * 10) / 10, grid_on: typeof x.grid_on === "boolean" ? x.grid_on : null });
  }
  h.samples = [...byHour.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_SAMPLES);
  h.gridEvents = (h.gridEvents ?? [])
    .filter((e) => e && typeof e.at === "string" && typeof e.on === "boolean" && !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_GRID_EVENTS);
  if (h.profile) {
    const p = h.profile;
    const ok = [p.arrayKw, p.batteryKwh, p.inverterKw, p.reserveSocPct].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) && p.batteryKwh > 0 && p.inverterKw > 0 && p.reserveSocPct <= 90;
    if (!ok) h.profile = null; // a broken profile is worse than the default one
    else if (p.tzOffset !== undefined && !(typeof p.tzOffset === "number" && Number.isFinite(p.tzOffset) && p.tzOffset >= -12 && p.tzOffset <= 14)) delete p.tzOffset;
  }
  if (typeof h.updatedAt !== "string" || Number.isNaN(Date.parse(h.updatedAt))) h.updatedAt = new Date(0).toISOString();
  if (typeof h.version !== "number" || !Number.isFinite(h.version)) h.version = 0;

  // Progressive trim if the record is still too large (defensive: appliances could be many).
  let guard = 0;
  while (byteSize(h) > MAX_ITEM_BYTES && guard++ < 24) {
    if (h.samples.length > 24) h.samples = h.samples.slice(Math.ceil(h.samples.length / 2));
    else if (h.gridEvents.length > 1) h.gridEvents = h.gridEvents.slice(Math.ceil(h.gridEvents.length / 2));
    else if (h.appliances.length > 1) h.appliances = h.appliances.slice(0, Math.floor(h.appliances.length / 2));
    else break;
  }
  return h;
}

export const byteSize = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

/** Deep copy so a failed write attempt never leaves a half-applied mutation behind. */
export function clone<T>(v: T): T {
  return typeof structuredClone === "function" ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}
