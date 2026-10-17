/**
 * Amazon Bedrock hook — AWS Builder mini-challenge.
 *
 * Disabled unless BEDROCK_MODEL_ID is set, so the server runs with zero AWS setup.
 * When enabled, phrases the briefing through the Bedrock Converse API:
 *
 *   AWS_REGION=us-east-1
 *   BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0   # any Converse-capable model or inference profile
 *
 * The facts are computed by the forecast engine; the model only phrases them. It is told
 * not to add numbers of its own, and the caller falls back to the plain facts if it fails.
 */
import type { BedrockRuntimeClient as BedrockClient } from "@aws-sdk/client-bedrock-runtime";

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const TIMEOUT_MS = (() => { const n = Number(process.env.BEDROCK_TIMEOUT_MS); return process.env.BEDROCK_TIMEOUT_MS?.trim() && Number.isFinite(n) && n > 0 ? n : 15_000; })();

export const bedrockEnabled = Boolean(MODEL_ID);

const SYSTEM = [
  "You are Powerline, a home power copilot speaking through a voice assistant.",
  "Turn the facts you are given into one short spoken paragraph (two to four sentences) a household can act on tonight.",
  "Use only the numbers provided; never invent or round them differently. Lead with whether the battery will hold.",
  "If the reserve will be reached, say when and what to switch off. Warm, plain, no lists, no headings, no emojis.",
].join(" ");

let client: BedrockClient | null = null;

export async function summarize(text: string): Promise<string> {
  if (!MODEL_ID) return `[bedrock disabled] ${text.slice(0, 200)}`;
  // Lazy import so the SDK is loaded only when the feature is on; one client for the process.
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  client ??= new BedrockRuntimeClient({});
  const res = await client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM }],
      messages: [{ role: "user", content: [{ text: `Facts:\n${text}` }] }],
      inferenceConfig: { maxTokens: 220, temperature: 0.4 },
    }),
    { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  const block = res.output?.message?.content?.find((b) => typeof (b as { text?: unknown }).text === "string") ?? res.output?.message?.content?.[0]; // the first TEXT block; a reasoning block may come first
  return block && "text" in block && block.text ? block.text : "";
}
