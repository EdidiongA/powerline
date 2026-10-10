/**
 * Disk-backed store — the zero-setup default.
 *
 * Writes are serialised through a per-process promise chain so concurrent
 * updates (a tool call racing the alert monitor) cannot interleave, and the file
 * is written atomically via a temp file + rename so a crash mid-write cannot
 * leave a truncated JSON file that would wipe the household on next boot.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { clone, emptyHousehold, normalize, sanitize, type Household, type StoreBackend, type StoreHealth } from "./types.js";

type Db = Record<string, Household>;

export class DiskStore implements StoreBackend {
  readonly name = "disk" as const;
  private readonly dir: string;
  private readonly file: string;
  private cache: Db | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dir = process.env.DATA_DIR ?? path.resolve("data")) {
    this.dir = dir;
    this.file = path.join(dir, "store.json");
  }

  private async load(): Promise<Db> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Db;
      this.cache = parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") console.error(`[store] ${this.file} unreadable (${e.message}); starting empty`);
      this.cache = {};
    }
    return this.cache;
  }

  private async persist(db: Db): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(tmp, this.file); // atomic on POSIX and Windows same-volume
  }

  /** Serialise every write through one chain; failures must not break the chain. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async get(id: string): Promise<Household> {
    const db = await this.load();
    const raw = db[id];
    return sanitize(clone(raw && typeof raw === "object" ? { ...emptyHousehold(), ...raw } : emptyHousehold()));
  }

  async update(id: string, mutate: (h: Household) => void): Promise<Household> {
    return this.enqueue(async () => {
      const db = await this.load();
      const raw = db[id];
      const next = sanitize(clone(raw && typeof raw === "object" ? { ...emptyHousehold(), ...raw } : emptyHousehold()));
      mutate(next);
      normalize(next);
      next.version = (next.version ?? 0) + 1;     // sanitised above, so a non-numeric version in the file restarts at 1
      db[id] = next;
      await this.persist(db);
      return clone(next);
    });
  }

  async health(): Promise<StoreHealth> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.access(this.dir);
      const n = Object.keys(await this.load()).length;
      return { backend: "disk", ok: true, detail: `${this.file} (${n} household${n === 1 ? "" : "s"})` };
    } catch (e) {
      return { backend: "disk", ok: false, detail: (e as Error).message };
    }
  }
}
