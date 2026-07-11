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
  TelemetryEvent,
} from "./telemetry.ts";
import { errorFromUnknown } from "./telemetry.ts";
import type {
  ExecutableToolDefinition,
  ExecutableToolDefinitions,
} from "./types.ts";

export interface ExecuteRequest {
  readonly runtime: Runtime;
  readonly signal: AbortSignal;
  readonly agentSource: string;
  readonly tools: ExecutableToolDefinitions;
  emitTelemetry(event: TelemetryEvent): void;
}

export type RunOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "program-failed"; readonly error: TelemetryError };

const maxValidationErrors = 8;
const maxValidationReportLength = 8_000;

export async function execute(req: ExecuteRequest): Promise<RunOutcome> {
  try {
    const result = await executeInner(req);
    req.emitTelemetry({
      kind: "execution-completed",
      outcome: result,
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
): Promise<RunOutcome> {
  req.signal.throwIfAborted();

  let program;
  try {
    program = createProgram(req.agentSource);
  } catch (error) {
    if (!(error instanceof AgentSourceSyntaxError)) {
      throw error;
    }
    return {
      kind: "program-failed",
      error: errorFromUnknown(error),
    };
  }

  const instance = await req.runtime.start({
    program,
    signal: req.signal,
  });
  const toolCancellation = new AbortController();
  const toolSignal = AbortSignal.any([req.signal, toolCancellation.signal]);

  try {
    return await runRuntimeInstance(
      req,
      instance,
      toolSignal,
      toolCancellation,
    );
  } catch (error) {
    toolCancellation.abort(error);
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
  toolCancellation: AbortController,
): Promise<RunOutcome> {
  const pendingToolCalls = new Set<Promise<void>>();
  const toolCallFailure = Promise.withResolvers<never>();
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
        error: errorFromUnknown(error),
      });
      return;
    }

    try {
      const input = await validateToolValue({
        phase: "input",
        tool,
        value: message.input,
        agentSource: req.agentSource,
      });
      toolSignal.throwIfAborted();
      const result = await tool.execute({
        signal: toolSignal,
      }, input);
      toolSignal.throwIfAborted();
      const output = await validateToolValue({
        phase: "output",
        tool,
        value: result,
        agentSource: req.agentSource,
      });
      await writeResponse({
        kind: "tool-result",
        id: message.id,
        result: output,
      });
      req.emitTelemetry({
        kind: "tool-call-completed",
        toolCallId: message.id,
        toolName: message.name,
        output,
      });
    } catch (error) {
      if (toolSignal.aborted) {
        return;
      }
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
        error: errorFromUnknown(error),
      });
    }
  };

  const messages = readProgramMessages(instance.channel.incoming)[Symbol.asyncIterator]();
  for (;;) {
    const next = await Promise.race([
      messages.next(),
      toolCallFailure.promise,
    ]);
    if (next.done === true) {
      break;
    }
    const message = next.value;

    if (message.kind === "telemetry") {
      req.emitTelemetry(decodeProgramTelemetryEvent(message.event));
      continue;
    }

    if (message.kind === "tool-call") {
      const pendingToolCall = handleToolCall(message);
      pendingToolCalls.add(pendingToolCall);
      void pendingToolCall.then(
        () => {
          pendingToolCalls.delete(pendingToolCall);
        },
        (error: unknown) => {
          pendingToolCalls.delete(pendingToolCall);
          toolCallFailure.reject(error);
        },
      );

      continue;
    }

    if (message.kind === "program-error") {
      if (pendingToolCalls.size > 0) {
        toolCancellation.abort(
          new Error("Code-mode program failed while tool calls were still running"),
        );
      }
      await instance.terminate("Code-mode program failed");
      try {
        await instance.channel.outgoing.close();
      } catch {
        // The program may have closed the channel after sending its terminal error.
      }
      await assertRuntimeClosed(instance.finished);

      return {
        kind: "program-failed",
        error: message.error,
      };
    }

    if (message.kind === "completed") {
      if (pendingToolCalls.size > 0) {
        const error = new Error(
          "Code-mode program completed while tool calls were still running",
        );
        toolCancellation.abort(error);
        throw error;
      }
      await instance.terminate("Code-mode program completed");
      try {
        await instance.channel.outgoing.close();
      } catch {
        // The program may have closed the channel after sending completion.
      }
      await assertRuntimeClosed(instance.finished);

      return { kind: "success" };
    }
  }

  await assertRuntimeClosed(instance.finished);

  throw new Error("Code-mode execution finished without producing an outcome");
}

async function validateToolValue(req: {
  readonly phase: "input" | "output";
  readonly tool: ExecutableToolDefinition;
  readonly value: unknown;
  readonly agentSource: string;
}): Promise<unknown> {
  const schema = req.phase === "input" ? req.tool.inputSchema : req.tool.outputSchema;
  const validation = await schema["~standard"].validate(req.value);

  if ("value" in validation) {
    return validation.value;
  }

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
  const issueLines = req.issues.slice(0, maxValidationErrors).map((issue) => `- ${issue}`);

  if (req.issues.length > maxValidationErrors) {
    issueLines.push(`- ... ${req.issues.length - maxValidationErrors} additional issue(s) omitted.`);
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

function formatToolCallExcerpt(source: string, toolName: string): readonly string[] {
  const lines = source.split("\n");
  const pattern = new RegExp(`\\bcodemode\\s*\\.\\s*${toolName}\\b`);
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

async function assertRuntimeClosed(
  finished: Promise<{ readonly kind: "closed" } | { readonly kind: "failed"; readonly error: Error }>,
): Promise<void> {
  const result = await finished;

  if (result.kind === "closed") {
    return;
  }

  throw result.error;
}

function decodeProgramTelemetryEvent(
  event: ProgramTelemetryEvent,
): TelemetryEvent {
  return {
    kind: "program-log",
    level: event.level,
    message: event.message,
    values: event.values.map(decodeConsoleValue),
  };
}

function decodeConsoleValue(value: SerializedConsoleValue): unknown {
  return parseFlatted(value.value);
}
