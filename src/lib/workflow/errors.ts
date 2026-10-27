import { mightThrowSync } from "../errors/index.js";
import type { JsonValue, StepFailureInput } from "./types.js";

export class SerializationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SerializationError";
  }
}

export class NotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class DuplicateWorkflowError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DuplicateWorkflowError";
  }
}

export class WorkflowStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkflowStoreError";
  }
}

export class InvalidStepFailureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidStepFailureError";
  }
}

const isStorableDetails = (details: JsonValue | undefined) => {
  const [error] = mightThrowSync(() => JSON.stringify(details));

  return !error;
};

// Thrown by `fail()`, or directly from code deep inside a step. The engine
// stores it as a WorkflowFailure with this code instead of `Unknown`.
export class StepFailure extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;
  public readonly details?: JsonValue;

  public constructor(input: StepFailureInput) {
    super(input.message);
    this.name = "StepFailure";

    const { code, retryable, retryAfterMs, details } = input;

    if (retryAfterMs !== undefined) {
      if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
        throw new InvalidStepFailureError(
          "retryAfterMs must be a non-negative finite number",
        );
      }
    }

    if (!isStorableDetails(details)) {
      throw new InvalidStepFailureError("details must be JSON-serializable");
    }

    this.code = code;
    this.retryable = retryable ?? false;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

export class Paused extends Error {
  public constructor() {
    super("workflow paused");
    this.name = "Paused";
  }
}
