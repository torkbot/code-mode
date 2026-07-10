import type { RunOutcome } from "./execution.ts";

export interface TelemetryEventBase {
  readonly executionId: string;
  readonly sequence: number;
  readonly timestamp: string;
}

export interface TelemetryError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly details: ErrorDetails | null;
}

export type ErrorDetails =
  | {
      readonly kind: "tool-validation";
      readonly report: string;
    };

export type ProgramLogLevel = "debug" | "info" | "log" | "warn" | "error";

export type TelemetryEvent =
  | (TelemetryEventBase & {
      readonly kind: "execution-started";
    })
  | (TelemetryEventBase & {
      readonly kind: "runtime-started";
    })
  | (TelemetryEventBase & {
      readonly kind: "program-started";
    })
  | (TelemetryEventBase & {
      readonly kind: "program-log";
      readonly level: ProgramLogLevel;
      readonly message: string;
      readonly values: readonly unknown[];
    })
  | (TelemetryEventBase & {
      readonly kind: "tool-call-started";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    })
  | (TelemetryEventBase & {
      readonly kind: "tool-call-completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: unknown;
    })
  | (TelemetryEventBase & {
      readonly kind: "tool-call-failed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly error: TelemetryError;
    })
  | (TelemetryEventBase & {
      readonly kind: "runtime-finished";
      readonly status: "closed";
    })
  | (TelemetryEventBase & {
      readonly kind: "runtime-finished";
      readonly status: "failed";
      readonly error: TelemetryError;
    })
  | (TelemetryEventBase & {
      readonly kind: "execution-completed";
      readonly outcome: RunOutcome;
    })
  | (TelemetryEventBase & {
      readonly kind: "execution-failed";
      readonly error: TelemetryError;
});

export type TelemetryCallback = (event: TelemetryEvent) => void;

export type TelemetryEventInput =
  | { readonly kind: "execution-started" }
  | { readonly kind: "runtime-started" }
  | { readonly kind: "program-started" }
  | {
      readonly kind: "program-log";
      readonly level: ProgramLogLevel;
      readonly message: string;
      readonly values: readonly unknown[];
    }
  | {
      readonly kind: "tool-call-started";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool-call-completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: unknown;
    }
  | {
      readonly kind: "tool-call-failed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly error: TelemetryError;
    }
  | { readonly kind: "runtime-finished"; readonly status: "closed" }
  | {
      readonly kind: "runtime-finished";
      readonly status: "failed";
      readonly error: TelemetryError;
    }
  | { readonly kind: "execution-completed"; readonly outcome: RunOutcome }
  | { readonly kind: "execution-failed"; readonly error: TelemetryError };

export interface TelemetryEmitter {
  emit(event: TelemetryEventInput): void;
}

export function createTelemetryEmitter(
  executionId: string,
  callback: TelemetryCallback | undefined,
): TelemetryEmitter {
  return new CallbackTelemetryEmitter(executionId, callback);
}

export function errorFromUnknown(
  error: unknown,
): TelemetryError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      details: isErrorWithDetails(error) ? error.details : null,
    };
  }

  return {
    name: "Error",
    message: String(error),
    stack: null,
    details: null,
  };
}

function isErrorWithDetails(error: Error): error is Error & {
  readonly details: ErrorDetails;
} {
  return "details" in error
    && typeof (error as { readonly details?: unknown }).details === "object"
    && (error as { readonly details?: unknown }).details !== null;
}

class CallbackTelemetryEmitter implements TelemetryEmitter {
  readonly #executionId: string;
  readonly #callback: TelemetryCallback | undefined;
  #sequence = 0;

  constructor(
    executionId: string,
    callback: TelemetryCallback | undefined,
  ) {
    this.#executionId = executionId;
    this.#callback = callback;
  }

  emit(input: TelemetryEventInput): void {
    const callback = this.#callback;
    const event = {
      executionId: this.#executionId,
      sequence: this.#sequence++,
      timestamp: new Date().toISOString(),
      ...input,
    } as TelemetryEvent;

    if (callback === undefined) {
      return;
    }

    try {
      callback(event);
    } catch {
      // Observability must not alter execution semantics.
    }
  }
}
