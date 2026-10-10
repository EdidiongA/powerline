/**
 * Household store — public API, unchanged for callers.
 *
 * Backend is chosen by STORE:
 *   STORE=disk      (default)  — data/store.json, zero setup
 *   STORE=dynamodb             — DYNAMO_TABLE, AWS_REGION (AWS Builder mini-challenge)
 */
import { DiskStore } from "./disk.js";
import { DynamoStore } from "./dynamo.js";
import type { Household, StoreBackend, StoreHealth } from "./types.js";

export type { Household, StoreBackend, StoreHealth, ArmedPlan, ArmedItem } from "./types.js";
export { StoreConflictError, StoreConfigError } from "./types.js";
export { DiskStore } from "./disk.js";
export { DynamoStore } from "./dynamo.js";

let backend: StoreBackend | null = null;

export function createStore(env = process.env): StoreBackend {
  const choice = (env.STORE ?? "disk").toLowerCase();
  if (choice === "dynamodb" || choice === "dynamo") return new DynamoStore();
  if (choice !== "disk") console.error(`[store] unknown STORE="${env.STORE}"; using disk`);
  return new DiskStore();
}

export function getStore(): StoreBackend {
  return (backend ??= createStore());
}

/** Test seam — swap the backend and drop any cached one. */
export function setStore(next: StoreBackend | null): void {
  backend = next;
}

export const getHousehold = (id: string): Promise<Household> => getStore().get(id);
export const updateHousehold = (id: string, mutate: (h: Household) => void): Promise<Household> => getStore().update(id, mutate);
export const storeHealth = (): Promise<StoreHealth> => getStore().health();
