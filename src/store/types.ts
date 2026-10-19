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

/** "naira", "₦", "ngn" → "NGN"; anything else upper-cased. Applied on write and on every read, so old records agree too. */
export const normalizeCurrency = (c: string): string => (/^(₦|n|naira|ngn)$/i.test(c.trim()) ? "NGN" : c.trim().toUpperCase().slice(0, 8));

/** The household's prepaid meter. The balance is the last known figure (the user's, or after a purchase); usage since is estimated from history. */
export interface Meter {
  number: string;          // 11–13 digits
  disco: string;           // key into DISCOS (src/vending.ts)
  customerName?: string;   // as the distribution company has it, from verification
  minAmount?: number;      // the DisCo's minimum purchase, from verification
  unitsKwh?: number;       // last known balance
  unitsAt?: string;        // telemetry time of that balance
  lowerBound?: boolean;    // the balance is a floor (units bought while the previous balance was unknown)
}

/** One prepaid purchase. Recorded as "pending" before the vendor is called, so a crash mid-call never loses money silently. */
export interface Purchase {
  ref: string;             // request id sent to the vendor; the idempotency key
  at: string;              // wall-clock ISO (spending limits are about real days, not simulated ones)
  amount: number;          // naira
  meter: string;
  vendor: string;
  status: "pending" | "delivered" | "failed";
  token?: string;
  units?: number;
  message?: string;
  vendorRef?: string;      // the vendor's transaction id, for reconciliation
}

export interface Household {
  profile: SystemProfile | null;
  appliances: Appliance[];
  gridEvents: GridEvent[];
  /** The plan the user approved via arm_plan; reminders fire from it. */
  armedPlan?: ArmedPlan | null;
  /** Hourly history, newest last, bounded to MAX_SAMPLES (14 days). */
  samples?: Sample[];
  tariff?: Tariff | null;
  meter?: Meter | null;
  /** Prepaid purchases, newest last, bounded to MAX_PURCHASES. */
  purchases?: Purchase[];
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
  meter: null,
  purchases: [],
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
export const MAX_PURCHASES = 50;
/** Far above what the daily ceiling allows (₦50,000 / ₦500 minimum = 100 purchases), so trimming can never hide spending. */
export const MAX_RECENT_PURCHASES = 1000;

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
/**
 * A timestamp the engine can compute on: parseable and within ±200 years of now. JavaScript accepts
 * years up to ±275760; a sample that far out survives Date.parse but makes toISOString() throw once
 * the timezone shift is applied, which would take every tool for that household down with it.
 */
// ±200 years: far wider than any simulated clock can drift from wall time in a deployment's lifetime, far narrower than the cliff.
const PLAUSIBLE_SPAN_MS = 200 * 365 * 86_400_000;
export function plausibleMs(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && Math.abs(ms - Date.now()) <= PLAUSIBLE_SPAN_MS ? ms : null;
}
const wattsOk = (w: unknown): w is number => typeof w === "number" && Number.isFinite(w) && w > 0 && w <= 50_000;
const minutesOk = (m: unknown): m is number => typeof m === "number" && Number.isFinite(m) && m >= 1 && m <= 1_440;
const SOURCES = new Set(["solar", "grid", "battery"]);

export function sanitize(h: Household): Household {
  // Coerce nullish fields explicitly: DynamoDB rejects `undefined` attributes, and
  // depending on the SDK's removeUndefinedValues to strip them would put a data-integrity
  // guarantee in a client marshalling option. Keep it here, where every backend gets it.
  // A hand-edited file or a foreign item can hold anything in these slots; a non-array is treated as empty, never thrown on.
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  h.profile = (obj(h.profile) as typeof h.profile) ?? null;
  h.armedPlan = (obj(h.armedPlan) as typeof h.armedPlan) ?? null;
  if (h.armedPlan) {
    h.armedPlan.items = arr<ArmedItem>(h.armedPlan.items)
      .filter((i) => i && typeof i.name === "string" && plausibleMs(i.startAt) !== null && wattsOk(i.watts) && minutesOk(i.minutes) && SOURCES.has(i.source))
      .map((i) => ({ ...i, name: i.name.slice(0, 60), startAt: new Date(plausibleMs(i.startAt) as number).toISOString() }))
      .slice(0, 200);
    if (h.armedPlan.items.length === 0 || typeof h.armedPlan.armedAt !== "string") h.armedPlan = null;
  }
  // The same bounds the tools enforce: a negative wattage in a hand-edited file would make a plan "run on solar surplus",
  // and zero minutes makes every run vacuously covered.
  h.appliances = arr<Appliance>(h.appliances).filter((a) => a && typeof a.name === "string" && wattsOk(a.watts) && minutesOk(a.minutes)).map((a) => ({ ...a, name: a.name.slice(0, 60) }));
  h.tariff = obj(h.tariff) as typeof h.tariff;
  h.tariff = h.tariff && Number.isFinite(h.tariff.perKwh) && h.tariff.perKwh >= 0 && typeof h.tariff.currency === "string" ? { currency: normalizeCurrency(h.tariff.currency), perKwh: h.tariff.perKwh } : null;
  // Prepaid meter: digits only, a known distribution company, a finite non-negative balance with a plausible time.
  const m = obj(h.meter) as Meter | null;
  if (m && typeof m.number === "string" && /^\d{11,13}$/.test(m.number) && typeof m.disco === "string" && /^[a-z]{2,20}$/.test(m.disco)) {
    const balanceOk = typeof m.unitsKwh === "number" && Number.isFinite(m.unitsKwh) && m.unitsKwh >= 0 && m.unitsKwh <= 100_000 && plausibleMs(m.unitsAt) !== null;
    h.meter = { number: m.number, disco: m.disco, ...(typeof m.customerName === "string" ? { customerName: m.customerName.slice(0, 80) } : {}),
      ...(typeof m.minAmount === "number" && Number.isFinite(m.minAmount) && m.minAmount > 0 && m.minAmount <= 1_000_000 ? { minAmount: m.minAmount } : {}),
      ...(balanceOk ? { unitsKwh: Math.round(m.unitsKwh! * 10) / 10, unitsAt: new Date(plausibleMs(m.unitsAt) as number).toISOString(), ...(m.lowerBound === true ? { lowerBound: true } : {}) } : {}) };
  } else h.meter = null;
  const STATUSES = new Set(["pending", "delivered", "failed"]);
  h.purchases = arr<Purchase>(h.purchases)
    .filter((x) => x && typeof x.ref === "string" && x.ref.length >= 12 && x.ref.length <= 64 && plausibleMs(x.at) !== null && typeof x.amount === "number" && Number.isFinite(x.amount) && x.amount > 0 && x.amount <= 10_000_000 && typeof x.meter === "string" && STATUSES.has(x.status))
    .map((x) => ({ ref: x.ref, at: new Date(plausibleMs(x.at) as number).toISOString(), amount: x.amount, meter: x.meter.slice(0, 13), vendor: String(x.vendor ?? "").slice(0, 24), status: x.status,
      ...(typeof x.token === "string" ? { token: x.token.replace(/\D/g, "").slice(0, 40) } : {}),
      ...(typeof x.units === "number" && Number.isFinite(x.units) && x.units >= 0 ? { units: x.units } : {}),
      ...(typeof x.message === "string" ? { message: x.message.slice(0, 200) } : {}),
      ...(typeof x.vendorRef === "string" ? { vendorRef: x.vendorRef.slice(0, 64) } : {}) }));
  // Bounded by AGE, not count: the rolling 24-hour spending ceiling sums these, so every purchase from the last day
  // (and anything still pending) must survive. Older ones are history; keep the last few for the record.
  const dayAgo = Date.now() - 25 * 3_600_000;
  // Failed purchases cost nothing and do not count toward the ceiling: keep only the latest few, so they can never crowd the record past its size limit.
  const failedKeep = new Set(h.purchases.filter((x) => x.status === "failed").slice(-MAX_PURCHASES).map((x) => x.ref));
  h.purchases = h.purchases.filter((x) => x.status !== "failed" || failedKeep.has(x.ref));
  const recent = h.purchases.filter((x) => x.status === "pending" || Date.parse(x.at) > dayAgo);
  const older = h.purchases.filter((x) => !(x.status === "pending" || Date.parse(x.at) > dayAgo));
  h.purchases = [...older.slice(-MAX_PURCHASES), ...recent.slice(-MAX_RECENT_PURCHASES)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // One sample per hour slot, finite numbers only, newest last.
  const byHour = new Map<string, Sample>();
  for (const x of arr<Sample>(h.samples)) {
    const ms = x ? plausibleMs(x.at) : null;
    if (ms === null) continue;
    if (![x.pv_w, x.load_w, x.soc_pct].every(Number.isFinite)) continue;
    const key = new Date(ms).toISOString().slice(0, 13);
    byHour.set(key, { at: `${key}:00:00.000Z`, pv_w: Math.round(x.pv_w), load_w: Math.round(x.load_w), soc_pct: Math.round(x.soc_pct * 10) / 10, grid_on: typeof x.grid_on === "boolean" ? x.grid_on : null });
  }
  h.samples = [...byHour.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_SAMPLES);
  h.gridEvents = arr<GridEvent>(h.gridEvents)
    .filter((e) => e && typeof e.on === "boolean" && plausibleMs(e.at) !== null)
    .map((e) => ({ ...e, at: new Date(plausibleMs(e.at) as number).toISOString() }))
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
