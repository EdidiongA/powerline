/**
 * Store tests. The DynamoDB cases run against a fake that enforces conditional
 * writes, so the concurrency guarantees are demonstrated rather than assumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiskStore } from "../src/store/disk.js";
import { DynamoStore, asConfigError, backoffMs, isConditionFailure, isRetryable } from "../src/store/dynamo.js";
import { MAX_GRID_EVENTS, StoreConfigError, StoreConflictError, byteSize, normalize, type Household } from "../src/store/types.js";
import { FakeDynamo, FakeGet, FakePut, awsError } from "./helpers/fake-dynamo.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "powerline-"));
const noSleep = async () => {};
const store = (fake: FakeDynamo, over = {}) =>
  new DynamoStore({ table: "t", region: "us-east-1", client: fake, commands: { Get: FakeGet, Put: FakePut }, sleep: noSleep, readCacheMs: 0, ...over });

// ---- invariants ------------------------------------------------------------

test("normalize caps the grid-event log and drops malformed entries", () => {
  const h: Household = {
    profile: null, appliances: [{ name: "iron", watts: 2000, minutes: 30 }, { name: "bad", watts: Number.NaN, minutes: 1 } as any],
    gridEvents: [
      ...Array.from({ length: MAX_GRID_EVENTS + 250 }, (_, i) => ({ at: new Date(1.7e12 + i * 60000).toISOString(), on: i % 2 === 0 })),
      { at: "not-a-date", on: true }, { at: "2026-01-01T00:00:00Z", on: "yes" } as any,
    ],
    updatedAt: "",
  };
  normalize(h);
  assert.equal(h.gridEvents.length, MAX_GRID_EVENTS);
  assert.equal(h.appliances.length, 1);
  assert.ok(h.gridEvents.every((e) => !Number.isNaN(Date.parse(e.at))));
  // kept the most recent window, in order
  assert.ok(h.gridEvents[0].at < h.gridEvents[h.gridEvents.length - 1].at);
});

test("normalize trims a record that would exceed the item-size limit", () => {
  const h: Household = { profile: null, appliances: [], updatedAt: "",
    gridEvents: Array.from({ length: MAX_GRID_EVENTS }, (_, i) => ({ at: `${new Date(1.7e12 + i * 6e4).toISOString()}${"x".repeat(2000)}`, on: true })) };
  // force the oversize path with deliberately huge payloads
  normalize(h);
  assert.ok(byteSize(h) <= 300_000, `record still ${byteSize(h)} bytes`);
});

// ---- disk backend ----------------------------------------------------------

test("disk store round-trips and increments version", async () => {
  const s = new DiskStore(tmp());
  assert.equal((await s.get("h")).profile, null);
  const a = await s.update("h", (h) => { h.profile = { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 }; });
  assert.equal(a.version, 1);
  const b = await s.update("h", (h) => { h.appliances.push({ name: "iron", watts: 2000, minutes: 30 }); });
  assert.equal(b.version, 2);
  assert.equal((await s.get("h")).appliances.length, 1);
  assert.equal((await s.get("h")).profile?.arrayKw, 4.5);
});

test("disk store loses no writes under concurrency", async () => {
  const s = new DiskStore(tmp());
  await Promise.all(Array.from({ length: 40 }, (_, i) =>
    s.update("h", (h) => { h.gridEvents.push({ at: new Date(1.7e12 + i * 6e4).toISOString(), on: i % 2 === 0 }); })));
  assert.equal((await s.get("h")).gridEvents.length, 40);
});

test("disk store survives a corrupt file instead of crashing", async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, "store.json"), "{ this is not json");
  const s = new DiskStore(dir);
  assert.equal((await s.get("h")).appliances.length, 0);
  await s.update("h", (h) => { h.appliances.push({ name: "fan", watts: 60, minutes: 120 }); });
  assert.equal(JSON.parse(readFileSync(path.join(dir, "store.json"), "utf8")).h.appliances.length, 1);
});

test("disk store writes atomically (no .tmp left behind)", async () => {
  const dir = tmp();
  const s = new DiskStore(dir);
  await s.update("h", (h) => { h.appliances.push({ name: "fan", watts: 60, minutes: 10 }); });
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes("tmp")), []);
});

test("mutations are isolated: a caller cannot corrupt the store through the returned object", async () => {
  const s = new DiskStore(tmp());
  const h = await s.update("h", (x) => { x.appliances.push({ name: "iron", watts: 2000, minutes: 30 }); });
  h.appliances.push({ name: "ghost", watts: 1, minutes: 1 });
  assert.equal((await s.get("h")).appliances.length, 1);
});

// ---- error classification --------------------------------------------------

test("retryable vs fatal AWS failures are told apart", () => {
  for (const n of ["ThrottlingException", "ProvisionedThroughputExceededException", "InternalServerError", "TimeoutError"])
    assert.ok(isRetryable(awsError(n)), n);
  assert.ok(isRetryable(awsError("Whatever", 503)));
  assert.ok(isRetryable(awsError("Whatever", 429)));
  assert.ok(isRetryable(Object.assign(new Error("reset"), { code: "ECONNRESET" })));
  assert.equal(isRetryable(awsError("ValidationException", 400)), false);
  assert.equal(isRetryable(awsError("ResourceNotFoundException", 400)), false);
  assert.ok(isConditionFailure(awsError("ConditionalCheckFailedException")));
});

test("configuration failures carry the fix, not just the symptom", () => {
  const missing = asConfigError(awsError("ResourceNotFoundException"), "powerline", "us-east-1");
  assert.ok(missing instanceof StoreConfigError);
  assert.match(missing!.message, /dynamo:init/);
  assert.match(asConfigError(awsError("AccessDeniedException"), "t", "r")!.message, /DynamoDB/i);
  assert.match(asConfigError(awsError("UnrecognizedClientException"), "t", "r")!.message, /credentials/i);
  assert.equal(asConfigError(awsError("ThrottlingException"), "t", "r"), null);
});

test("backoff is bounded and jittered", () => {
  assert.equal(backoffMs(0, () => 1), 50);
  assert.equal(backoffMs(3, () => 1), 400);
  assert.equal(backoffMs(20, () => 1), 2000);      // capped
  assert.equal(backoffMs(5, () => 0), 0);          // full jitter can reach zero
});

// ---- dynamo backend --------------------------------------------------------

test("dynamo first write is conditional on the item not existing", async () => {
  const fake = new FakeDynamo();
  const s = store(fake);
  const h = await s.update("home", (x) => { x.profile = { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 }; });
  assert.equal(h.version, 1);
  const put = fake.calls.find((c) => c.type === "put")!;
  assert.match(put.input.ConditionExpression, /attribute_not_exists\(pk\)/);
  assert.equal(put.input.Item.pk, "HOUSEHOLD#home");
  assert.equal(fake.items.get("HOUSEHOLD#home")!.profile.arrayKw, 4.5);
});

test("dynamo reads inside the update cycle are strongly consistent", async () => {
  const fake = new FakeDynamo();
  const s = store(fake);
  await s.update("home", (x) => { x.appliances.push({ name: "iron", watts: 2000, minutes: 30 }); });
  assert.equal(fake.calls.find((c) => c.type === "get")!.input.ConsistentRead, true);
  await s.get("home");
  assert.equal(fake.calls.filter((c) => c.type === "get").pop()!.input.ConsistentRead, false);
});

test("dynamo does not lose an update when another writer wins the race", async () => {
  // A racing writer lands a grid event between our read and our write, exactly
  // once. The conditional write must fail, and our mutation must be re-applied
  // on top of the winner's data rather than overwriting it.
  let raced = false;
  const fake: FakeDynamo = new FakeDynamo({
    onBeforePut: (item) => {
      if (raced || !item.pk) return;
      raced = true;
      fake.items.set(item.pk, { pk: item.pk, profile: null, appliances: [], updatedAt: "x", version: 1,
        gridEvents: [{ at: "2026-09-15T20:00:00.000Z", on: false }] });
    },
  });
  fake.items.set("HOUSEHOLD#home", { pk: "HOUSEHOLD#home", profile: null, appliances: [], gridEvents: [], updatedAt: "x", version: 0 });

  const s = store(fake);
  const result = await s.update("home", (h) => { h.appliances.push({ name: "iron", watts: 2000, minutes: 30 }); });

  assert.equal(result.appliances.length, 1, "our mutation survived");
  assert.equal(result.gridEvents.length, 1, "the racing writer's event survived");
  assert.equal(result.version, 2);
  assert.ok(fake.calls.filter((c) => c.type === "put").length >= 2, "it retried");
});

test("dynamo converges under many concurrent updates", async () => {
  const fake = new FakeDynamo();
  const s = store(fake, { maxAttempts: 40 });
  await Promise.all(Array.from({ length: 12 }, (_, i) =>
    s.update("home", (h) => { h.gridEvents.push({ at: new Date(1.7e12 + i * 6e4).toISOString(), on: i % 2 === 0 }); })));
  const stored = fake.items.get("HOUSEHOLD#home")!;
  assert.equal(stored.gridEvents.length, 12, "every concurrent write landed");
  assert.equal(stored.version, 12);
});

test("dynamo retries throttling and then succeeds", async () => {
  const fake = new FakeDynamo({ failures: [awsError("ThrottlingException", 400), null, awsError("InternalServerError", 500)] });
  const s = store(fake);
  const h = await s.update("home", (x) => { x.appliances.push({ name: "fan", watts: 60, minutes: 30 }); });
  assert.equal(h.appliances.length, 1);
});

test("dynamo gives up with a clear error when conflicts never clear", async () => {
  // Every write is rejected: the store must stop rather than spin forever.
  let interloper = 500;
  const fake = new FakeDynamo({ onBeforePut: (item) => { fake.items.set(item.pk, { ...item, version: ++interloper }); } });
  const s = store(fake, { maxAttempts: 3 });
  await assert.rejects(() => s.update("home", (h) => { h.appliances.push({ name: "x", watts: 1, minutes: 1 }); }), StoreConflictError);
});

test("dynamo surfaces a missing table as a config error with the fix", async () => {
  const fake = new FakeDynamo({ failures: [awsError("ResourceNotFoundException")] });
  await assert.rejects(() => store(fake).get("home"), (e: Error) => e instanceof StoreConfigError && /dynamo:init/.test(e.message));
});

test("dynamo health reports the failure instead of throwing", async () => {
  const bad = await store(new FakeDynamo({ failures: [awsError("UnrecognizedClientException")] })).health();
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /credentials/i);
  const good = await store(new FakeDynamo()).health();
  assert.deepEqual([good.backend, good.ok], ["dynamodb", true]);
});

test("dynamo never writes undefined attributes", async () => {
  // DynamoDB rejects undefined attributes outright, so a tool call that clears a field
  // must not be able to produce one — regardless of SDK marshalling settings.
  const fake = new FakeDynamo();
  await store(fake).update("home", (h) => {
    (h as any).profile = undefined;
    (h as any).gridEvents = undefined;
    h.appliances = undefined as any;
  });
  const item = fake.calls.filter((c) => c.type === "put").pop()!.input.Item;
  for (const [k, v] of Object.entries(item)) assert.notEqual(v, undefined, `${k} was undefined`);
  assert.equal(item.profile, null);
  assert.deepEqual(item.appliances, []);
});

test("dynamo read cache is bypassed by the update cycle", async () => {
  const fake = new FakeDynamo();
  const s = store(fake, { readCacheMs: 60_000 });
  await s.get("home"); await s.get("home");
  assert.equal(fake.calls.filter((c) => c.type === "get").length, 1, "second read served from cache");
  await s.update("home", (h) => { h.appliances.push({ name: "iron", watts: 2000, minutes: 30 }); });
  assert.equal(fake.calls.filter((c) => c.type === "get" && c.input.ConsistentRead).length, 1, "update read went to the service");
  assert.equal((await s.get("home")).appliances.length, 1, "cache refreshed after write");
});

test("armed plan round-trips and malformed items are dropped", async () => {
  const s = new DiskStore(tmp());
  await s.update("h", (h) => {
    h.armedPlan = { armedAt: "2026-10-01T19:00:00Z", items: [
      { name: "iron", watts: 2000, minutes: 30, startAt: "2026-10-02T09:00:00Z", source: "solar" },
      { name: "bad", watts: 1, minutes: 1, startAt: "not-a-date", source: "grid" } as any,
    ] };
  });
  const h = await s.get("h");
  assert.equal(h.armedPlan?.items.length, 1);
  await s.update("h", (x) => { x.armedPlan = { armedAt: "x", items: [] }; });
  assert.equal((await s.get("h")).armedPlan, null, "an empty armed plan collapses to null");
});

test("a hand-edited or legacy store file cannot crash a read: records are sanitised on the way in", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "pl-corrupt-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "store.json"), JSON.stringify({
    legacy: { profile: { arrayKw: "4.5", batteryKwh: 10 }, appliances: [{ name: 5 }, { name: "ok", watts: 100, minutes: 10 }], gridEvents: [{ at: "garbage", on: true }, { at: "2026-10-01T00:00:00Z", on: "yes" }] },
    broken: { samples: [{ at: "not a date", pv_w: 1 }, { at: "2026-10-01T05:00:00Z", pv_w: NaN, load_w: 1, soc_pct: 50 }, { at: "2026-10-01T06:30:00Z", pv_w: 10, load_w: 20, soc_pct: 55, grid_on: "maybe" }], tariff: { currency: 42, perKwh: -1 }, version: "x", updatedAt: null },
    notanobject: 7,
  }));
  const { DiskStore } = await import("../src/store/disk.js");
  const store = new DiskStore(dir);
  const legacy = await store.get("legacy");
  assert.equal(legacy.profile, null, "a profile with a string field is dropped, not trusted");
  assert.deepEqual(legacy.appliances.map((a) => a.name), ["ok"]);
  assert.deepEqual(legacy.gridEvents, []);
  assert.deepEqual(legacy.samples, []);
  const broken = await store.get("broken");
  assert.deepEqual(broken.samples, [{ at: "2026-10-01T06:00:00.000Z", pv_w: 10, load_w: 20, soc_pct: 55, grid_on: null }]);
  assert.equal(broken.tariff, null);
  assert.equal(broken.version, 0);
  assert.equal(typeof broken.updatedAt, "string");
  const nope = await store.get("notanobject");
  assert.deepEqual(nope.appliances, []);
  // And a write through the same record keeps working.
  const after = await store.update("broken", (h) => { h.appliances.push({ name: "pump", watts: 1, minutes: 1 }); });
  assert.equal(after.version, 1);
});
