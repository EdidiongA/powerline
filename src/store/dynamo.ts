/**
 * Amazon DynamoDB store — AWS Builder mini-challenge.
 *
 * One item per household, keyed `HOUSEHOLD#<id>`, written whole so every update
 * is atomic. Correctness notes, because the naive version of this is subtly broken:
 *
 *  1. CONCURRENCY. Powerline has two writers by design — tool calls and the
 *     per-session alert monitor, which logs grid flips on a timer. A plain
 *     read-modify-write loses one of them. Every write carries a conditional
 *     expression on `version`; on conflict the mutation is re-applied to freshly
 *     read data rather than the stale copy, so no update is lost.
 *  2. CONSISTENCY. The read inside the update cycle is a strongly consistent read.
 *     An eventually consistent read there would hand back a stale version number
 *     and cause the conditional write to thrash.
 *  3. TRANSIENT FAILURE. Throttling, 5xx and socket errors are retried with
 *     exponential backoff and full jitter; misconfiguration (missing table, bad
 *     credentials) is not retried and is reported with the fix.
 *  4. ITEM SIZE. DynamoDB rejects items over 400 KB. Records are bounded before
 *     every write (see normalize()).
 *
 * Setup:  npm run dynamo:init     (creates the table, on-demand billing)
 * Enable: STORE=dynamodb  DYNAMO_TABLE=powerline  AWS_REGION=us-east-1
 */
import { clone, emptyHousehold, normalize, sanitize, StoreConfigError, StoreConflictError, type Household, type StoreBackend, type StoreHealth } from "./types.js";

/** Minimal shape of the document client, so tests can substitute a fake. */
export interface DocClientLike { send(command: unknown): Promise<any> }

export interface DynamoStoreOptions {
  table?: string;
  region?: string;
  endpoint?: string;
  maxAttempts?: number;
  readCacheMs?: number;
  client?: DocClientLike;
  commands?: { Get: new (i: any) => unknown; Put: new (i: any) => unknown };
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_NAMES = new Set([
  "ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded",
  "InternalServerError", "ServiceUnavailable", "RequestTimeout", "RequestTimeoutException",
  "TimeoutError", "AbortError", "NetworkingError", "TransactionConflictException",
]);
const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

const errName = (e: unknown): string => (e as { name?: string })?.name ?? "";
const errCode = (e: unknown): string => (e as { code?: string })?.code ?? "";
const httpStatus = (e: unknown): number => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0;

export function isRetryable(e: unknown): boolean {
  if (RETRYABLE_NAMES.has(errName(e)) || RETRYABLE_CODES.has(errCode(e))) return true;
  const s = httpStatus(e);
  return s === 429 || (s >= 500 && s < 600);
}

export function isConditionFailure(e: unknown): boolean {
  return errName(e) === "ConditionalCheckFailedException";
}

/** Turn an AWS failure the operator must fix into an error that says how to fix it. */
export function asConfigError(e: unknown, table: string, region: string): StoreConfigError | null {
  switch (errName(e)) {
    case "ResourceNotFoundException":
      return new StoreConfigError(`DynamoDB table "${table}" does not exist in ${region}.`, `Run: npm run dynamo:init   (or set DYNAMO_TABLE to an existing table)`);
    case "AccessDeniedException":
    case "AccessDeniedByFirewall":
      return new StoreConfigError(`Not authorised to use DynamoDB table "${table}".`, `Attach AmazonDynamoDBFullAccess to the IAM user, or allow GetItem/PutItem on the table.`);
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
    case "InvalidClientTokenId":
      return new StoreConfigError("AWS rejected the credentials.", "Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env, then restart with npm run start:aws");
    case "CredentialsProviderError":
      return new StoreConfigError("No AWS credentials found.", "Add them to .env and start with npm run start:aws");
    case "ValidationException":
      return new StoreConfigError(`DynamoDB rejected the request: ${(e as Error).message}`, "This usually means the table's key schema differs from pk (string). Recreate it with npm run dynamo:init");
    default:
      return null;
  }
}

/** Exponential backoff with full jitter — avoids a retry storm when several sessions throttle together. */
export const backoffMs = (attempt: number, rnd = Math.random) => Math.round(rnd() * Math.min(2_000, 50 * 2 ** attempt));

export class DynamoStore implements StoreBackend {
  readonly name = "dynamodb" as const;
  private readonly table: string;
  private readonly region: string;
  private readonly maxAttempts: number;
  private readonly readCacheMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private client: DocClientLike | null;
  private commands: { Get: new (i: any) => unknown; Put: new (i: any) => unknown } | null;
  private readonly endpoint?: string;
  private cache = new Map<string, { at: number; value: Household }>();

  constructor(opts: DynamoStoreOptions = {}) {
    this.table = opts.table ?? process.env.DYNAMO_TABLE ?? "powerline";
    this.region = opts.region ?? process.env.AWS_REGION ?? "us-east-1";
    this.endpoint = opts.endpoint ?? process.env.DYNAMO_ENDPOINT;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? Number(process.env.DYNAMO_MAX_ATTEMPTS ?? 6));
    this.readCacheMs = opts.readCacheMs ?? Number(process.env.DYNAMO_READ_CACHE_MS ?? 3_000);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.client = opts.client ?? null;
    this.commands = opts.commands ?? null;
  }

  /** Lazy-load the AWS SDK so the server starts (and the disk store works) without it installed. */
  private async ready(): Promise<{ client: DocClientLike; Get: new (i: any) => unknown; Put: new (i: any) => unknown }> {
    if (this.client && this.commands) return { client: this.client, ...this.commands };
    try {
      const [{ DynamoDBClient }, { DynamoDBDocumentClient, GetCommand, PutCommand }] = await Promise.all([
        import("@aws-sdk/client-dynamodb"),
        import("@aws-sdk/lib-dynamodb"),
      ]);
      const base = new DynamoDBClient({ region: this.region, ...(this.endpoint ? { endpoint: this.endpoint } : {}) });
      this.client = DynamoDBDocumentClient.from(base, {
        // undefined values are a runtime error in DynamoDB; strip them rather than crash a tool call.
        marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
      }) as unknown as DocClientLike;
      this.commands = { Get: GetCommand as any, Put: PutCommand as any };
      return { client: this.client, ...this.commands };
    } catch (e) {
      throw new StoreConfigError("The AWS SDK for DynamoDB is not installed.", "Run: npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb");
    }
  }

  private pk(id: string) { return `HOUSEHOLD#${id}`; }

  /** Run an AWS call with retry/backoff; config problems fail fast with a fix. */
  private async call<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        const config = asConfigError(e, this.table, this.region);
        if (config) throw config;
        if (isConditionFailure(e)) throw e;       // handled by the caller's conflict loop
        if (!isRetryable(e)) throw e;
        if (attempt === this.maxAttempts - 1) break;
        const wait = backoffMs(attempt);
        console.error(`[store] ${label} failed (${errName(e) || errCode(e) || "error"}); retrying in ${wait} ms`);
        await this.sleep(wait);
      }
    }
    throw last;
  }

  /** @param consistent strongly consistent + cache-bypassing; required inside the update cycle. */
  private async read(id: string, consistent: boolean): Promise<Household> {
    if (!consistent && this.readCacheMs > 0) {
      const hit = this.cache.get(id);
      if (hit && Date.now() - hit.at < this.readCacheMs) return clone(hit.value);
    }
    const { client, Get } = await this.ready();
    const res = await this.call(
      () => client.send(new Get({ TableName: this.table, Key: { pk: this.pk(id) }, ConsistentRead: consistent })),
      "read",
    );
    const item = (res as { Item?: Record<string, unknown> }).Item;
    const value: Household = item
      ? {
          profile: (item.profile as Household["profile"]) ?? null,
          appliances: (item.appliances as Household["appliances"]) ?? [],
          gridEvents: (item.gridEvents as Household["gridEvents"]) ?? [],
          armedPlan: (item.armedPlan as Household["armedPlan"]) ?? null,
          samples: (item.samples as Household["samples"]) ?? [],
          tariff: (item.tariff as Household["tariff"]) ?? null,
          updatedAt: (item.updatedAt as string) ?? new Date().toISOString(),
          version: typeof item.version === "number" ? item.version : 0,
        }
      : emptyHousehold();
    sanitize(value);
    this.cache.set(id, { at: Date.now(), value: clone(value) });
    return value;
  }

  async get(id: string): Promise<Household> {
    return this.read(id, false);
  }

  async update(id: string, mutate: (h: Household) => void): Promise<Household> {
    const { client, Put } = await this.ready();

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const current = await this.read(id, true);          // consistent: the version must be current
      const expected = current.version ?? 0;
      const next = clone(current);
      mutate(next);                                        // re-applied on conflict, never to stale data
      normalize(next);
      next.version = expected + 1;

      const item = { pk: this.pk(id), ...next };
      try {
        await this.call(
          () => client.send(new Put({
            TableName: this.table,
            Item: item,
            // First write ever, or nobody has written since we read.
            ConditionExpression: "attribute_not_exists(pk) OR #v = :expected",
            ExpressionAttributeNames: { "#v": "version" },
            ExpressionAttributeValues: { ":expected": expected },
          })),
          "write",
        );
        this.cache.set(id, { at: Date.now(), value: clone(next) });
        return clone(next);
      } catch (e) {
        if (!isConditionFailure(e)) throw e;
        this.cache.delete(id);
        if (attempt < this.maxAttempts - 1) await this.sleep(backoffMs(attempt));
      }
    }
    throw new StoreConflictError(id, this.maxAttempts);
  }

  async health(): Promise<StoreHealth> {
    try {
      const { client, Get } = await this.ready();
      await client.send(new Get({ TableName: this.table, Key: { pk: "HOUSEHOLD#__health__" }, ConsistentRead: false }));
      return { backend: "dynamodb", ok: true, detail: `table ${this.table} in ${this.region}` };
    } catch (e) {
      const config = asConfigError(e, this.table, this.region);
      return { backend: "dynamodb", ok: false, detail: (config ?? (e as Error)).message };
    }
  }
}
