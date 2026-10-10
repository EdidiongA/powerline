import { test } from "node:test";
import assert from "node:assert/strict";
import { Authenticator } from "../src/auth.js";

const env = (o: Record<string, string>) => ({ ...o } as NodeJS.ProcessEnv);

test("no tokens configured: open, every request is the demo household", () => {
  const a = new Authenticator(env({}));
  assert.equal(a.required, false);
  assert.deepEqual(a.authenticate(null), { householdId: "demo-household" });
  assert.deepEqual(a.authenticate("Bearer anything"), { householdId: "demo-household" });
});

test("API_TOKENS maps each secret to its household", () => {
  const a = new Authenticator(env({ API_TOKENS: "lagos-home:secret-one-long, office:secret-two-long" }));
  assert.equal(a.householdCount, 2);
  assert.deepEqual(a.authenticate("Bearer secret-one-long"), { householdId: "lagos-home" });
  assert.deepEqual(a.authenticate("Bearer secret-two-long"), { householdId: "office" });
  assert.equal(a.authenticate("Bearer secret-one-lon"), null, "near-miss rejected");
  assert.equal(a.authenticate("Bearer "), null);
  assert.equal(a.authenticate(null), null);
  assert.equal(a.authenticate("Basic abc"), null, "only Bearer accepted");
});

test("legacy API_TOKEN still works and maps to DEMO_USER_ID", () => {
  const a = new Authenticator(env({ API_TOKEN: "single-secret", DEMO_USER_ID: "my-house" }));
  assert.deepEqual(a.authenticate("Bearer single-secret"), { householdId: "my-house" });
  assert.equal(a.authenticate("Bearer wrong"), null);
});

test("malformed or weak entries are ignored, not fatal", () => {
  const a = new Authenticator(env({ API_TOKENS: "nocolon,short:abc,ok:long-enough-secret" }));
  assert.equal(a.householdCount, 1);
  assert.deepEqual(a.authenticate("Bearer long-enough-secret"), { householdId: "ok" });
});

test("fails closed: a set-but-malformed API_TOKENS rejects everything rather than opening the endpoint", () => {
  const a = new Authenticator(env({ API_TOKENS: "nocolon" }));
  assert.equal(a.required, true);
  assert.equal(a.householdCount, 0);
  assert.equal(a.authenticate("Bearer nocolon"), null);
  assert.equal(a.authenticate(null), null);
  assert.match(a.describe(), /MISCONFIGURED/);
});
