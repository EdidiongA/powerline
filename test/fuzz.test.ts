/**
 * Crash hunt: every tool called with hostile arguments through a real client. The only
 * acceptable outcomes are a normal result, a tool result flagged isError, or a JSON-RPC
 * invalid-params error. A thrown anything-else, a hung call, or a server that stops answering
 * afterwards fails the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { DiskStore } from "../src/store/disk.js";
import { setStore } from "../src/store/index.js";
import type { Telemetry, TelemetrySource } from "../src/telemetry/types.js";

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const WEIRD = [null, undefined, 0, -1, 1e308, -1e308, Number.NaN, Number.POSITIVE_INFINITY, "", " ", "x".repeat(5000), "<script>alert(1)</script>", "\u0000", "💡", "2026-13-45T99:99:99Z", "2026-10-01T20:00:00Z", true, false, [], {}, [[]], { a: { b: { c: 1 } } }, "iron", "washing machine", 2000, 30, 4.5, 10, 20, "today", "week", "NGN"];
function randomValue(r: () => number, depth = 0): unknown {
  const k = Math.floor(r() * WEIRD.length);
  if (depth < 2 && r() < 0.15) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
  if (depth < 2 && r() < 0.15) return Object.fromEntries(["name", "watts", "minutes", "appliance", "period", "exact", "on", "at", "perKwh", "currency", "arrayKw", "batteryKwh", "inverterKw", "reserveSocPct", "appliances"].filter(() => r() < 0.4).map((key) => [key, randomValue(r, depth + 1)]));
  return WEIRD[k];
}

/** Telemetry that is itself hostile some of the time. */
function flakySource(r: () => number): TelemetrySource {
  return { name: "flaky", current: async () => {
    const base: Telemetry = { at: "2026-10-01T20:00:00.000Z", pv_w: 0, load_w: 300, battery_w: -300, soc_pct: 60, grid_w: 0, grid_available: false, source: "flaky" };
    const roll = r();
    if (roll < 0.1) return { ...base, soc_pct: Number.NaN, pv_w: Number.NaN, load_w: Number.NaN };
    if (roll < 0.2) return { ...base, at: "not-a-time" };
    if (roll < 0.3) return { ...base, grid_available: null, grid_w: null };
    if (roll < 0.35) throw new Error("inverter unreachable");
    return base;
  } };
}

test("no combination of hostile arguments and flaky telemetry crashes a tool or the server", async () => {
  const r = rng(2026);
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-fuzz-"))));
  const server = createServer({ userId: "fuzz", source: flakySource(r) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "fuzz", version: "0" });
  await client.connect(b);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.length >= 14);
  let calls = 0, invalid = 0, toolErrors = 0, ok = 0;
  const started = Date.now();
  for (const name of tools) {
    for (let i = 0; i < 25; i++) {
      const args = i % 5 === 0 ? {} : (randomValue(r, 1) as Record<string, unknown>);
      calls++;
      try {
        const res = await Promise.race([
          client.callTool({ name, arguments: typeof args === "object" && args !== null && !Array.isArray(args) ? args : { bad: args } }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("hung")), 5000)),
        ]) as { isError?: boolean };
        if (res.isError) toolErrors++; else ok++;
      } catch (e) {
        const msg = (e as Error).message;
        if (/hung/.test(msg)) assert.fail(`${name} hung on ${JSON.stringify(args).slice(0, 80)}`);
        // Invalid params from schema validation is the only acceptable throw.
        assert.match(msg, /-32602|[Ii]nvalid|[Rr]equired|[Ee]xpected|[Tt]oo (big|small)|must/i, `${name} threw something other than a validation error on ${JSON.stringify(args).slice(0, 80)}: ${msg}`);
        invalid++;
      }
    }
  }
  // Still alive and still correct afterwards.
  const fine = await client.callTool({ name: "list_appliances", arguments: {} }) as { isError?: boolean };
  assert.equal(fine.isError, undefined);
  const st = await client.callTool({ name: "power_status", arguments: {} }) as { structuredContent?: { forecast: unknown[] }; isError?: boolean };
  assert.ok(st.isError || (st.structuredContent?.forecast.length === 24));
  console.log(`# fuzz: ${calls} calls in ${Date.now() - started} ms — ok ${ok}, tool errors ${toolErrors}, rejected by schema ${invalid}`);
  await client.close(); await server.close(); setStore(null);
});
