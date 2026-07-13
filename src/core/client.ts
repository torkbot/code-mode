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

  return {
    async validate(
      source: string,
      signal: AbortSignal,
    ): Promise<ValidationResult> {
      signal.throwIfAborted();
      const typeDefinitionFiles = await req.runtime.loadTypeDefinitionFiles();
      signal.throwIfAborted();
      const typecheckFailure = await validateAgentSource({
        source,
        typeDefinitions: req.toolbox.typeDefinitions,
        typeDefinitionFiles,
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
