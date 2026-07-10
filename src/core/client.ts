import type { CodeModeEnvironment } from "./environment.ts";
import type { Runtime } from "./runtime.ts";
import type { RunOutcome } from "./execution.ts";
import { execute } from "./execution.ts";
import type { TelemetryCallback } from "./telemetry.ts";
import { createTelemetryEmitter } from "./telemetry.ts";
import type { Toolbox } from "./types.ts";
import { getToolboxTools } from "./types.ts";
import type { TypecheckDiagnostic } from "./validation/index.ts";
import { validateAgentSource } from "./validation/index.ts";

export interface CreateClientRequest {
  readonly runtime: Runtime;
  readonly toolbox: Toolbox;
  readonly environment: CodeModeEnvironment;
}

export interface Client {
  validate(source: string, options?: ValidateOptions): Promise<ValidationResult>;
  run(source: string, options?: RunOptions): ClientExecution;
}

export interface ValidateOptions {
  readonly signal?: AbortSignal;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly onTelemetry?: TelemetryCallback;
}

export type ValidationResult =
  | { readonly kind: "valid" }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly TypecheckDiagnostic[];
      readonly report: string;
    };

export interface ClientExecution {
  readonly id: string;
  readonly result: Promise<RunOutcome>;
}

export function createClient(req: CreateClientRequest): Client {
  const tools = getToolboxTools(req.toolbox);
  assertEnvironment(req.environment);

  return {
    async validate(
      source: string,
      options: ValidateOptions = {},
    ): Promise<ValidationResult> {
      const typecheckFailure = await validateAgentSource({
        source,
        typeDefinitions: req.toolbox.typeDefinitions,
        typeDefinitionFiles: req.environment.typeDefinitionFiles,
        signal: options.signal ?? neverAbortedSignal,
      });

      if (typecheckFailure === undefined) {
        return { kind: "valid" };
      }

      return {
        kind: "invalid",
        diagnostics: typecheckFailure.diagnostics,
        report: typecheckFailure.report,
      };
    },
    run(source: string, options: RunOptions = {}): ClientExecution {
      const id = createExecutionId();
      const telemetry = createTelemetryEmitter(id, options.onTelemetry);
      const result = execute({
        executionId: id,
        runtime: req.runtime,
        signal: options.signal ?? neverAbortedSignal,
        agentSource: source,
        tools,
        emitTelemetry(event) {
          telemetry.emit(event);
        },
      }).then((executionResult) => executionResult.outcome);

      return {
        id,
        result,
      };
    },
  };
}

function assertEnvironment(environment: CodeModeEnvironment): void {
  if (
    environment === null
    || typeof environment !== "object"
    || typeof environment.description !== "string"
    || environment.description.trim() === ""
  ) {
    throw new Error("Code-mode environment description must be a non-empty string");
  }
  if (!Array.isArray(environment.typeDefinitionFiles)) {
    throw new Error("Code-mode environment typeDefinitionFiles must be an array");
  }
}

const neverAbortedSignal = new AbortController().signal;

function createExecutionId(): string {
  return `exec_${globalThis.crypto.randomUUID()}`;
}
