import type { Runtime, TypeDefinitionFile } from "./runtime.ts";
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
      const typeDefinitionFiles = await loadRuntimeTypeDefinitionFiles(
        req.runtime,
        signal,
      );
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

function loadRuntimeTypeDefinitionFiles(
  runtime: Runtime,
  signal: AbortSignal,
): Promise<readonly TypeDefinitionFile[]> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }

    let loading: Promise<readonly TypeDefinitionFile[]>;
    try {
      loading = runtime.loadTypeDefinitionFiles(signal);
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }

    void loading.then(
      (files) => {
        cleanup();
        resolve(files);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
