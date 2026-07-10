import { parse as parseFlatted } from "flatted";

import {
  readProgramMessages,
  writeHostMessage,
} from "./protocol/codec.ts";
import type {
  HostMessage,
  ProgramMessage,
  ProgramTelemetryEvent,
  SerializedConsoleValue,
} from "./protocol/schema.ts";
import type { Runtime } from "./runtime.ts";
import {
  AgentSourceSyntaxError,
  createProgram,
} from "./program.ts";
import type {
  TelemetryError,
  TelemetryEventInput,
} from "./telemetry.ts";
import { errorFromUnknown } from "./telemetry.ts";
import type {
  ExecutableToolDefinition,
  ExecutableToolDefinitions,
  ToolSchema,
} from "./types.ts";

export interface ExecuteRequest {
  readonly executionId: string;
  readonly runtime: Runtime;
  readonly signal: AbortSignal;
  readonly agentSource: string;
  readonly tools: ExecutableToolDefinitions;
  emitTelemetry(event: TelemetryEventInput): void;
}

export interface ExecuteResult {
  readonly outcome: RunOutcome;
}

export type RunOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "program-failed"; readonly error: TelemetryError };

const maxValidationErrors = 8;
const maxValidationReportLength = 8_000;
const maxStackLines = 8;
const maxStackLineLength = 180;

export async function execute(req: ExecuteRequest): Promise<ExecuteResult> {
  req.emitTelemetry({ kind: "execution-started" });

  try {
    const result = await executeInner(req);
    req.emitTelemetry({
      kind: "execution-completed",
      outcome: result.outcome,
    });
    return result;
  } catch (error) {
    req.emitTelemetry({
      kind: "execution-failed",
      error: errorFromUnknown(error),
    });
    throw error;
  }
}

async function executeInner(
  req: ExecuteRequest,
): Promise<ExecuteResult> {
  let program;
  try {
    program = createProgram({ agentSource: req.agentSource });
  } catch (error) {
    if (!(error instanceof AgentSourceSyntaxError)) {
      throw error;
    }
    return {
      outcome: {
        kind: "program-failed",
        error: errorFromUnknown(error),
      },
    };
  }

  const instance = await req.runtime.start({
    program,
    signal: req.signal,
  });
  const runtimeFailure = new AbortController();
  const toolSignal = AbortSignal.any([req.signal, runtimeFailure.signal]);

  try {
    return await runRuntimeInstance(req, instance, toolSignal);
  } catch (error) {
    runtimeFailure.abort(error);
    try {
      await instance.terminate("Code-mode execution failed");
    } catch (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        "Code-mode execution failed and its runtime could not be terminated",
        { cause: error },
      );
    }
    throw error;
  }
}

async function runRuntimeInstance(
  req: ExecuteRequest,
  instance: Awaited<ReturnType<Runtime["start"]>>,
  toolSignal: AbortSignal,
): Promise<ExecuteResult> {
  req.emitTelemetry({ kind: "runtime-started" });
  const pendingToolCalls = new Set<Promise<void>>();
  let writeQueue: Promise<void> = Promise.resolve();

  const writeResponse = async (message: HostMessage): Promise<void> => {
    const write = writeQueue.then(async () => {
      await writeHostMessage(instance.channel.outgoing, message);
    });
    writeQueue = write.catch(() => {});
    await write;
  };

  const handleToolCall = async (
    message: Extract<ProgramMessage, { readonly kind: "tool-call" }>,
  ): Promise<void> => {
    req.emitTelemetry({
      kind: "tool-call-started",
      toolCallId: message.id,
      toolName: message.name,
      input: message.input,
    });

    const tool = req.tools[message.name];

    if (tool === undefined) {
      const error = new Error(`No code-mode tool is registered for ${message.name}`);
      req.emitTelemetry({
        kind: "tool-call-failed",
        toolCallId: message.id,
        toolName: message.name,
        input: message.input,
        error: errorFromUnknown(error),
      });
      await writeResponse({
        kind: "tool-error",
        id: message.id,
        error: serializeProgramError(error),
      });
      return;
    }

    try {
      const input = await validateToolValue({
        phase: "input",
        tool,
        value: message.input,
        agentSource: req.agentSource,
        callStack: message.stack,
      });
      const result = await tool.execute({
        signal: toolSignal,
      }, input);
      const output = await validateToolValue({
        phase: "output",
        tool,
        value: result,
        agentSource: req.agentSource,
        callStack: message.stack,
      });
      req.emitTelemetry({
        kind: "tool-call-completed",
        toolCallId: message.id,
        toolName: message.name,
        output,
      });
      await writeResponse({
        kind: "tool-result",
        id: message.id,
        result: output,
      });
    } catch (error) {
      req.emitTelemetry({
        kind: "tool-call-failed",
        toolCallId: message.id,
        toolName: message.name,
        input: message.input,
        error: errorFromUnknown(error),
      });
      await writeResponse({
        kind: "tool-error",
        id: message.id,
        error: serializeProgramError(error),
      });
    }
  };

  for await (const message of readProgramMessages(instance.channel.incoming)) {
    if (message.kind === "telemetry") {
      req.emitTelemetry(decodeProgramTelemetryEvent(message.event));
      continue;
    }

    if (message.kind === "tool-call") {
      const pendingToolCall = handleToolCall(message);
      pendingToolCalls.add(pendingToolCall);
      void pendingToolCall
        .finally(() => {
          pendingToolCalls.delete(pendingToolCall);
        })
        .catch(() => {});

      continue;
    }

    if (message.kind === "program-error") {
      await Promise.all(pendingToolCalls);
      await writeQueue;
      await instance.channel.outgoing.close();
      await assertRuntimeClosed(instance.finished, req.emitTelemetry);

      return {
        outcome: {
          kind: "program-failed",
          error: message.error,
        },
      };
    }

    if (message.kind === "completed") {
      await Promise.all(pendingToolCalls);
      await writeQueue;
      await instance.channel.outgoing.close();
      await assertRuntimeClosed(instance.finished, req.emitTelemetry);

      return {
        outcome: {
          kind: "success",
        },
      };
    }
  }

  await assertRuntimeClosed(instance.finished, req.emitTelemetry);

  throw new Error("Code-mode execution finished without producing an outcome");
}

async function validateToolValue(req: {
  readonly phase: "input" | "output";
  readonly tool: ExecutableToolDefinition;
  readonly value: unknown;
  readonly agentSource: string;
  readonly callStack: string;
}): Promise<unknown> {
  const schema = req.phase === "input" ? req.tool.inputSchema : req.tool.outputSchema;
  const validation = await validateAgainstSchema(schema, req.value);

  if ("value" in validation) {
    return validation.value;
  }

  throw new ToolValidationError(
    req.tool.name,
    req.phase,
    formatToolValidationReport({
      ...req,
      issues: validation.issues,
    }),
  );
}

async function validateAgainstSchema(
  schema: ToolSchema,
  value: unknown,
): Promise<SchemaValidationResult> {
  const result = await schema["~standard"].validate(value);

  if ("value" in result) {
    return { value: result.value };
  }

  return {
    issues: result.issues.map((issue) => ({
      path: formatStandardSchemaPath(issue.path),
      message: issue.message,
    })),
  };
}

function formatToolValidationReport(req: {
  readonly phase: "input" | "output";
  readonly tool: ExecutableToolDefinition;
  readonly issues: readonly SchemaValidationIssue[];
  readonly agentSource: string;
  readonly callStack: string;
}): string {
  const issueLines = req.issues.slice(0, maxValidationErrors).map((issue) => (
    `- ${issue.path}: ${issue.message}`
  ));

  if (req.issues.length > maxValidationErrors) {
    issueLines.push(`- ... ${req.issues.length - maxValidationErrors} additional issue(s) omitted.`);
  }

  return truncateValidationReport([
    `Tool ${req.phase} validation failed for ${req.tool.name}.`,
    "",
    "Schema errors:",
    ...issueLines,
    "",
    "Agent source excerpt:",
    ...formatToolCallExcerpt(req.agentSource, req.tool.name),
    "",
    "Agent call stack:",
    ...formatCallStack(req.callStack),
  ].join("\n"));
}

function formatToolCallExcerpt(source: string, toolName: string): readonly string[] {
  const lines = source.split("\n");
  const pattern = new RegExp(`\\bcodemode\\s*\\.\\s*${escapeRegExp(toolName)}\\b`);
  const index = lines.findIndex((line) => pattern.test(line));

  if (index === -1) {
    return ["  <tool call location unavailable>"];
  }

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

function formatCallStack(stack: string): readonly string[] {
  if (stack.trim() === "") {
    return ["  <stack unavailable>"];
  }

  return stack
    .split("\n")
    .map(formatStackLine)
    .filter((line) => line.trim() !== "")
    .slice(0, maxStackLines)
    .map((line) => `  ${line}`);
}

function formatStackLine(line: string): string {
  const trimmed = line.trim();
  const frame = parseStackFrame(trimmed);

  if (frame === undefined) {
    return truncateStackLine(trimmed);
  }

  const location = formatStackLocation(frame.location);
  return truncateStackLine(frame.name === undefined
    ? `at ${location}`
    : `at ${frame.name} (${location})`);
}

function parseStackFrame(line: string): StackFrame | undefined {
  if (!line.startsWith("at ")) {
    return undefined;
  }

  const frame = line.slice(3);
  const named = /^(?<name>.*?) \((?<location>.*)\)$/.exec(frame);

  if (named?.groups?.location !== undefined) {
    return {
      name: named.groups.name,
      location: named.groups.location,
    };
  }

  if (frame.length > 0) {
    return {
      location: frame,
    };
  }

  return undefined;
}

function formatStackLocation(location: string): string {
  const parsed = parseStackLocation(location);

  if (parsed === undefined) {
    return truncateStackLine(location);
  }

  const source = formatStackSource(parsed.source);
  return parsed.line === undefined
    ? source
    : `${source}:${parsed.line}${parsed.column === undefined ? "" : `:${parsed.column}`}`;
}

function parseStackLocation(location: string): StackLocation | undefined {
  const match = /^(?<source>.*?)(?::(?<line>\d+))?(?::(?<column>\d+))?$/.exec(location);

  if (match?.groups?.source === undefined) {
    return undefined;
  }

  return {
    source: match.groups.source,
    line: match.groups.line,
    column: match.groups.column,
  };
}

function formatStackSource(source: string): string {
  if (source.length === 0) {
    return "<unknown>";
  }

  try {
    const url = new URL(source);

    if (url.protocol === "data:" || url.protocol === "blob:") {
      return "<generated-runtime-program>";
    }

    if (url.protocol === "file:") {
      return url.pathname.split("/").at(-1) || "<file>";
    }

    return `${url.protocol}//${url.host}${url.pathname.split("/").at(-1) ?? ""}`;
  } catch {
    return source.length > maxStackLineLength / 2
      ? "<generated-runtime-program>"
      : source;
  }
}

function truncateStackLine(line: string): string {
  if (line.length <= maxStackLineLength) {
    return line;
  }

  return `${line.slice(0, maxStackLineLength - 15)}... <truncated>`;
}

interface StackFrame {
  readonly name?: string;
  readonly location: string;
}

interface StackLocation {
  readonly source: string;
  readonly line?: string;
  readonly column?: string;
}

function formatStandardSchemaPath(
  path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined,
): string {
  if (path === undefined || path.length === 0) {
    return "/";
  }

  return `/${path.map((segment) => {
    const key = typeof segment === "object" && segment !== null && "key" in segment
      ? segment.key
      : segment;
    return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  }).join("/")}`;
}

function truncateValidationReport(report: string): string {
  if (report.length <= maxValidationReportLength) {
    return report;
  }

  return `${report.slice(0, maxValidationReportLength - 36)}\n... validation report truncated.`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    this.details = {
      kind: "tool-validation",
      report,
    };
  }
}

interface SchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

type SchemaValidationResult =
  | { readonly value: unknown }
  | { readonly issues: readonly SchemaValidationIssue[] };

async function assertRuntimeClosed(
  finished: Promise<{ readonly kind: "closed" } | { readonly kind: "failed"; readonly error: Error }>,
  emitTelemetry: (event: TelemetryEventInput) => void,
): Promise<void> {
  const result = await finished;

  if (result.kind === "closed") {
    emitTelemetry({
      kind: "runtime-finished",
      status: "closed",
    });
    return;
  }

  emitTelemetry({
    kind: "runtime-finished",
    status: "failed",
    error: errorFromUnknown(result.error),
  });
  throw result.error;
}

function serializeProgramError(error: unknown): TelemetryError {
  return errorFromUnknown(error);
}

function decodeProgramTelemetryEvent(
  event: ProgramTelemetryEvent,
): TelemetryEventInput {
  if (event.kind !== "program-log") {
    return event;
  }

  return {
    kind: "program-log",
    level: event.level,
    message: event.message,
    values: event.values.map(decodeConsoleValue),
  };
}

function decodeConsoleValue(value: SerializedConsoleValue): unknown {
  if (value.format !== "flatted") {
    throw new Error(`Unsupported code-mode console value format: ${String(value.format)}`);
  }

  return parseFlatted(value.value);
}
