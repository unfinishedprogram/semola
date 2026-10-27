import { setTimeout as delay } from "node:timers/promises";
import { mightThrow, mightThrowSync } from "../errors/index.js";
import {
  InvalidStepFailureError,
  Paused,
  StepFailure,
  WorkflowStoreError,
} from "./errors.js";
import {
  applyHistoryEvent,
  emptyHistoryView,
  parseHistory,
  undoStepId,
} from "./history.js";
import { fromJson, toJson } from "./json.js";
import type { WorkflowStore } from "./store.js";
import type {
  AdvanceInput,
  BackoffDelayInput,
  BuiltinFailureCode,
  CancelExecutionInput,
  CollectFailureHistoryInput,
  CommitRetention,
  CommitTerminalInput,
  CompensationItem,
  CompleteExecutionInput,
  ExecuteStepInput,
  FailExecutionInput,
  FinishCompensationInput,
  HandleStepFailureInput,
  LeaseRun,
  NextStepTarget,
  Replay,
  RetryPolicy,
  RunCommitInput,
  StepCompensateHandler,
  StepFailureInput,
  StepHandler,
  StepState,
  TerminalDecision,
  WorkflowDecision,
  WorkflowFailure,
  WorkflowMeta,
  WorkflowOptions,
  WorkflowStepFailure,
  WorkflowStepFailureRecord,
} from "./types.js";

const DEFAULT_RETRIES = 3;
const DEFAULT_LOCK_TTL = 300_000;
const DEFAULT_RETENTION_TTL = 86_400_000;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_POLL_INTERVAL = 100;
const DEFAULT_RETRY_BASE = 1000;
const DEFAULT_RETRY_MULTIPLIER = 2;
const DEFAULT_RETRY_MAX = 30_000;
const HEARTBEAT_RATIO = 0.4;
const GLOBAL_CAPACITY_KEY = "*";
// Stacks are stored on every failed attempt, so long ones are cut.
const MAX_STACK_LENGTH = 4096;

const failWith = (input: StepFailureInput): never => {
  throw new StepFailure(input);
};

const builtinFailure = (code: BuiltinFailureCode, message: string) => ({
  code,
  message,
  retryable: false,
});

const isUndeclaredCode = (code: string, failures?: readonly string[]) => {
  if (!failures) return false;

  return !failures.includes(code);
};

// A StepFailure keeps its code and retry choice; any other error is
// `Unknown` and retryable. A malformed failure (bad `fail()` input or a code
// missing from `failures`) is `Unknown` and not retryable: it fails the same
// way on every attempt.
const toFailure = (error: Error, failures?: readonly string[]) => {
  const stack = error.stack?.slice(0, MAX_STACK_LENGTH);

  if (error instanceof InvalidStepFailureError) {
    return { ...builtinFailure("Unknown", error.message), stack };
  }

  if (error instanceof StepFailure) {
    if (isUndeclaredCode(error.code, failures)) {
      const message = `failure code "${error.code}" is not declared in failures: ${error.message}`;

      return { ...builtinFailure("Unknown", message), stack };
    }

    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      details: error.details,
      stack,
    };
  }

  return {
    code: "Unknown",
    message: error.message,
    retryable: true,
    stack,
  };
};

// Delay before the next attempt, or null once the step stops retrying.
// Explicit failures decide with `retryable` alone; `Unknown` also stops
// after `retries`.
const retryDelay = (failure: WorkflowStepFailure, policy: RetryPolicy) => {
  if (!failure.retryable) return null;

  if (failure.code === "Unknown") {
    if (failure.attempt > policy.retries) return null;
  }

  return failure.retryAfterMs ?? policy.backoff(failure.attempt);
};

const isTerminalStatus = (status: string) => {
  if (status === "completed") return true;
  if (status === "failed") return true;
  if (status === "cancelled") return true;

  return false;
};

const runHook = async (fn: (() => void | Promise<void>) | undefined) => {
  if (!fn) return;

  // Defer so sync throws become rejections that mightThrow can swallow.
  await mightThrow(Promise.resolve().then(() => fn()));
};

const backoffDelay = (input: BackoffDelayInput) => {
  const { attempt, base, multiplier, max } = input;

  return Math.min(base * multiplier ** (attempt - 1), max);
};

const invalidSleepDelay = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) {
    return new Error("sleep(ms) requires a non-negative finite number");
  }

  return null;
};

const stepNameMismatch = (
  stepId: string,
  expected: string | undefined,
  actual: string,
) => {
  if (expected === undefined) return null;
  if (expected === actual) return null;

  return new Error(
    `nondeterminism: step ${stepId} expected "${expected}", got "${actual}"`,
  );
};

const timerDelayMismatch = (
  timerId: string,
  expected: number | undefined,
  actual: number,
) => {
  if (expected === undefined) return null;
  if (expected === actual) return null;

  return new Error(
    `nondeterminism: timer ${timerId} expected delay ${expected}, got ${actual}`,
  );
};

const failDecision = (
  failure: WorkflowFailure,
  now: number,
): WorkflowDecision => ({
  type: "fail",
  failure,
  events: [{ type: "WorkflowFailed", failure, timestamp: now }],
});

// Next move for a step that has not completed: run it (first attempt, or the
// next one once the backoff has elapsed), wait out the backoff, or fail with
// its failure once it stops retrying. Forward and undo steps share this.
const nextStep = (
  state: StepState | undefined,
  step: NextStepTarget,
  policy: RetryPolicy,
  now: number,
): WorkflowDecision => {
  if (state?.status === "started") {
    return { type: "runStep", ...step, attempt: state.attempt };
  }

  let attempt = 1;

  if (state?.status === "failed") {
    const delay = retryDelay(state.failure, policy);

    if (delay === null) return failDecision(state.failure, now);

    const retryAt = state.failedAt + delay;

    if (now < retryAt) return { type: "waiting", until: retryAt };

    attempt = state.failure.attempt + 1;
  }

  return { type: "runStep", ...step, attempt };
};

// Replays the workflow function against history once: decides the next move
// and collects the undo handler of every started step, in start order.
const advance = async <TInput, TResult>(
  input: AdvanceInput<TInput, TResult>,
): Promise<Replay> => {
  const { options, view, executionId, retryPolicy } = input;
  const { cancelRequested, input: workflowInput } = input;
  const now = Date.now();
  const consumed = {
    steps: new Set<string>(),
    timers: new Set<string>(),
  };
  const undo: CompensationItem[] = [];

  let decision: WorkflowDecision | null = null;
  let fatal: WorkflowFailure | undefined;
  let stepSeq = 0;
  let timerSeq = 0;
  // A replay that diverges from history fails the run without an unwind:
  // undo handlers collected from it cannot be trusted.
  const diverged = (code: BuiltinFailureCode, error: Error): never => {
    fatal ??= builtinFailure(code, error.message);
    throw error;
  };

  const [handlerError, result] = await mightThrow(
    Promise.resolve().then(() =>
      options.handler({
        input: workflowInput,
        executionId,
        signal: input.signal,
        step: async (name, handler, stepOptions) => {
          const stepId = `a${stepSeq++}`;
          consumed.steps.add(stepId);

          const state = view.steps.get(stepId);
          const nameError = stepNameMismatch(stepId, state?.stepName, name);

          if (nameError) diverged("Nondeterminism", nameError);

          let outcome: CompensationItem["outcome"] = {
            completed: false,
            result: undefined,
          };

          if (state?.status === "completed") {
            const [parseError, parsed] = mightThrowSync(() =>
              fromJson(state.result, `step ${name}`),
            );

            if (parseError) diverged("Serialization", parseError);

            outcome = { completed: true, result: parsed };
          }

          // A started step's undo is queued whatever its outcome.
          if (stepOptions?.compensate && view.started.has(stepId)) {
            undo.push({
              stepId,
              stepName: name,
              compensate: stepOptions.compensate as StepCompensateHandler<
                unknown,
                unknown
              >,
              outcome,
            });
          }

          if (outcome.completed) return outcome.result as never;

          if (decision) {
            throw new Paused();
          }

          decision = nextStep(
            state,
            {
              stepId,
              stepName: name,
              handler: handler as StepHandler<unknown, unknown>,
            },
            retryPolicy,
            now,
          );
          throw new Paused();
        },
        sleep: async (ms) => {
          const delayError = invalidSleepDelay(ms);

          if (delayError) throw delayError;

          const timerId = `t${timerSeq++}`;
          consumed.timers.add(timerId);

          const state = view.timers.get(timerId);
          const delayMismatch = timerDelayMismatch(timerId, state?.delayMs, ms);

          if (delayMismatch) diverged("Nondeterminism", delayMismatch);

          if (state?.status === "fired") return;

          if (decision) {
            throw new Paused();
          }

          // The first lease holder past fireAt records TimerFired, so the
          // timer stays fired whatever later replicas' clocks say.
          if (state?.status === "started") {
            decision =
              now < state.fireAt
                ? { type: "waiting", until: state.fireAt }
                : {
                    type: "record",
                    events: [{ type: "TimerFired", timerId, timestamp: now }],
                  };
            throw new Paused();
          }

          decision = {
            type: "record",
            events: [
              {
                type: "TimerStarted",
                timerId,
                fireAt: now + ms,
                timestamp: now,
              },
            ],
          };

          throw new Paused();
        },
      }),
    ),
  );

  // Every recorded step and timer must be replayed; skipping one diverges.
  for (const stepId of view.steps.keys()) {
    if (consumed.steps.has(stepId)) continue;

    fatal ??= builtinFailure(
      "Nondeterminism",
      `nondeterminism: historical step ${stepId} was not replayed`,
    );
  }

  for (const timerId of view.timers.keys()) {
    if (consumed.timers.has(timerId)) continue;

    fatal ??= builtinFailure(
      "Nondeterminism",
      `nondeterminism: historical timer ${timerId} was not replayed`,
    );
  }

  if (fatal) {
    return {
      decision: failDecision(fatal, now),
      undo: [],
      fatal,
    };
  }

  // Only cancel() requests end the run. stop() aborts the signal to
  // interrupt handlers but must not write WorkflowCancelled.
  if (cancelRequested) {
    return {
      decision: {
        type: "cancel",
        events: [{ type: "WorkflowCancelled", timestamp: now }],
      },
      undo,
    };
  }

  // A recorded decision wins however the handler ended: user code may catch
  // Paused and return or rethrow something else, which must not complete or
  // fail the run before that step or sleep happens.
  if (decision) return { decision, undo };

  if (handlerError) {
    return {
      decision: failDecision(toFailure(handlerError, options.failures), now),
      undo,
    };
  }

  const [serializeError, serialized] = mightThrowSync(() =>
    toJson(result as TResult, "result"),
  );

  if (serializeError) {
    const failure = builtinFailure("Serialization", serializeError.message);

    return { decision: failDecision(failure, now), undo };
  }

  return {
    decision: {
      type: "complete",
      result: serialized,
      events: [
        {
          type: "WorkflowCompleted",
          result: serialized,
          timestamp: now,
        },
      ],
    },
    undo,
  };
};

export class WorkflowEngine<TInput, TResult> {
  private readonly stopping = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly options: WorkflowOptions<TInput, TResult>;
  private readonly store: WorkflowStore;
  private readonly retryPolicy: RetryPolicy;
  private readonly lockTTL: number;
  private readonly retentionTTL: number;
  private readonly retentionMax: number | undefined;
  private readonly concurrency: number;
  private readonly pollInterval: number;
  private readonly retryBaseDelay: number;
  private readonly retryMultiplier: number;
  private readonly retryMaxDelay: number;
  // Controllers of the runs in flight in this process, aborted by stop().
  private readonly running = new Set<AbortController>();

  public constructor(
    options: WorkflowOptions<TInput, TResult>,
    store: WorkflowStore,
  ) {
    this.options = options;
    this.store = store;
    this.retryPolicy = {
      retries: options.retries ?? DEFAULT_RETRIES,
      backoff: this.backoff,
    };
    this.lockTTL = options.lockTTL ?? DEFAULT_LOCK_TTL;
    this.retentionTTL = options.retentionTTL ?? DEFAULT_RETENTION_TTL;
    this.retentionMax = options.retentionMax;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

    if (!(this.retentionTTL >= 0)) {
      throw new WorkflowStoreError(
        "retentionTTL must be a non-negative number",
      );
    }

    if (this.retentionMax !== undefined) {
      if (!Number.isInteger(this.retentionMax)) {
        throw new WorkflowStoreError("retentionMax must be a positive integer");
      }

      if (this.retentionMax < 1) {
        throw new WorkflowStoreError("retentionMax must be a positive integer");
      }
    }

    this.pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    this.retryBaseDelay = options.retryBackoff?.baseDelay ?? DEFAULT_RETRY_BASE;
    this.retryMultiplier =
      options.retryBackoff?.multiplier ?? DEFAULT_RETRY_MULTIPLIER;
    this.retryMaxDelay = options.retryBackoff?.maxDelay ?? DEFAULT_RETRY_MAX;
  }

  public start() {
    for (let i = 0; i < this.concurrency; i++) {
      this.loops.push(this.workflowLoop());
    }
  }

  // Forward handlers are aborted; an undo step uses its own signal, so it
  // finishes before its run exits. Whoever claims the execution next
  // continues an interrupted unwind.
  public async stop() {
    this.stopping.abort();

    for (const controller of this.running) {
      controller.abort();
    }

    await Promise.all(this.loops);
  }

  private async workflowLoop() {
    while (!this.stopping.signal.aborted) {
      const token = crypto.randomUUID();
      const [error, executionId] = await mightThrow(
        this.store.claimDue(token, this.lockTTL),
      );

      if (error || !executionId) {
        // stop() cuts the idle wait short.
        await mightThrow(
          delay(this.pollInterval, undefined, { signal: this.stopping.signal }),
        );
        continue;
      }

      // stop() raced this claim: hand the execution straight back.
      if (this.stopping.signal.aborted) {
        await mightThrow(
          this.store.releaseLease({
            executionId,
            token,
            ttlMs: this.lockTTL,
            dueAt: Date.now(),
          }),
        );
        continue;
      }

      // Each of the `concurrency` pollers runs one execution at a time, so a
      // process never has more than `concurrency` handlers in flight.
      await mightThrow(this.runClaimed(executionId, token));
    }
  }

  private async runClaimed(executionId: string, token: string) {
    const run: LeaseRun<TInput> = {
      token,
      // Placeholder until runExecution parses meta; nothing reads it earlier.
      input: undefined as TInput,
      view: emptyHistoryView(),
      cancelRequested: false,
      controller: new AbortController(),
      lost: false,
    };

    this.running.add(run.controller);
    const heartbeat = this.startHeartbeat(executionId, run);
    const [error] = await mightThrow(this.runExecution(executionId, run));

    clearInterval(heartbeat);

    this.running.delete(run.controller);

    // Without a committed due time the execution is due again after one poll
    // interval (never a hot loop). After an error this worker is still alive,
    // so retry after a short delay instead of waiting out the visibility
    // timeout; if Redis itself is down the release fails and that timeout
    // remains the fallback.
    const retryAt =
      Date.now() + Math.max(this.retryBaseDelay, this.pollInterval);
    const dueAt = error
      ? retryAt
      : (run.dueAt ?? Date.now() + this.pollInterval);

    await this.store.releaseLease({
      executionId,
      token,
      ttlMs: this.lockTTL,
      capacityKey: run.capacityKey,
      dueAt,
    });
  }

  private capacityKey(partitionKey: string) {
    if (!this.options.partitionBy) return GLOBAL_CAPACITY_KEY;

    return partitionKey || GLOBAL_CAPACITY_KEY;
  }

  // Lease-holder write: commits, then applies the events to the in-memory
  // view and picks up a cancel request reported by the same script, so the
  // run never re-reads history while it holds the lease.
  private async commitRun(
    executionId: string,
    run: LeaseRun,
    input: RunCommitInput,
  ) {
    const result = await this.store.commit({
      executionId,
      leaseToken: run.token,
      capacityKey: run.capacityKey,
      ...input,
    });

    if (!result.committed) return false;

    for (const event of input.events ?? []) {
      applyHistoryEvent(run.view, event);
    }

    if (result.cancelRequested) run.cancelRequested = true;

    return true;
  }

  private backoff = (attempt: number) =>
    backoffDelay({
      attempt,
      base: this.retryBaseDelay,
      multiplier: this.retryMultiplier,
      max: this.retryMaxDelay,
    });

  // Commits the next due time; it stays in place when the lease is released.
  private async waitUntil(executionId: string, run: LeaseRun, until: number) {
    if (!(await this.commitRun(executionId, run, { dueAt: until }))) {
      return false;
    }

    run.dueAt = until;
    return true;
  }

  private async runExecution(executionId: string, run: LeaseRun<TInput>) {
    const meta = await this.store.getMeta(executionId);

    if (!meta) return;
    if (isTerminalStatus(meta.status)) return;

    run.capacityKey = this.capacityKey(meta.partitionKey);

    const admitted = await this.store.acquireCapacity(
      run.capacityKey,
      executionId,
      this.concurrency,
      this.lockTTL,
    );

    if (!admitted) {
      run.dueAt = Date.now() + this.pollInterval;
      return;
    }

    // The only history read for this lease; commitRun keeps it current.
    run.input = fromJson<TInput>(meta.input, "input");
    run.view = parseHistory(await this.store.loadHistory(executionId));
    run.cancelRequested = Boolean(meta.cancelRequestedAt);
    const { view } = run;

    if (meta.status === "pending") {
      const updated = await this.commitRun(executionId, run, {
        fields: { status: "running", updatedAt: String(Date.now()) },
      });

      if (!updated) return;

      if (view.events.length === 1) {
        await runHook(() =>
          this.options.hooks?.onStart?.({
            executionId,
            input: run.input,
          }),
        );
      }
    }

    // Every write below is fenced by the lease in COMMIT, so a lease lost
    // before the heartbeat notices still ends the run at its next commit.
    while (!this.stopping.signal.aborted) {
      if (run.lost) return;

      const replay = await advance({
        options: this.options,
        view,
        input: run.input,
        executionId,
        signal: run.controller.signal,
        retryPolicy: this.retryPolicy,
        cancelRequested: this.cancelPending(run),
      });

      if (view.compensation) {
        if (!(await this.unwind(executionId, run, replay))) return;

        continue;
      }

      const { decision } = replay;

      if (decision.type === "waiting") {
        if (!(await this.waitUntil(executionId, run, decision.until))) return;

        // A cancel reported by that commit is handled now, not at wake-up.
        if (!run.cancelRequested) return;

        // That commit overwrote the visibility timeout with `until`; restore
        // it, so a crash mid-unwind comes due after lockTTL, not at `until`.
        const visibleAt = Date.now() + this.lockTTL;

        if (!(await this.commitRun(executionId, run, { dueAt: visibleAt }))) {
          return;
        }

        run.dueAt = undefined;
        continue;
      }

      if (decision.type === "runStep") {
        if (!(await this.executeStep({ executionId, run, ...decision }))) {
          return;
        }

        continue;
      }

      if (decision.type === "record") {
        const { events } = decision;

        if (!(await this.commitRun(executionId, run, { events }))) return;

        continue;
      }

      if (decision.type === "complete") {
        await this.completeExecution({
          executionId,
          events: decision.events,
          result: decision.result,
          run,
        });
        return;
      }

      // Fail or cancel: undo the started steps first when any has a handler.
      if (await this.startUnwind(executionId, run, decision, replay.undo)) {
        continue;
      }

      if (decision.type === "fail") {
        await this.failExecution({
          executionId,
          events: decision.events,
          failure: decision.failure,
          run,
        });
        return;
      }

      await this.cancelExecution({
        executionId,
        events: decision.events,
        run,
      });
      return;
    }
  }

  // Cancel only interrupts the forward path; an unwind always runs to its end.
  private cancelPending(run: LeaseRun) {
    return run.cancelRequested && !run.view.compensation;
  }

  // The only writer of StepStarted: one event per attempt, written before
  // the handler runs.
  private async executeStep(input: ExecuteStepInput<TInput>) {
    const { executionId, stepId, stepName, attempt, handler, run } = input;
    const { signal } = run.controller;

    const started = await this.commitRun(executionId, run, {
      events: [
        {
          type: "StepStarted",
          stepId,
          stepName,
          attempt,
          timestamp: Date.now(),
        },
      ],
    });

    if (!started) return false;

    // A cancel reported by this write is honored before the handler runs.
    if (this.cancelPending(run)) return true;

    const [handlerError, value] = await mightThrow(
      Promise.resolve().then(() =>
        handler({
          input: run.input,
          signal,
          attempt,
          fail: failWith,
        }),
      ),
    );

    if (run.lost) return false;

    let failure: WorkflowFailure;

    if (handlerError) {
      failure = toFailure(handlerError, this.options.failures);
    } else {
      const [serializeError, serialized] = mightThrowSync(() =>
        toJson(value, `step ${stepName}`),
      );

      // Success is in history before a pending cancel is honored.
      if (!serializeError) {
        return this.commitRun(executionId, run, {
          events: [
            {
              type: "StepCompleted",
              stepId,
              stepName,
              result: serialized,
              timestamp: Date.now(),
            },
          ],
        });
      }

      failure = builtinFailure("Serialization", serializeError.message);
    }

    // Cancel and stop() interrupt forward steps only; an undo step records
    // its failure and retries like any step.
    if (!run.view.compensation) {
      if (run.cancelRequested) return true;

      if (signal.aborted) return false;
    }

    return this.handleStepFailure({
      executionId,
      stepId,
      stepName,
      attempt,
      failure,
      run,
    });
  }

  private async handleStepFailure(input: HandleStepFailureInput<TInput>) {
    const { executionId, stepId, stepName, attempt, run } = input;
    const failure = { ...input.failure, attempt };
    const now = Date.now();

    const failureHistory = this.collectFailureHistory({
      events: run.view.events,
      stepId,
      failure,
      timestamp: now,
    });

    const appended = await this.commitRun(executionId, run, {
      events: [
        {
          type: "StepFailed",
          stepId,
          stepName,
          failure,
          timestamp: now,
        },
      ],
    });

    if (!appended) return false;

    // A cancel that arrived during the step is reported by this commit.
    if (this.cancelPending(run)) return true;

    // Either way replay takes over: it waits out the backoff and runs the
    // next attempt, or turns the exhausted step into a failure (or the end
    // of an unwind).
    const delay = retryDelay(failure, this.retryPolicy);

    if (delay !== null) {
      await runHook(() =>
        this.options.hooks?.onRetry?.({
          executionId,
          input: run.input,
          stepName,
          failure,
          nextRetryDelayMs: delay,
        }),
      );

      return true;
    }

    await runHook(() =>
      this.options.hooks?.onError?.({
        executionId,
        input: run.input,
        stepName,
        failure,
        failureHistory,
      }),
    );

    return true;
  }

  // Records the unwind: status `compensating` plus the snapshot of started
  // steps to undo. False when nothing needs undoing or the lease is gone.
  private async startUnwind(
    executionId: string,
    run: LeaseRun,
    decision: TerminalDecision,
    undo: CompensationItem[],
  ) {
    if (undo.length === 0) return false;

    const failure = decision.type === "fail" ? decision.failure : null;
    const now = Date.now();
    const fields: Partial<WorkflowMeta> = {
      status: "compensating",
      updatedAt: String(now),
      unwoundAt: String(now),
    };

    // `failure` becomes the undo's failure if the unwind fails; startSync
    // reports the forward failure from `originalFailure`.
    if (failure) {
      const serialized = toJson(failure, "failure");

      fields.failure = serialized;
      fields.originalFailure = serialized;
    }

    return this.commitRun(executionId, run, {
      events: [
        {
          type: "CompensationStarted",
          failure,
          stepIds: undo.map((item) => item.stepId),
          timestamp: now,
        },
      ],
      fields,
    });
  }

  // Runs the undo of each snapshotted step newest first, as ordinary steps
  // (see undoStepId) with their own retries, then ends the run. Fails
  // closed when a snapshotted handler is gone (for example after a deploy).
  private async unwind(
    executionId: string,
    run: LeaseRun<TInput>,
    replay: Replay,
  ) {
    const { view } = run;
    const phase = view.compensation;

    if (!phase) return false;

    const handlers = new Map(replay.undo.map((item) => [item.stepId, item]));
    const pending = phase.stepIds
      .filter((id) => view.undos.get(id)?.status !== "completed")
      .reverse();
    let failure = replay.fatal;

    if (!failure && pending.some((id) => !handlers.has(id))) {
      failure = builtinFailure(
        "CompensationMissing",
        "compensation handlers missing after CompensationStarted",
      );
    }

    const item = handlers.get(pending[0] ?? "");

    if (!failure && item) {
      const signal = new AbortController().signal;
      const next = nextStep(
        view.undos.get(item.stepId),
        {
          stepId: undoStepId(item.stepId),
          stepName: `undo:${item.stepName}`,
          handler: ({ input, attempt, fail }) =>
            item.compensate({
              input,
              attempt,
              fail,
              signal,
              failure: phase.failure,
              ...item.outcome,
            }),
        },
        this.retryPolicy,
        Date.now(),
      );

      if (next.type === "waiting") {
        await this.waitUntil(executionId, run, next.until);
        return false;
      }

      if (next.type === "runStep") {
        return this.executeStep({ executionId, run, ...next });
      }

      if (next.type === "fail") failure = next.failure;
    }

    await this.finishCompensation({
      executionId,
      failure: failure ?? phase.failure,
      run,
    });

    return false;
  }

  private async finishCompensation(input: FinishCompensationInput<TInput>) {
    const { executionId, failure, run } = input;

    if (!failure) {
      await this.cancelExecution({
        executionId,
        events: [{ type: "WorkflowCancelled", timestamp: Date.now() }],
        run,
      });
      return;
    }

    await this.failExecution({
      executionId,
      events: [
        {
          type: "WorkflowFailed",
          failure,
          timestamp: Date.now(),
        },
      ],
      failure,
      run,
    });
  }

  private collectFailureHistory(input: CollectFailureHistoryInput) {
    const { events, stepId, failure, timestamp } = input;
    const history: WorkflowStepFailureRecord[] = [];
    let afterResume = 0;

    for (let i = 0; i < events.length; i++) {
      if (events[i]?.type !== "WorkflowResumed") continue;

      afterResume = i + 1;
    }

    for (let i = afterResume; i < events.length; i++) {
      const event = events[i];

      if (!event) continue;
      if (event.type !== "StepFailed") continue;
      if (event.stepId !== stepId) continue;

      history.push({ failure: event.failure, timestamp: event.timestamp });
    }

    const last = history[history.length - 1];

    if (!last) {
      history.push({ failure, timestamp });
      return history;
    }

    if (last.failure.attempt !== failure.attempt) {
      history.push({ failure, timestamp });
    }

    return history;
  }

  private startHeartbeat(executionId: string, run: LeaseRun) {
    const interval = Math.max(50, Math.floor(this.lockTTL * HEARTBEAT_RATIO));

    return setInterval(() => {
      void (async () => {
        const [error, ok] = await mightThrow(
          this.store.extendLease({
            executionId,
            token: run.token,
            ttlMs: this.lockTTL,
            capacityKey: run.capacityKey,
          }),
        );

        if (error || !ok) {
          run.lost = true;
          run.controller.abort();
        }
      })();
    }, interval);
  }

  private retention(endedAt: number) {
    const retention: CommitRetention = {};

    if (Number.isFinite(this.retentionTTL)) {
      retention.ttlMs = this.retentionTTL;
    }

    if (this.retentionMax !== undefined) {
      if (retention.ttlMs !== 0) {
        retention.trackedAt = endedAt;
      }
    }

    return retention;
  }

  // One lease-fenced script appends the terminal event, writes terminal meta,
  // leaves the due set, frees the capacity slot and applies retention.
  private async commitTerminal(input: CommitTerminalInput) {
    const { executionId, events, fields, endedAt, run } = input;

    return this.commitRun(executionId, run, {
      events,
      fields: { ...fields, updatedAt: String(endedAt) },
      retention: this.retention(endedAt),
    });
  }

  // retentionMax trimming stays a follow-up call: it is idempotent, and a
  // crash before it only leaves extra terminal rows until the next terminal
  // commit trims them.
  private async trimRetained() {
    if (this.retentionMax === undefined) return;

    await this.store.trimTerminal(this.retentionMax);
  }

  private async completeExecution(input: CompleteExecutionInput<TInput>) {
    const { executionId, events, result, run } = input;
    const now = Date.now();

    const committed = await this.commitTerminal({
      executionId,
      events,
      fields: {
        status: "completed",
        result,
        completedAt: String(now),
        failure: "",
      },
      endedAt: now,
      run,
    });

    if (!committed) return;

    await runHook(() =>
      this.options.hooks?.onComplete?.({
        executionId,
        input: run.input,
        result: fromJson<TResult>(result, "result"),
      }),
    );

    await this.trimRetained();
  }

  private async failExecution(input: FailExecutionInput) {
    const { executionId, events, failure, run } = input;
    const now = Date.now();

    const committed = await this.commitTerminal({
      executionId,
      events,
      fields: {
        status: "failed",
        failure: toJson(failure, "failure"),
        failedAt: String(now),
      },
      endedAt: now,
      run,
    });

    if (!committed) return;

    await this.trimRetained();
  }

  private async cancelExecution(input: CancelExecutionInput<TInput>) {
    const { executionId, events, run } = input;
    const now = Date.now();

    const committed = await this.commitTerminal({
      executionId,
      events,
      fields: {
        status: "cancelled",
        cancelledAt: String(now),
        failure: "",
      },
      endedAt: now,
      run,
    });

    if (!committed) return;

    await runHook(() =>
      this.options.hooks?.onCancel?.({
        executionId,
        input: run.input,
      }),
    );

    await this.trimRetained();
  }
}
