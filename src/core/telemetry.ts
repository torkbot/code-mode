import type { RunOutcome } from "./execution.ts";

export interface TelemetryError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly details: ErrorDetails | null;
}

export const maximumTelemetryErrorNameLength = 256;
export const maximumTelemetryErrorMessageLength = 64 * 1024;
export const maximumTelemetryErrorStackLength = 128 * 1024;
export const maximumTelemetryErrorReportLength = 8 * 1024;

export type ErrorDetails =
  | {
      readonly kind: "tool-validation";
      readonly report: string;
    };

export type ProgramLogLevel = "debug" | "info" | "log" | "warn" | "error";

export type TelemetryEvent =
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
  | {
      readonly kind: "execution-completed";
      readonly outcome: RunOutcome;
    }
  | {
      readonly kind: "execution-failed";
      readonly error: TelemetryError;
    };

export type TelemetryCallback = (event: TelemetryEvent) => void;

export function createTelemetryEmitter(
  callback: TelemetryCallback | undefined,
): (event: TelemetryEvent) => void {
  return (event) => {
    if (callback === undefined) {
      return;
    }

    try {
      callback(event);
    } catch {
      // Observability must not alter execution semantics.
    }
  };
}

export function errorFromUnknown(
  error: unknown,
): TelemetryError {
  if (error instanceof Error) {
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
