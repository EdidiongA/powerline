/**
 * An in-memory stand-in for DynamoDBDocumentClient that enforces the parts of the
 * real service Powerline depends on: conditional writes on `version`, and
 * injectable failures. Without conditional enforcement a concurrency test proves
 * nothing, so the fake implements the condition rather than ignoring it.
 */
export interface FakeOptions {
  /** Queue of errors thrown before succeeding; one entry per client call. */
  failures?: Array<Error | null>;
  /** Runs immediately before each Put lands — use it to simulate a racing writer. */
  onBeforePut?: (item: Record<string, any>) => void | Promise<void>;
}

export class ConditionalCheckFailed extends Error {
  constructor() { super("The conditional request failed"); this.name = "ConditionalCheckFailedException"; }
}

export function awsError(name: string, status?: number): Error {
  const e = new Error(name);
  e.name = name;
  (e as any).$metadata = { httpStatusCode: status };
  return e;
}

export class FakeDynamo {
  items = new Map<string, Record<string, any>>();
  calls: Array<{ type: "get" | "put"; input: any }> = [];
  private failures: Array<Error | null>;

  constructor(private opts: FakeOptions = {}) { this.failures = [...(opts.failures ?? [])]; }

  async send(command: any): Promise<any> {
    const queued = this.failures.shift();
    if (queued) throw queued;

    if (command.__type === "get") {
      this.calls.push({ type: "get", input: command.input });
      const item = this.items.get(command.input.Key.pk);
      return { Item: item ? structuredClone(item) : undefined };
    }

    const input = command.input;
    this.calls.push({ type: "put", input });
    await this.opts.onBeforePut?.(input.Item);

    if (input.ConditionExpression) {
      const stored = this.items.get(input.Item.pk);
      const expected = input.ExpressionAttributeValues?.[":expected"];
      const firstWriteAllowed = /attribute_not_exists\(pk\)/.test(input.ConditionExpression);
      const unversionedAllowed = /attribute_not_exists\(#v\)/.test(input.ConditionExpression);
      // DynamoDB semantics: a missing attribute never equals a value, so `#v = :expected` is false for an unversioned item.
      const ok = stored ? (stored.version === undefined ? unversionedAllowed : stored.version === expected) : firstWriteAllowed;
      if (!ok) throw new ConditionalCheckFailed();
    }
    this.items.set(input.Item.pk, structuredClone(input.Item));
    return {};
  }
}

export const FakeGet = class { input: any; __type = "get"; constructor(i: any) { this.input = i; } } as any;
export const FakePut = class { input: any; __type = "put"; constructor(i: any) { this.input = i; } } as any;
