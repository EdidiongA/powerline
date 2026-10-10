/** Boot a real Powerline process on a free port for transport-level tests. */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as tcp } from "node:net";

const require = createRequire(import.meta.url);
const TSX = require.resolve("tsx/cli");

export async function freePort(): Promise<number> {
  return new Promise((res) => { const s = tcp(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
}

export async function boot(env: Record<string, string>): Promise<{ url: string; child: ChildProcess; stop(): Promise<{ code: number | null; ms: number }> }> {
  const port = await freePort();
  const child = spawn(process.execPath, [TSX, "src/http.ts"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: mkdtempSync(path.join(tmpdir(), "pl-http-")), ALERT_INTERVAL_MS: "600000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => { log += d; });
  child.stderr!.on("data", (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { const r = await fetch(`${url}/healthz`); if (r.ok) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = () => new Promise<{ code: number | null; ms: number }>((res) => {
    const t0 = Date.now();
    child.once("exit", (code) => res({ code, ms: Date.now() - t0 }));
    child.kill("SIGTERM");
  });
  return { url, child, stop };
}

