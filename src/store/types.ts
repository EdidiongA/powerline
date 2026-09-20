/**
 * Household state that outlives an MCP session.
 *
 * One record per household, written as a single item so every write is atomic.
 * `version` drives optimistic concurrency: two writers (a tool call and the
 * background alert monitor) routinely race, and last-write-wins would silently
 * drop one of them.
 */
import type { Appliance, GridEvent, SystemProfile } from "../forecast.js";

export interface Household {
  profile: SystemProfile | null;
  appliances: Appliance[];
  gridEvents: GridEvent[];
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

/**
 * Normalise and bound a record so a write can never be rejected for size and a
 * long-running household can never grow without limit. Grid events are the only
 * unbounded collection, so they are trimmed oldest-first.
 */
export function normalize(h: Household): Household {
  // Coerce nullish fields explicitly: DynamoDB rejects `undefined` attributes, and
  // depending on the SDK's removeUndefinedValues to strip them would put a data-integrity
  // guarantee in a client marshalling option. Keep it here, where every backend gets it.
  h.profile = h.profile ?? null;
  h.appliances = (h.appliances ?? []).filter((a) => a && typeof a.name === "string" && Number.isFinite(a.watts) && Number.isFinite(a.minutes));
  h.gridEvents = (h.gridEvents ?? [])
    .filter((e) => e && typeof e.at === "string" && typeof e.on === "boolean" && !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_GRID_EVENTS);
  h.updatedAt = new Date().toISOString();

  // Progressive trim if the record is still too large (defensive: appliances could be many).
  let guard = 0;
  while (byteSize(h) > MAX_ITEM_BYTES && guard++ < 24) {
    if (h.gridEvents.length > 1) h.gridEvents = h.gridEvents.slice(Math.ceil(h.gridEvents.length / 2));
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
