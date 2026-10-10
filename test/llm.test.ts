import { test } from "node:test";
import assert from "node:assert/strict";
import { _setBedrockSenderForTests, checkMessages, converseInput, nextTurn, repairHistory } from "../src/demo/llm.js";

test("Bedrock mapping: tools become toolSpecs with object schemas; text and toolUse blocks come back as a reply", async () => {
  let seen: Record<string, unknown> | null = null;
  _setBedrockSenderForTests(async (input) => { seen = input; return { stopReason: "tool_use", output: { message: { content: [{ text: "Let me check." }, { toolUse: { toolUseId: "t1", name: "power_status", input: {} } }, { toolUse: { toolUseId: "t2", name: "can_i_run", input: { appliance: "iron" } } }, { toolUse: { name: "broken" } }] } } }; }, true);
  const tools = [{ name: "power_status", description: "x".repeat(2000), inputSchema: { type: "object", properties: {} } }, { name: "weird", inputSchema: "not a schema" }];
  const reply = await nextTurn([{ role: "user", content: [{ text: "How's the power?" }] }], tools);
  assert.equal(reply.mode, "bedrock"); assert.equal(reply.text, "Let me check."); assert.equal(reply.stop, "tool_use");
  assert.deepEqual(reply.toolCalls, [{ id: "t1", name: "power_status", input: {} }, { id: "t2", name: "can_i_run", input: { appliance: "iron" } }]);
  const cfg = (seen as unknown as { toolConfig: { tools: Array<{ toolSpec: { name: string; description: string; inputSchema: { json: { type: string } } } }> } }).toolConfig.tools;
  assert.equal(cfg.length, 2);
  assert.equal(cfg[0].toolSpec.description.length, 1000, "descriptions are capped");
  assert.equal(cfg[1].toolSpec.inputSchema.json.type, "object", "non-object schemas are replaced, not sent");
  assert.equal((seen as unknown as { system: Array<{ text: string }> }).system[0].text.includes("Never invent a number"), true);

  // An empty model reply is a reply, not a crash.
  _setBedrockSenderForTests(async () => ({}), true);
  const empty = await nextTurn([{ role: "user", content: [{ text: "hi" }] }], []);
  assert.deepEqual(empty, { mode: "bedrock", text: "", toolCalls: [], stop: "end_turn" });
  assert.equal("toolConfig" in converseInput([], []), false, "no tools → no toolConfig (Bedrock rejects an empty list)");
  _setBedrockSenderForTests(null, undefined);
});

test("checkMessages bounds and validates what the browser sends", () => {
  assert.equal(typeof checkMessages(null), "string");
  assert.equal(typeof checkMessages([]), "string");
  assert.equal(typeof checkMessages([{ role: "system", content: [{ text: "x" }] }]), "string");
  assert.equal(typeof checkMessages([{ role: "user", content: [] }]), "string");
  assert.equal(typeof checkMessages(Array.from({ length: 41 }, () => ({ role: "user", content: [{ text: "x" }] }))), "string");
  assert.equal(typeof checkMessages([{ role: "user", content: [{ text: "x".repeat(70_000) }] }]), "string");
  assert.ok(Array.isArray(checkMessages([{ role: "user", content: [{ text: "hi" }] }])));
});

test("repairHistory: a browser that lost a hop never sends Bedrock a non-alternating or unanswered history", () => {
  const u = (text: string) => ({ role: "user" as const, content: [{ text }] });
  const a = (id: string) => ({ role: "assistant" as const, content: [{ toolUse: { toolUseId: id, name: "power_status", input: {} } }] });
  const r = (id: string) => ({ role: "user" as const, content: [{ toolResult: { toolUseId: id, content: [{ text: "ok" }], status: "success" as const } }] });
  // Two user turns in a row (the first turn's model call failed) → merged.
  const merged = repairHistory([u("hi"), u("again")]);
  assert.equal(merged.length, 1); assert.equal(merged[0].content.length, 2);
  // Trailing toolUse with no result → dropped, conversation ends on the user.
  const trailing = repairHistory([u("hi"), a("t1")]);
  assert.deepEqual(trailing.map((m) => m.role), ["user"]);
  // Orphan toolResult (its toolUse was trimmed away) → the block is dropped, the turn text survives.
  const orphan = repairHistory([r("t0"), u("what now")]);
  assert.deepEqual(orphan.map((m) => m.role), ["user"]); assert.equal(orphan[0].content.length, 1);
  // A healthy history is untouched.
  const fine = [u("hi"), a("t1"), r("t1"), { role: "assistant" as const, content: [{ text: "done" }] }, u("thanks")];
  assert.deepEqual(repairHistory(fine), fine);
  assert.deepEqual(repairHistory([]), []);
});
