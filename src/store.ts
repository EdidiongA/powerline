/**
 * Durable per-household store that outlives MCP sessions (disk JSON; swap for DynamoDB later).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Appliance, GridEvent, SystemProfile } from "./forecast.js";

const DATA_DIR = process.env.DATA_DIR ?? path.resolve("data");
const FILE = path.join(DATA_DIR, "store.json");

export interface Household {
  profile: SystemProfile | null;
  appliances: Appliance[];
  gridEvents: GridEvent[];
  updatedAt: string;
}

type Db = Record<string, Household>;
let cache: Db | null = null;

async function load(): Promise<Db> {
  if (cache) return cache;
  try { cache = JSON.parse(await fs.readFile(FILE, "utf8")) as Db; } catch { cache = {}; }
  return cache;
}
async function save(db: Db): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(db, null, 2));
}

const empty = (): Household => ({ profile: null, appliances: [], gridEvents: [], updatedAt: new Date().toISOString() });

export async function getHousehold(id: string): Promise<Household> {
  return (await load())[id] ?? empty();
}

export async function updateHousehold(id: string, fn: (h: Household) => void): Promise<Household> {
  const db = await load();
  const h = db[id] ?? empty();
  fn(h);
  h.updatedAt = new Date().toISOString();
  h.gridEvents = h.gridEvents.slice(-500); // keep the log bounded
  db[id] = h;
  await save(db);
  return h;
}
