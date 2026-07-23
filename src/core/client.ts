import { settleBeforeAbort } from "./abort.ts";
import { assertJsonValue } from "./json.ts";
import type {
  RunOutcome,
  Runtime,
  RuntimeToolCall,
} from "./runtime.ts";
import type { TelemetryCallback, TelemetryEvent } from "./telemetry.ts";
import { createTelemetryEmitter, errorFromUnknown } from "./telemetry.ts";
import { transpileAgentSource } from "./transpile.ts";
import type {
  ExecutableToolDefinition,
  ExecutableToolDefinitions,
  Toolbox,
} from "./types.ts";
import { getToolboxTools } from "./types.ts";
import type { TypecheckDiagnostic } from "./validation/index.ts";
import { validateAgentSource } from "./validation/index.ts";

/** Dependencies used to create one code-mode Client. */
export interface CreateClientRequest {
  /** Connected execution runtime shared by this Client. */
  readonly runtime: Runtime;
  /** Tool declarations, schemas, and host handlers exposed to programs. */
  readonly toolbox: Toolbox;
}

/** Checks and executes agent-authored TypeScript ESM programs. */
export interface Client {
  /** Type-check source without evaluating it or invoking tools. */
  validate(source: string, signal: AbortSignal): Promise<ValidationResult>;
  /** Strip erasable TypeScript and execute source without an implicit type-check. */
  run(source: string, options: RunOptions): Promise<RunOutcome>;
}

/** Per-execution controls and observability. */
export interface RunOptions {
  /** Cancels this execution and its active tool handlers. */
  readonly signal: AbortSignal;
  /** Receives live output, tool, completion, and infrastructure events. */
  readonly onTelemetry?: TelemetryCallback;
}

/** Result of checking an agent program against toolbox and runtime declarations. */
export type ValidationResult =
  | {
      /** The source has no reported TypeScript diagnostics. */
      readonly kind: "valid";
    }
  | {
      /** The source has one or more reported TypeScript diagnostics. */
      readonly kind: "invalid";
      /** Bounded, JSON-serializable diagnostics with source coordinates. */
      readonly diagnostics: readonly TypecheckDiagnostic[];
      /** Bounded text report intended for an agent to consume and repair. */
      readonly report: string;
    };

/**
 * Create a Client over an existing Runtime and Toolbox.
 *
 * @param req Connected runtime and tool collection owned by the embedder.
 * @returns A client that validates and executes agent ESM source.
 */
export function createClient(req: CreateClientRequest): Client {
  const tools = getToolboxTools(req.toolbox);

  return {
    async validate(source, signal) {
      signal.throwIfAborted();
      const typeDefinitionFiles = await settleBeforeAbort(
        req.runtime.loadTypeDefinitionFiles(signal),
        signal,
      );
      const typecheckFailure = await validateAgentSource({
        source,
        typeDefinitions: req.toolbox.typeDefinitions,
        typeDefinitionFiles,
        signal,
      });

      if (typecheckFailure === undefined) return { kind: "valid" };
      return {
        kind: "invalid",
        diagnostics: typecheckFailure.diagnostics,
        report: typecheckFailure.report,
      };
    },

    async run(source, options) {
      const emitTelemetry = createTelemetryEmitter(options.onTelemetry);

      try {
        options.signal.throwIfAborted();
        const transpilation = transpileAgentSource(source);
        let outcome: RunOutcome;

        if (transpilation.kind === "invalid") {
          const error = new SyntaxError(transpilation.report);
          error.name = "SyntaxError";
          outcome = {
            kind: "program-failed",
            error: errorFromUnknown(error),
          };
        } else {
          outcome = await runProgram({
            runtime: req.runtime,
            source,
            javascript: transpilation.source,
            tools,
            signal: options.signal,
            emitTelemetry,
          });
        }

        emitTelemetry({
          kind: "execution-completed",
          outcome: structuredClone(outcome),
        });
        return outcome;
      } catch (error) {
        emitTelemetry({
          kind: "execution-failed",
          error: errorFromUnknown(error),
        });
        throw error;
      }
    },
  };
}

async function runProgram(req: {
  readonly runtime: Runtime;
  readonly source: string;
  readonly javascript: string;
  readonly tools: ExecutableToolDefinitions;
  readonly signal: AbortSignal;
  emitTelemetry(event: TelemetryEvent): void;
}): Promise<RunOutcome> {
  let nextToolCallId = 0;

  return req.runtime.execute({
    source: req.javascript,
    signal: req.signal,
    emitOutput(output) {
      req.emitTelemetry({
        kind: "program-output",
        stream: output.stream,
        text: output.text,
      });
    },
    async invokeTool(call) {
      const toolCallId = String(nextToolCallId++);
      req.emitTelemetry({
        kind: "tool-call-started",
        toolCallId,
        toolName: call.name,
        input: structuredClone(call.input),
      });

      try {
        const output = await invokeTool(req, call);
        assertJsonValue(output);
        req.emitTelemetry({
          kind: "tool-call-completed",
          toolCallId,
          toolName: call.name,
          output: structuredClone(output),
        });
        return output;
      } catch (error) {
        req.emitTelemetry({
          kind: "tool-call-failed",
          toolCallId,
          toolName: call.name,
          input: structuredClone(call.input),
          error: errorFromUnknown(error),
        });
        throw error;
      }
    },
  });
}

async function invokeTool(
  req: {
    readonly source: string;
    readonly tools: ExecutableToolDefinitions;
  },
  call: RuntimeToolCall,
): Promise<unknown> {
  const tool = req.tools[call.name];
  if (tool === undefined) {
    throw new Error(`No code-mode tool is registered for ${call.name}`);
  }

  const input = await validateToolValue({
    phase: "input",
    tool,
    value: call.input,
    agentSource: req.source,
  });
  call.signal.throwIfAborted();
  const result = await tool.execute({ signal: call.signal }, input);
  call.signal.throwIfAborted();
  return validateToolValue({
    phase: "output",
    tool,
    value: result,
    agentSource: req.source,
  });
}

const maxValidationErrors = 8;
const maxValidationReportLength = 8_000;

async function validateToolValue(req: {
  readonly phase: "input" | "output";
  readonly tool: ExecutableToolDefinition;
  readonly value: unknown;
  readonly agentSource: string;
}): Promise<unknown> {
  const schema = req.phase === "input"
    ? req.tool.inputSchema
    : req.tool.outputSchema;
  const validation = await schema["~standard"].validate(req.value);
  if ("value" in validation) return validation.value;

  const issues = validation.issues.map((issue) => (
    `${formatStandardSchemaPath(issue.path)}: ${issue.message}`
  ));
  throw new ToolValidationError(
    req.tool.name,
    req.phase,
    formatToolValidationReport({
      phase: req.phase,
      toolName: req.tool.name,
      agentSource: req.agentSource,
      issues,
    }),
  );
}

function formatToolValidationReport(req: {
  readonly phase: "input" | "output";
  readonly toolName: string;
  readonly issues: readonly string[];
  readonly agentSource: string;
}): string {
  const issueLines = req.issues
    .slice(0, maxValidationErrors)
    .map((issue) => `- ${issue}`);
  if (req.issues.length > maxValidationErrors) {
    issueLines.push(
      `- ... ${req.issues.length - maxValidationErrors} additional issue(s) omitted.`,
    );
  }

  return truncateValidationReport([
    `Tool ${req.phase} validation failed for ${req.toolName}.`,
    "",
    "Schema errors:",
    ...issueLines,
    "",
    "Agent source excerpt:",
    ...formatToolCallExcerpt(req.agentSource, req.toolName),
  ].join("\n"));
}

function formatToolCallExcerpt(
  source: string,
  toolName: string,
): readonly string[] {
  const lines = source.split("\n");
  const pattern = new RegExp(
    `\\bcodemode\\s*\\.\\s*${escapeRegExp(toolName)}(?![$\\w])`,
  );
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) return ["  <tool call location unavailable>"];

  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length - 1, index + 1);
  const width = String(end + 1).length;
  const frame: string[] = [];
  for (let lineIndex = start; lineIndex <= end; lineIndex++) {
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex] ?? "";
    frame.push(`  ${String(lineNumber).padStart(width, " ")} | ${line}`);
    if (lineIndex === index) {
      const column = Math.max(0, line.search(pattern));
      frame.push(`  ${" ".repeat(width)} | ${" ".repeat(column)}^`);
    }
  }
  return frame;
}

function formatStandardSchemaPath(
  path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined,
): string {
  if (path === undefined || path.length === 0) return "/";
  return `/${path.map((segment) => {
    const key = typeof segment === "object" && segment !== null && "key" in segment
      ? segment.key
      : segment;
    return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  }).join("/")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateValidationReport(report: string): string {
  if (report.length <= maxValidationReportLength) return report;
  return `${report.slice(0, maxValidationReportLength - 36)}\n... validation report truncated.`;
}

class ToolValidationError extends Error {
  readonly details: {
    readonly kind: "tool-validation";
    readonly report: string;
  };

  constructor(
    toolName: string,
    phase: "input" | "output",
    report: string,
  ) {
    super(`Tool ${phase} validation failed for ${toolName}`);
    this.name = "ToolValidationError";
    this.details = { kind: "tool-validation", report };
  }
}
