import { transformSync } from "amaro";

export type TranspileResult =
  | { readonly kind: "javascript"; readonly source: string }
  | { readonly kind: "invalid"; readonly report: string };

export const agentProgramVariableName = "__codeModeAgentProgram";
const maxReportLength = 8_000;

export function transpileAgentSource(source: string): TranspileResult {
  try {
    const result = transformSync(
      `const ${agentProgramVariableName} = (${source}\n);`,
      {
        filename: "agent.ts",
        mode: "strip-only",
        module: true,
        sourceMap: false,
      },
    );
    return {
      kind: "javascript",
      source: result.code,
    };
  } catch (error) {
    const report = formatTransformError(error);
    return {
      kind: "invalid",
      report: report.length <= maxReportLength
        ? report
        : `${report.slice(0, maxReportLength - 33)}\n... transpile report truncated.`,
    };
  }
}

function formatTransformError(error: unknown): string {
  if (isTransformError(error)) {
    return `agent.ts ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return `agent.ts: ${error.message}`;
  }
  return `agent.ts: ${String(error)}`;
}

function isTransformError(error: unknown): error is {
  readonly code: string;
  readonly message: string;
} {
  return typeof error === "object"
    && error !== null
    && typeof (error as { readonly code?: unknown }).code === "string"
    && typeof (error as { readonly message?: unknown }).message === "string";
}
