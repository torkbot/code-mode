import type { RunOutcome } from "./runtime.ts";

/** JSON-serializable error shape used by outcomes and telemetry. */
export interface TelemetryError {
  /** Error class or supplied `name` value. */
  readonly name: string;
  /** Human-readable failure message. */
  readonly message: string;
  /** Stack text when it could be read safely. */
  readonly stack: string | null;
  /** Structured details for error kinds understood by the client. */
  readonly details: ErrorDetails | null;
}

/** Maximum serialized error-name length. */
export const maximumTelemetryErrorNameLength = 256;
/** Maximum serialized error-message length. */
export const maximumTelemetryErrorMessageLength = 64 * 1024;
/** Maximum serialized stack length. */
export const maximumTelemetryErrorStackLength = 128 * 1024;
/** Maximum serialized structured report length. */
export const maximumTelemetryErrorReportLength = 8 * 1024;

/** Structured, agent-readable context attached to known failures. */
export type ErrorDetails =
  | {
      /** A host tool rejected its input or output schema. */
      readonly kind: "tool-validation";
      /** Bounded validation report including an agent-source excerpt. */
      readonly report: string;
    };

/** Live observations emitted while Client.run() executes a program. */
export type TelemetryEvent =
  | {
      /** The scope-only program console emitted text. */
      readonly kind: "program-output";
      /** Logical destination selected by the console method. */
      readonly stream: "stdout" | "stderr";
      /** Runtime-formatted output text. */
      readonly text: string;
    }
  | {
      /** A validated host tool call is about to begin. */
      readonly kind: "tool-call-started";
      /** Client-local opaque identifier for correlating tool events. */
      readonly toolCallId: string;
      /** Registered toolbox name. */
      readonly toolName: string;
      /** Untransformed value received from the program. */
      readonly input: unknown;
    }
  | {
      /** A host tool call completed and its output passed validation. */
      readonly kind: "tool-call-completed";
      /** Client-local opaque identifier matching the start event. */
      readonly toolCallId: string;
      /** Registered toolbox name. */
      readonly toolName: string;
      /** Transformed output returned to the program. */
      readonly output: unknown;
    }
  | {
      /** A host tool call or its schema validation failed. */
      readonly kind: "tool-call-failed";
      /** Client-local opaque identifier matching the start event. */
      readonly toolCallId: string;
      /** Registered toolbox name. */
      readonly toolName: string;
      /** Untransformed value received from the program. */
      readonly input: unknown;
      /** Serializable tool failure. */
      readonly error: TelemetryError;
    }
  | {
      /** Program evaluation reached a success or program-failed outcome. */
      readonly kind: "execution-completed";
      /** Cloned result also returned by Client.run(). */
      readonly outcome: RunOutcome;
    }
  | {
      /** Runtime transport, cancellation, or client infrastructure rejected. */
      readonly kind: "execution-failed";
      /** Serializable representation of the rejected error. */
      readonly error: TelemetryError;
    };

/** Non-blocking observer for one telemetry event. Rejections are ignored. */
export type TelemetryCallback = (event: TelemetryEvent) => void | Promise<void>;

/** Wrap an optional callback so observability cannot alter execution semantics. */
export function createTelemetryEmitter(
  callback: TelemetryCallback | undefined,
): (event: TelemetryEvent) => void {
  return (event) => {
    if (callback === undefined) {
      return;
    }

    try {
      void Promise.resolve(callback(event)).catch(() => {});
    } catch {
      // Observability must not alter execution semantics.
    }
  };
}

/** Convert an arbitrary thrown value into a bounded serializable error. */
export function errorFromUnknown(
  error: unknown,
): TelemetryError {
  if (isError(error)) {
    const stack = readErrorString(error, "stack", null);
    return {
      name: truncateTelemetryErrorField(
        readErrorString(error, "name", "Error") ?? "Error",
        maximumTelemetryErrorNameLength,
      ),
      message: truncateTelemetryErrorField(
        readErrorString(
          error,
          "message",
          "Code-mode error message could not be read",
        ) ?? "Code-mode error message could not be read",
        maximumTelemetryErrorMessageLength,
      ),
      stack: stack === null
        ? null
        : truncateTelemetryErrorField(
          stack,
          maximumTelemetryErrorStackLength,
        ),
      details: readErrorDetails(error),
    };
  }

  return {
    name: "Error",
    message: truncateTelemetryErrorField(
      stringifyUnknownError(error),
      maximumTelemetryErrorMessageLength,
    ),
    stack: null,
    details: null,
  };
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function readErrorDetails(error: Error): ErrorDetails | null {
  let details: unknown;
  try {
    details = (error as { readonly details?: unknown }).details;
  } catch {
    return null;
  }

  if (typeof details !== "object" || details === null) {
    return null;
  }

  try {
    if (
      !("kind" in details)
      || details.kind !== "tool-validation"
      || !("report" in details)
      || typeof details.report !== "string"
    ) {
      return null;
    }

    return {
      kind: "tool-validation",
      report: truncateTelemetryErrorField(
        details.report,
        maximumTelemetryErrorReportLength,
      ),
    };
  } catch {
    return null;
  }
}

function readErrorString(
  error: Error,
  property: "name" | "message" | "stack",
  fallback: string | null,
): string | null {
  try {
    const value = error[property];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function stringifyUnknownError(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "Code-mode thrown value could not be serialized";
  }
}

function truncateTelemetryErrorField(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }

  const suffix = "... <truncated>";
  return `${value.slice(0, maximumLength - suffix.length)}${suffix}`;
}
