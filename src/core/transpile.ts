import { transformSync } from "amaro";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

export type TranspileResult =
  | { readonly kind: "javascript"; readonly source: string }
  | { readonly kind: "invalid"; readonly report: string };

export const agentProgramFactoryName = "__createCodeModeAgentProgram";
const maxReportLength = 8_000;

export function transpileAgentSource(source: string): TranspileResult {
  try {
    assertSingleExpression(source);
    const result = transformSync(
      `function ${agentProgramFactoryName}(console, globalThis, global, Promise) {
  const agentProgram = (${source}\n);
  return agentProgram;
}`,
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

function assertSingleExpression(source: string): void {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  let parenthesisDepth = 0;
  let previousToken: SyntaxKind | undefined;
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (token === SyntaxKind.SlashToken && !canEndExpression(previousToken)) {
      token = scanner.reScanSlashToken();
    }
    if (token === SyntaxKind.OpenParenToken) {
      parenthesisDepth++;
    } else if (token === SyntaxKind.CloseParenToken) {
      if (parenthesisDepth === 0) {
        throw new SyntaxError("Code-mode source must be a single expression");
      }
      parenthesisDepth--;
    }
    previousToken = token;
  }
}

function canEndExpression(token: SyntaxKind | undefined): boolean {
  return token === SyntaxKind.Identifier
    || token === SyntaxKind.PrivateIdentifier
    || token === SyntaxKind.NumericLiteral
    || token === SyntaxKind.BigIntLiteral
    || token === SyntaxKind.StringLiteral
    || token === SyntaxKind.NoSubstitutionTemplateLiteral
    || token === SyntaxKind.TemplateTail
    || token === SyntaxKind.RegularExpressionLiteral
    || token === SyntaxKind.CloseParenToken
    || token === SyntaxKind.CloseBracketToken
    || token === SyntaxKind.CloseBraceToken
    || token === SyntaxKind.PlusPlusToken
    || token === SyntaxKind.MinusMinusToken
    || token === SyntaxKind.FalseKeyword
    || token === SyntaxKind.NullKeyword
    || token === SyntaxKind.SuperKeyword
    || token === SyntaxKind.ThisKeyword
    || token === SyntaxKind.TrueKeyword;
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
