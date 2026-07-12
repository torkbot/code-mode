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
  validate(source: string, signal: AbortSignal): Promise<ValidationResult>;
  run(source: string, options: RunOptions): Promise<RunOutcome>;
}

export interface RunOptions {
  readonly signal: AbortSignal;
  readonly onTelemetry?: TelemetryCallback;
}

export type ValidationResult =
  | { readonly kind: "valid" }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly TypecheckDiagnostic[];
      readonly report: string;
    };

export function createClient(req: CreateClientRequest): Client {
  const tools = getToolboxTools(req.toolbox);
  assertEnvironment(req.environment);

  return {
    async validate(
      source: string,
      signal: AbortSignal,
    ): Promise<ValidationResult> {
      const typecheckFailure = await validateAgentSource({
        source,
        typeDefinitions: req.toolbox.typeDefinitions,
        typeDefinitionFiles: req.environment.typeDefinitionFiles,
        signal,
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
    run(source: string, options: RunOptions): Promise<RunOutcome> {
      const emitTelemetry = createTelemetryEmitter(options.onTelemetry);
      return execute({
        runtime: req.runtime,
        signal: options.signal,
        agentSource: source,
        tools,
        emitTelemetry,
      });
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
