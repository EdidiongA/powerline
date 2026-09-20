/**
 * Create the Powerline DynamoDB table. Idempotent: safe to run repeatedly.
 *   npm run dynamo:init
 * Uses on-demand billing, so an idle table costs nothing.
 */
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";

const table = process.env.DYNAMO_TABLE ?? "powerline";
const region = process.env.AWS_REGION ?? "us-east-1";
const client = new DynamoDBClient({ region, ...(process.env.DYNAMO_ENDPOINT ? { endpoint: process.env.DYNAMO_ENDPOINT } : {}) });

try {
  const existing = await client.send(new DescribeTableCommand({ TableName: table }));
  const keys = existing.Table?.KeySchema?.map((k) => `${k.AttributeName}:${k.KeyType}`).join(", ");
  console.log(`Table "${table}" already exists in ${region} (key ${keys}). Nothing to do.`);
  if (keys !== "pk:HASH") console.error(`WARNING: expected a single string partition key "pk"; found ${keys}. Powerline will not work against this table.`);
  process.exit(0);
} catch (e) {
  if ((e as Error).name !== "ResourceNotFoundException") {
    console.error(`Could not check for table "${table}": ${(e as Error).message}`);
    process.exit(1);
  }
}

console.log(`Creating table "${table}" in ${region}…`);
await client.send(new CreateTableCommand({
  TableName: table,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
  KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
}));
await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: table });
console.log(`Ready. Start Powerline with:  STORE=dynamodb npm run start:aws`);
