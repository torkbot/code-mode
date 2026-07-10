import { API } from "typescript/unstable/async";
import type { Diagnostic } from "typescript/unstable/async";
import type { FileSystem, FileSystemEntries } from "typescript/unstable/fs";

import type { TypeDefinitionFile } from "../environment.ts";

export interface ValidateAgentSourceRequest {
  readonly source: string;
  readonly typeDefinitions: string;
  readonly typeDefinitionFiles: readonly TypeDefinitionFile[];
  readonly signal: AbortSignal;
}

export interface TypecheckFailure {
  readonly kind: "typecheck";
  readonly diagnostics: readonly TypecheckDiagnostic[];
  readonly report: string;
}

export interface TypecheckDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
}

const maxReportedDiagnostics = 8;
const contextLinesBefore = 1;
const contextLinesAfter = 1;
const maxReportLineLength = 160;
const maxReportLength = 8_000;

const projectRoot = "/__code_mode__";
const agentFile = `${projectRoot}/agent.ts`;
const typesFile = `${projectRoot}/codemode.d.ts`;
const tsconfigFile = `${projectRoot}/tsconfig.json`;

export async function validateAgentSource(
  req: ValidateAgentSourceRequest,
): Promise<TypecheckFailure | undefined> {
  throwIfAborted(req.signal);

  const files = createValidationFiles(req);
  const api = new API({
    cwd: projectRoot,
    fs: createValidationFileSystem(files),
  });

  try {
    throwIfAborted(req.signal);
    const snapshot = await api.updateSnapshot({
      openProject: tsconfigFile,
    });

    try {
      throwIfAborted(req.signal);
      const project = snapshot.getProjects()[0];

      if (project === undefined) {
        throw new Error("Code-mode typecheck did not create a TypeScript project");
      }

      const diagnostics = [
        ...(await project.program.getConfigFileParsingDiagnostics()),
        ...(await project.program.getSyntacticDiagnostics()),
        ...(await project.program.getSemanticDiagnostics()),
      ];

      if (diagnostics.length === 0) {
        return undefined;
      }

      return {
        kind: "typecheck",
        diagnostics: diagnostics
          .slice(0, maxReportedDiagnostics)
          .map((diagnostic) => serializeDiagnostic(diagnostic, files)),
        report: formatDiagnosticReport(diagnostics, files),
      };
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}

function createValidationFiles(
  req: ValidateAgentSourceRequest,
): ReadonlyMap<string, string> {
  const files = new Map([
    [typesFile, req.typeDefinitions],
    [agentFile, createAgentTypecheckSource(req.source)],
  ]);
  const runtimeTypePaths: string[] = [];

  for (const file of req.typeDefinitionFiles) {
    const virtualPath = toVirtualRuntimeTypePath(file.path);
    runtimeTypePaths.push(toProjectRelativePath(virtualPath));
    files.set(virtualPath, file.contents);
  }

  files.set(tsconfigFile, createTypecheckTsconfig(runtimeTypePaths));
  return files;
}

function toVirtualRuntimeTypePath(path: string): string {
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error(`Code-mode runtime type definition path must be relative: ${path}`);
  }

  const segments = path.split("/");

  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Code-mode runtime type definition path must be normalized: ${path}`);
  }

  return `${projectRoot}/${path}`;
}

function createAgentTypecheckSource(source: string): string {
  return [
    `/// <reference path="./codemode.d.ts" />`,
    `const program: AgentProgram = (`,
    source,
    `);`,
    `void program;`,
    "",
  ].join("\n");
}

function toProjectRelativePath(path: string): string {
  if (!path.startsWith(`${projectRoot}/`)) {
    throw new Error(`Code-mode virtual type path must be inside the project: ${path}`);
  }

  return path.slice(projectRoot.length + 1);
}

function createTypecheckTsconfig(runtimeTypePaths: readonly string[]): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "es2024",
        module: "nodenext",
        moduleResolution: "nodenext",
        lib: ["es2024"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      files: ["agent.ts", "codemode.d.ts", ...runtimeTypePaths],
    },
    null,
    2,
  );
}

function createValidationFileSystem(files: ReadonlyMap<string, string>): FileSystem {
  const directories = getVirtualDirectories(files);

  return {
    directoryExists(directoryName): boolean | undefined {
      if (directories.has(directoryName)) {
        return true;
      }

      return undefined;
    },
    fileExists(fileName): boolean | undefined {
      if (files.has(fileName)) {
        return true;
      }

      return undefined;
    },
    getAccessibleEntries(directoryName): FileSystemEntries | undefined {
      if (!directories.has(directoryName)) {
        return undefined;
      }

      return getAccessibleEntries(files, directoryName);
    },
    readFile(fileName): string | null | undefined {
      if (files.has(fileName)) {
        return files.get(fileName) ?? null;
      }

      return undefined;
    },
    realpath(path): string {
      return path;
    },
    writeFile(path): void {
      throw new Error(`Code-mode validation must not write files: ${path}`);
    },
    removeFile(path): void {
      throw new Error(`Code-mode validation must not remove files: ${path}`);
    },
  };
}

function getVirtualDirectories(files: ReadonlyMap<string, string>): ReadonlySet<string> {
  const directories = new Set(["/"]);

  for (const file of files.keys()) {
    const segments = file.split("/").filter((segment) => segment.length > 0);
    let current = "";

    for (const segment of segments.slice(0, -1)) {
      current = `${current}/${segment}`;
      directories.add(current);
    }
  }

  return directories;
}

function getAccessibleEntries(
  files: ReadonlyMap<string, string>,
  directoryName: string,
): FileSystemEntries {
  const prefix = directoryName === "/" ? "/" : `${directoryName}/`;
  const childFiles = new Set<string>();
  const childDirectories = new Set<string>();

  for (const file of files.keys()) {
    if (!file.startsWith(prefix)) {
      continue;
    }

    const remainder = file.slice(prefix.length);
    const [first, ...rest] = remainder.split("/");

    if (first === undefined || first.length === 0) {
      continue;
    }

    if (rest.length === 0) {
      childFiles.add(first);
      continue;
    }

    childDirectories.add(first);
  }

  return {
    files: [...childFiles],
    directories: [...childDirectories],
  };
}

function formatDiagnosticReport(
  diagnostics: readonly Diagnostic[],
  files: ReadonlyMap<string, string>,
): string {
  const rendered = diagnostics.slice(0, maxReportedDiagnostics).map((diagnostic, index) => (
    formatDiagnosticBlock(index + 1, diagnostic, files)
  ));

  if (diagnostics.length > maxReportedDiagnostics) {
    rendered.push(
      `... ${diagnostics.length - maxReportedDiagnostics} additional diagnostic(s) omitted.`,
    );
  }

  return truncateReport([
    `TypeScript validation failed with ${diagnostics.length} diagnostic(s).`,
    "",
    rendered.join("\n\n"),
  ].join("\n"));
}

function formatDiagnosticBlock(
  index: number,
  diagnostic: Diagnostic,
  files: ReadonlyMap<string, string>,
): string {
  const file = formatDiagnosticFile(diagnostic.fileName);
  const source = diagnostic.fileName === undefined ? undefined : files.get(diagnostic.fileName);
  const position = source === undefined
    ? { line: 1, column: 1 }
    : getLineAndColumn(source, diagnostic.pos);
  const header = `${index}. ${diagnosticCode(diagnostic)} at ${file}:${position.line}:${position.column}`;
  const message = indentLines(diagnostic.text, "   ");
  const frame = source === undefined
    ? []
    : ["", ...formatSourceFrame(source, position.line, position.column)];

  return [
    header,
    message,
    ...frame,
  ].join("\n");
}

function formatSourceFrame(
  source: string,
  line: number,
  column: number,
): string[] {
  const lines = source.split("\n");
  const startLine = Math.max(1, line - contextLinesBefore);
  const endLine = Math.min(lines.length, line + contextLinesAfter);
  const lineNumberWidth = String(endLine).length;
  const frame: string[] = [];

  for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
    const sourceLine = lines[currentLine - 1] ?? "";
    const trimmed = trimReportLine(sourceLine, currentLine === line ? column : 1);
    const gutter = String(currentLine).padStart(lineNumberWidth, " ");
    frame.push(`   ${gutter} | ${trimmed.text}`);

    if (currentLine === line) {
      frame.push(`   ${" ".repeat(lineNumberWidth)} | ${" ".repeat(trimmed.column - 1)}^`);
    }
  }

  return frame;
}

function trimReportLine(
  line: string,
  column: number,
): {
  readonly text: string;
  readonly column: number;
} {
  if (line.length <= maxReportLineLength) {
    return { text: line, column };
  }

  const halfWidth = Math.floor((maxReportLineLength - 3) / 2);
  const start = Math.max(0, column - halfWidth - 1);
  const end = Math.min(line.length, start + maxReportLineLength - 3);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < line.length ? "..." : "";
  const text = `${prefix}${line.slice(start, end)}${suffix}`;
  return {
    text,
    column: Math.max(1, column - start + prefix.length),
  };
}

function indentLines(text: string, indent: string): string {
  return text.split("\n").map((line) => `${indent}${line}`).join("\n");
}

function truncateReport(report: string): string {
  if (report.length <= maxReportLength) {
    return report;
  }

  return `${report.slice(0, maxReportLength - 36)}\n... diagnostic report truncated.`;
}

function serializeDiagnostic(
  diagnostic: Diagnostic,
  files: ReadonlyMap<string, string>,
): TypecheckDiagnostic {
  const file = formatDiagnosticFile(diagnostic.fileName);
  const source = diagnostic.fileName === undefined ? undefined : files.get(diagnostic.fileName);
  const position = source === undefined
    ? { line: 1, column: 1 }
    : getLineAndColumn(source, diagnostic.pos);

  return {
    file,
    line: position.line,
    column: position.column,
    code: diagnosticCode(diagnostic),
    message: diagnostic.text,
  };
}

function diagnosticCode(diagnostic: Diagnostic): string {
  return `TS${diagnostic.code}`;
}

function formatDiagnosticFile(fileName: string | undefined): string {
  if (fileName === agentFile) {
    return "agent.ts";
  }

  if (fileName === typesFile) {
    return "codemode.d.ts";
  }

  if (fileName === tsconfigFile) {
    return "tsconfig.json";
  }

  return fileName ?? "agent.ts";
}

function getLineAndColumn(source: string, offset: number): {
  readonly line: number;
  readonly column: number;
} {
  let line = 1;
  let column = 1;
  const end = Math.max(0, Math.min(offset, source.length));

  for (let index = 0; index < end; index++) {
    if (source[index] === "\n") {
      line++;
      column = 1;
      continue;
    }

    column++;
  }

  return { line, column };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Code-mode validation aborted");
  }
}
