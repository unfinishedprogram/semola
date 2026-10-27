---
title: Workflow
description: Semola durable workflows - multi-step Redis jobs with resumable steps and retries
---

Durable workflows on Redis. Event history, deterministic replay, inline steps, multi-replica leases, and crashed or stalled runs that any replica picks up once `lockTTL` passes.
Workflows run multi-step processes that survive restarts. Each named `step` caches its result in Redis, so replay and reclaim skip work that already succeeded.

Needs a `Bun.RedisClient`. Workflow names must be unique in the process. Execution IDs must be unique per workflow name (Redis keys are `workflow:{name}:…`).

## Import

```typescript
import {
  defineWorkflow,
  listWorkflows,
  NotFoundError,
  type WorkflowExecution,
} from "semola/workflow";
```

Also exported: `DuplicateWorkflowError`, `InvalidStepFailureError`, `InvalidWorkflowOptionsError`, `StepFailure`, `SerializationError`, `WorkflowStoreError`, and the public workflow types (`Workflow`, `WorkflowOptions`, `WorkflowFailure`, `WorkflowStepFailure`, hooks/status/start/cancel shapes, `WorkflowListItem`, etc.).

## Quick start

This registers embedded workers, starts one execution, then reads its current status. During replay, completed named steps are loaded from Redis instead of running again.

```typescript
const onboard = defineWorkflow<{ userId: string }, { ok: true }>({
  name: "onboard-user",
  redis: redisClient,
  handler: async ({ input, step, sleep }) => {
    await step("send-email", async () => {
      await emailClient.send(input.userId);
    });

    await sleep(1000);

    await step("provision", async () => {
      await provision(input.userId);
    });

    return { ok: true };
  },
});

const { executionId } = await onboard.start({ userId: "u_1" });
const execution = await onboard.get(executionId);
```

`start()` enqueues work for embedded workers and returns `pending`. Poll `get(executionId)` for the eventual result. Call `stop()` on shutdown.

`startSync()` starts (or attaches to) an execution and waits until it is terminal (`completed` / `failed` / `cancelled`). It does not throw on child failure: read `status` and `failure`. Use it inside a parent `step` so replay reuses the memoized child result instead of waiting again.

## Durability model

Each execution has an append-only event history in Redis. A single lease owner advances the workflow by:

1. Loading history
2. Replaying the workflow function from the start
3. Resolving completed `step` / `sleep` calls from history (no side effects)
4. Running the next incomplete step **inline** under the same lease, or scheduling a durable timer, or completing / failing / cancelling

Side effects belong inside `step`. Workflow code outside `step` / `sleep` must be deterministic relative to history: no raw `Date.now()`, `Math.random()`, network, or unseeded nondeterminism.

Steps are **at-least-once**. `step` bodies must be idempotent; a crash mid-step may re-run the handler. Input, result, and step outputs are always JSON (`JSON.stringify` / `JSON.parse`). A step output or workflow result that cannot be serialized (a `BigInt`, a circular object) fails the run without retrying, and compensates the steps that already started.

## Multi-replica and automatic recovery

N Bun processes may register the same workflow `name` against the same Redis. Work is distributed via one sorted set of executions scored by when each next needs advancing, plus per-execution leases (`lockTTL`). A worker claims a due execution by taking its lease and pushing its score `lockTTL` ahead; the heartbeat keeps pushing it while the run is alive. When the run stops it leaves the score at the next thing it waits for: a `sleep`'s fire time or a retry's backoff. Sleeping executions cost nothing until they are due.

If a replica dies mid-run, its execution simply comes due again once `lockTTL` passes, and any replica (or the same process after restart) picks it up. If a run hits an internal error instead (for example a Redis failure), the replica hands the execution back to be retried after `retryBackoff.baseDelay` (at least `pollInterval`). There is no orphan scan, and you do not need to call `resume()` for crash recovery.

The heartbeat that keeps a lease alive runs on the same event loop as your steps. A step that blocks the event loop with synchronous work for longer than about 60% of `lockTTL` loses its lease, and another replica may start the same step while the first is still running. Keep steps async, or raise `lockTTL` for long synchronous work.

History and status writes are lease-fenced (Redis compare-and-append / compare-and-set against the lease token). Each state transition is a single Redis script, so history and status never disagree after a crash: a terminal event, its final status, leaving the due set, and retention are written together, as are `CompensationStarted` and status `compensating`. A writer that loses the lease cannot write; the new owner continues from history. While an execution is leased, the lease holder is the only writer of its history, so it loads history once per lease and keeps it in memory. Client paths do not take a lease: `start` creates meta, the first history event, and the due entry in one script; `resume` is one compare-and-set script on a failed execution; `cancel` sets a flag on meta (never history), which the lease holder sees on its next write. Losing a lease aborts the local forward `signal` so the handler can stop; another replica may still re-run the step once the execution comes due again (at-least-once).

`resume(executionId)` re-queues a **failed** execution in one atomic step: only while meta status is still `failed` and no unwind has started, it removes the retention TTL, appends a resume event (replay restarts failed steps at attempt 1), sets `pending`, and makes it due now. `pending` / `running` / `compensating` / `completed` / `cancelled` executions reject, as do failed executions that already started compensation. Concurrent `resume` calls on the same execution apply once; the others reject. A later failure needs a new resume event even if an older `WorkflowResumed` is already in history.

## Examples

### Start and inspect an execution

`start()` enqueues work and immediately returns `pending`. Pass a custom `executionId` when you want a stable key (non-empty, no `:`). Poll `get()` for the terminal result.

```typescript
const { executionId, status } = await onboard.start(
  { userId: "u_1" },
  { executionId: "onboard-u_1" },
);
// status: "pending"

let execution = await onboard.get(executionId);

while (
  execution.status === "pending" ||
  execution.status === "running" ||
  execution.status === "compensating"
) {
  await Bun.sleep(100);
  execution = await onboard.get(executionId);
}

console.log(execution.status, execution.result, execution.failure);
console.log(execution.steps);
// steps: { name, completedAt }[] - return values stay in history, not on get()
```

### Wait for a child workflow

`startSync(input, { executionId?, partitionKey?, timeoutMs?, cancelOnTimeout? })` starts the run and waits through `pending` / `running` / `compensating` until a final status. If `executionId` already exists, it attaches and waits instead of throwing `WorkflowStoreError`. Attach keeps the prior run's input and partition key; the new call's values are ignored.

On failure, `failure` is the original forward failure (not a later compensate failure). If a compensate handler also fails, `get().failure` holds the compensate failure instead. Cancel-triggered compensation that then fails surfaces the compensate failure (there was no forward failure).

```typescript
const parent = defineWorkflow<{ userId: string }, { ok: true }>({
  name: "parent",
  redis: redisClient,
  handler: async ({ input, step }) => {
    await step("onboard", async () => {
      const child = await onboard.startSync(
        { userId: input.userId },
        {
          executionId: `onboard-${input.userId}`,
          timeoutMs: 30_000,
          cancelOnTimeout: true,
        },
      );

      if (child.status !== "completed") {
        throw new Error(`onboard ${child.status}`);
      }

      return child.result;
    });

    return { ok: true };
  },
});
```

`timeoutMs` must be a non-negative finite number. It returns `{ status: "timeout", result: null, failure: null }`. With `cancelOnTimeout`, it calls `cancel()` first. Poll interval matches the workflow `pollInterval`.

### Cancel an execution

`cancel()` records the request; it does not abort a step that is running. The return value may still be `pending`, `running`, or `compensating`. Cancelling a `completed` / `failed` / `cancelled` or `compensating` execution changes nothing and returns its current status. Poll until status is `cancelled`, or `failed` if compensation itself exhausts retries.

```typescript
const requested = await onboard.cancel(executionId);
console.log(requested.status);

let execution = await onboard.get(executionId);

while (
  execution.status !== "cancelled" &&
  execution.status !== "failed"
) {
  await Bun.sleep(100);
  execution = await onboard.get(executionId);
}

console.log(execution.cancelledAt);
```

### Resume a failed execution

`resume()` re-queues a failed execution and returns `pending`. Completed steps stay cached and are not repeated. Non-failed statuses reject. If another caller resumes the run (and a worker finishes it) before this resume applies, resume rejects and leaves that status alone.

```typescript
const execution = await onboard.get(executionId);

if (execution.status === "failed") {
  const resumed = await onboard.resume(executionId);
  console.log(resumed.status); // "pending"
}
```

### List executions

`listWorkflows()` scans executions without requiring a registered workflow instance. Filter by workflow name, status, or both (scalars or arrays).

```typescript
const active = await listWorkflows(redisClient, {
  status: ["pending", "running", "compensating"],
});

const failed = await listWorkflows(redisClient, {
  name: "onboard-user",
  status: "failed",
});

for (const item of failed) {
  await onboard.resume(item.id);
}
```

Results are lightweight `WorkflowListItem` snapshots. Use instance `get()` for input, result, failure, and step details. Filter `name` with a string or string array; resume through the matching workflow instance.

### Compensate steps

Pass `compensate` on a step to undo its side effects when the execution fails for good or is cancelled. The undo is registered as soon as the step **starts**, so it runs for every step that started: completed, failed (including exhausted retries or `fail()`), or still in flight or backing off when cancel arrived. Steps that never started are not undone. Undos run newest first (LIFO), so a failing step's own undo runs before earlier steps' undos.

`compensate` gets `completed`: with `completed: true`, `result` is the step's result; with `completed: false`, `result` is `undefined` and the step may have had partial effects or none at all (its handler may not even have run). It also gets `failure`, the failure that started the unwind, or `null` when a cancel started it. Undos are at-least-once and must be idempotent.

```typescript
const onboard = defineWorkflow<{ userId: string }, { ok: true }>({
  name: "onboard-user",
  redis: redisClient,
  handler: async ({ input, step }) => {
    await step(
      "create-account",
      async () => createAccount(input.userId),
      {
        compensate: async ({ completed, result }) => {
          if (completed) {
            await deleteAccount(result.id);
            return;
          }

          // The step failed or was interrupted: undo whatever it managed.
          await deleteAccountIfExists(input.userId);
        },
      },
    );

    await step("send-email", async () => {
      await emailClient.send(input.userId);
    });

    return { ok: true };
  },
});
```

Status is `compensating` while unwind runs. Each undo is an ordinary durable step named `undo:<step name>`, with the same retry policy, backoff, `fail()` and `StepFailure` handling as forward steps. A successful unwind still ends as `failed` (original failure) or `cancelled`. If an undo stops retrying, the execution is `failed` with that undo's failure and the remaining undos do not run. If the replay diverges from history (nondeterminism, an unreadable step result, or the workflow function returning or throwing before every recorded step), the execution fails without running any undo. If `compensate` handlers disappear after `CompensationStarted` (for example a rolling deploy), including only some of them, the execution fails closed instead of finishing without undo. Unwind follows the `stepIds` snapshot on that event, so handlers added after start are not run.

`resume()` is rejected after compensation has started. Completed step results would be wrong after undo; start a new execution. Failed executions that never compensated can still be resumed.

### Fail with a code

Every failure is stored and exposed as a `WorkflowFailure` record, never as an `Error` instance, so it reads the same on `get()`, `startSync()`, hooks, and `compensate`:

```typescript
type WorkflowFailure<TCode extends string = string> = {
  code: TCode | BuiltinFailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: JsonValue;
  stack?: string;
  attempt?: number;
};
```

Call `fail({ code, message, retryable?, retryAfterMs?, details? })` inside a step to fail with your own code. `retryable` defaults to `false`. The step decides how long to keep retrying from its `attempt`; `retries` does not cap explicit failures, so a step that always returns `retryable: true` retries forever. `retryAfterMs` replaces the backoff delay before the next attempt (for example a `Retry-After` header).

```typescript
const failures = ["CardDeclined", "RateLimited"] as const;

const payment = defineWorkflow<{ orderId: string }, { charged: true }, typeof failures>({
  name: "charge-order",
  redis: redisClient,
  failures,
  hooks: {
    onError: ({ failure }) => {
      if (failure.code === "CardDeclined") {
        // ...
      }
    },
  },
  handler: async ({ input, step }) => {
    await step("charge", async ({ attempt, fail }) => {
      const response = await charge(input.orderId);

      if (response.status === 429) {
        return fail({
          code: "RateLimited",
          message: "payment provider rate limited",
          retryable: attempt < 10,
          retryAfterMs: response.retryAfterMs,
        });
      }

      if (response.declined) {
        return fail({ code: "CardDeclined", message: response.reason });
      }
    });

    return { charged: true };
  },
});
```

Code deep inside a step can `throw new StepFailure({ ... })` instead; it is stored the same way. Any other thrown error becomes `code: "Unknown"` with `retryable: true`, and stops after `retries`. The engine also produces `Nondeterminism` (replay diverged from history), `Serialization` (a value that is not JSON), and `CompensationMissing` (compensate handlers gone after an unwind started).

The engine fills in `attempt` on step failures and `stack` from the thrown error, cut to 4096 characters. A workflow failure carries `attempt` only when a step caused it; engine failures and throws from the workflow function itself (outside any step) have none. Hooks receive step failures as `WorkflowStepFailure`, where `attempt` is always set. `retryable` on a final failure is the failing attempt's own choice: an `Unknown` failure that ran out of `retries` stays `retryable: true`, which is a hint that `resume()` may succeed.

`code` must not be a builtin code, `details` must be JSON-serializable, and `retryAfterMs` must be a non-negative finite number. Otherwise the `StepFailure` constructor throws `InvalidStepFailureError`, which the step records as a non-retryable `Unknown` failure.

#### Declare failure codes

`failures` lists the codes a workflow's steps may fail with. It types `fail()` and every `failure.code` the workflow exposes (`get()`, `startSync()`, hooks, `compensate`) as one of those codes or a `BuiltinFailureCode`. At runtime, a `StepFailure` whose code is not in the list, whether from `fail()` or thrown directly, is stored as a non-retryable `Unknown` failure: its message names the code and keeps the original message, and its `retryAfterMs` and `details` are dropped. Without `failures`, any code except a builtin one is accepted and `code` is a `string`. Declaring a builtin code in `failures` throws `InvalidWorkflowOptionsError` at runtime as well.

The codes come from `failures` in one of two ways:

- **Explicit type arguments** (the usual case): hoist the list with `as const` and pass `typeof failures` as the third type argument and the list itself as `failures`, as in the example above. The value must match that type exactly, so the codes `fail()` accepts are the codes checked at runtime. Passing the list type without `failures`, or `failures` with only the input and result types, does not compile.
- **No type arguments**: the codes are inferred from `failures`, inline (no `as const` needed) or hoisted with `as const`. The input type is then `unknown`, so use this only when the workflow does not read `input`.

The list type must be a tuple: an array type such as `("CardDeclined" | "RateLimited")[]` does not say which codes the list holds, and does not compile. A list hoisted without `as const` is a `string[]`: any code type-checks and `code` is a `string`, but codes outside the list still fail at runtime. A builtin code in `failures` does not compile. `failures: []` declares no codes, so `fail()` accepts none and `code` is only ever a builtin code.

A `StepFailure` thrown directly is checked against the list only at runtime. Codes are checked when a failure is recorded, so an execution that failed before a code was removed from `failures` still returns that code from `get()`.

### Observe retries and completion

Hooks observe real lifecycle transitions. Hook errors do not fail the workflow.

```typescript
const sync = defineWorkflow<{ accountId: string }, { synced: true }>({
  name: "sync-account",
  redis: redisClient,
  retries: 2,
  hooks: {
    onRetry: ({ stepName, attempt, nextRetryDelayMs }) => {
      console.log(stepName, attempt, nextRetryDelayMs);
    },
    onComplete: ({ executionId, result }) => {
      console.log(executionId, result.synced);
    },
  },
  handler: async ({ input, step }) => {
    await step("sync", () => syncAccount(input.accountId));
    return { synced: true };
  },
});
```

### Limit concurrency by partition

Without `partitionBy`, `concurrency` is global. With `partitionBy`, it is per key. `partitionKey` on `start` overrides `partitionBy`; resume keeps the stored key.

```typescript
const deploy = defineWorkflow<{ envId: string }, void>({
  name: "deploy",
  redis: redisClient,
  concurrency: 3,
  partitionBy: (input) => input.envId,
  handler: async ({ input, step }) => {
    await step("apply", () => applyDeployment(input.envId));
  },
});

await deploy.start({ envId: "production" });
await deploy.start({ envId: "staging" }, { partitionKey: "shared" });
```

Different keys do not share the cap. Same-key executions are limited to `concurrency` across all replicas. Each process also runs at most `concurrency` handlers at a time, whatever the number of keys, so cross-key parallelism comes from running more replicas (or raising `concurrency`).

### Keep terminal history

`retentionTTL` controls how long completed / failed / cancelled executions stay in Redis. `retentionMax` caps how many terminal executions remain per workflow name.

```typescript
const audit = defineWorkflow<{ userId: string }, { ok: true }>({
  name: "audit-user",
  redis: redisClient,
  retentionTTL: 60_000,
  retentionMax: 100,
  handler: async ({ input, step }) => {
    await step("record", () => recordAudit(input.userId));
    return { ok: true };
  },
});
```

Pass `Infinity` to keep forever, or `0` to unlink immediately after terminal. Failed executions can be resumed only while their keys still exist.

### Graceful shutdown

`stop()` ends polling, waits for the runs in flight, and releases this process registration. Forward `signal` is aborted so handlers can exit; that abort does not write `WorkflowCancelled` or start compensation. Compensate `signal` is not aborted, so an undo step that is running finishes; the run then stops, and the rest of the unwind continues on whichever replica (or this process after a restart) picks the execution up next. Other replicas keep running the same workflow name; executions this process hands back are due again shortly.

```typescript
await onboard.stop();
```

## Reference

### Handler context

- `input`, `executionId`, `signal`
- `step(name, handler, options?)` - durable side effect; handler gets `{ input, signal, attempt, fail }`. `options.compensate` undoes a started step on failure or cancel; it gets `{ input, completed, result, failure, signal, attempt, fail }` (`result` only when `completed`, `failure` is `null` when a cancel started the unwind). Forward `signal` is aborted only by `stop()` or a lost lease. Compensate `signal` is never aborted, so cleanup can finish.
- `sleep(ms)` - durable timer (survives replay and restarts). It counts as fired once a lease holder sees its fire time pass and records `TimerFired`; it stays fired after that, even if replica clocks disagree.

`fail({ code, message, retryable?, retryAfterMs?, details? })` inside a step or `compensate` throws a `StepFailure`; `retryable` defaults to `false`. See [Fail with a code](#fail-with-a-code).

### Options

- **`name`** (required) - unique per process
- **`redis`** (required) - `Bun.RedisClient`
- **`handler`** (required)
- **`failures`** - codes steps may fail with; types `fail()` and `failure.code`, and turns any other code into a non-retryable `Unknown` failure (see [Declare failure codes](#declare-failure-codes))
- **`retries`** - retries of a step that throws an uncaught error (`Unknown`) before the workflow fails (default: 3; `0` = fail on first error). Failures from `fail()` / `StepFailure` decide with `retryable` instead.
- **`retryBackoff`** - `{ baseDelay, multiplier, maxDelay }` (defaults: 1000 / 2x / 30000)
- **`hooks`** - `onStart`, `onRetry`, `onError`, `onComplete`, `onCancel` (see [Hooks](#hooks))
- **`lockTTL`** - execution lease TTL in ms (default: 300000); also how long a crashed replica's execution waits before another replica picks it up, and the grace period on capacity slots. The lease and the slot are renewed every 40% of `lockTTL` while a step runs. When a run stops to wait (`sleep`, retry backoff) the slot is kept until the wait ends plus `lockTTL`, with no process refreshing it; whoever runs the execution next renews it. If every replica is gone, the slot frees itself `lockTTL` after the execution was due. Terminal executions free their slot in the same write that records the final status.
- **`retentionTTL`** - how long terminal executions (`completed` / `failed` / `cancelled`) stay in Redis, in ms (default: 86400000, 24h). `Infinity` keeps them forever. Any other value must be a non-negative number. `0` unlinks immediately after terminal. Pending, running, and compensating keys are never expired. Failed executions can be `resume`d only while they still exist. Retention is applied when the execution becomes terminal, using the replica's settings at that moment; changing `retentionTTL` later does not touch executions that are already terminal.
- **`retentionMax`** - optional cap on terminal executions per workflow name. Must be a positive integer. Oldest are `UNLINK`ed when the cap is exceeded. Works with or without a finite `retentionTTL`.
- **`concurrency`** - max running or waiting executions per capacity key across replicas (default: 1), and the number of handlers one process runs at a time. Without `partitionBy`, all executions share one pool (key `*`). With `partitionBy`, each key has its own pool of size `concurrency` (no global cap). Each replica admits against its own `concurrency`, so if replicas disagree the effective cap is the max.
- **`partitionBy`** - `(input) => string` for per-key concurrency across replicas. Empty keys throw. Cap applies for the whole execution, including durable waits. Replaces the global `concurrency` cap. The key `*` is reserved for the unpartitioned pool.
- **`pollInterval`** - idle poll backoff ms (default: 100)

`start(input, { executionId?, partitionKey? })` - `partitionKey` overrides `partitionBy`. Custom `executionId` must be non-empty and must not contain `:`. Empty `partitionKey` throws.

`startSync(input, { executionId?, partitionKey?, timeoutMs?, cancelOnTimeout? })` - same start options, then wait for a terminal status (or `timeout`). Existing `executionId` attaches instead of throwing (prior input/partition win). `timeoutMs` must be a non-negative finite number. Failure returns the `WorkflowFailure` on `failure`; does not throw.

Without `partitionBy`, `partitionKey` is stored on meta but capacity stays on the global `*` pool. Empty keys throw. The resolved key is stored on execution meta so `resume` keeps the original partition.

Failed steps retry with exponential backoff (or `retryAfterMs`) before the workflow is marked `failed`. For uncaught errors, default `retries: 3` means 4 total attempts and `retries: 0` fails on the first error. The same retry policy applies to `compensate` handlers, and `onRetry` / `onError` fire for them too with step name `undo:<name>`.

`cancel` is honored during retry backoff and `sleep`, not only between steps. A step that is running when `cancel()` is called keeps going, its outcome is recorded, and the cancel is honored at that write; the forward `signal` is not aborted by cancel. Started steps with `compensate` unwind before status becomes `cancelled`. After terminal failure, `resume(executionId)` re-queues the execution unless compensation already ran.

### Hooks

Optional lifecycle callbacks. Errors in hooks never fail the workflow. Hooks fire on real transitions, not every history replay.

- `onStart` - once when the execution first moves `pending` → `running`
- `onRetry` - before each step retry backoff (`failure`, `nextRetryDelayMs`, …), including undo steps (`stepName` is `undo:<name>`). `failure.attempt` is the attempt that failed.
- `onError` - a step stopped retrying, including undo steps (`undo:<name>`; may fire for both the forward step and an undo). `failure` is the last attempt's `WorkflowFailure` (branch on `failure.code`). `failureHistory` lists that step's failed attempts since the last resume as `{ failure, timestamp }`.
- `onComplete` - terminal success
- `onCancel` - terminal cancel

### Redis keys

Prefix: `workflow:`

| Key | Purpose |
|-----|---------|
| `workflow:{name}:history:{executionId}` | append-only event list, written by `start`, `resume`, and the lease holder |
| `workflow:{name}:meta:{executionId}` | status, result/failure, timestamps, and `cancelRequestedAt` (set by `cancel`, cleared by `resume`) |
| `workflow:{name}:lease:{executionId}` | owner token + TTL |
| `workflow:{name}:due` | sorted set of non-terminal execution ids, scored by when each next needs advancing (ms epoch) |
| `workflow:{name}:terminal` | zset of terminal execution ids when `retentionMax` is set |
| `workflow:{name}:capacity:{key}` | sorted set of execution ids holding a capacity slot, scored by slot expiry (ms epoch). Key `*` is the unpartitioned pool; `partitionBy` keys are per-key pools |

Terminal `meta` and `history` keys receive `PEXPIRE` from `retentionTTL` in the same script that records the terminal status (or are `UNLINK`ed there when `retentionTTL` is `0`). `retentionMax` trimming runs right after that terminal write. Leases and capacity slots keep using `lockTTL`. `listWorkflows` skips empty SCAN hits (expired tombstones).

### Notes

- Keep `step` / `sleep` call order and names stable across deploys; replay matches history by call sequence (`a0`, `a1`, …), and a renamed step at the same position is nondeterminism.
- Duplicate `defineWorkflow({ name })` in the same process throws `DuplicateWorkflowError`.
- Workers run embedded in your Bun process against Redis, not as a separate matching service.
- `get().steps` is `{ name, completedAt }[]` from completed history events (not a separate meta cache). Step return values are not exposed on `get()`.
- Successful step results are written to history even if cancel arrives mid-handler; the next advance then honors cancel.
- `compensate` runs for every started step (completed or not), newest first. Undos are at-least-once and must be idempotent and tolerate partial or no effects. `resume()` after compensation throws.

### Statuses

`pending` | `running` | `compensating` | `completed` | `failed` | `cancelled`
