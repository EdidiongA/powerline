/**
 * Amazon Bedrock hook — AWS Builder mini-challenge.
 *
 * Disabled unless BEDROCK_MODEL_ID is set, so the server runs with zero AWS
 * setup. When enabled, uses the Bedrock Converse API via the AWS SDK.
 *
 *   npm install @aws-sdk/client-bedrock-runtime
 *   export AWS_REGION=us-east-1
 *   export BEDROCK_MODEL_ID=anthropic.claude-3-5-haiku-20241022-v1:0   # or any Converse-capable model
 *
 * Document this usage in your Product Feedback answer for the mini-challenge.
 */

const MODEL_ID = process.env.BEDROCK_MODEL_ID;

export const bedrockEnabled = Boolean(MODEL_ID);

export async function summarize(text: string): Promise<string> {
  if (!MODEL_ID) {
    return `[bedrock disabled] ${text.slice(0, 200)}`;
  }
  // Lazy import so the dependency is optional.
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({});
  const res = await client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: "user", content: [{ text: `Summarize in one sentence for a voice assistant:\n\n${text}` }] }],
      inferenceConfig: { maxTokens: 200 },
    }),
  );
  const block = res.output?.message?.content?.[0];
  return block && "text" in block && block.text ? block.text : "";
}
