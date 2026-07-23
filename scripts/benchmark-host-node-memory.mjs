import { createHostNodeRuntime } from "../dist/host-node/index.js";

const executionCount = 5_000;
const sampleInterval = executionCount / 10;
const source = [
  'import { memoryUsage } from "node:process";',
  "",
  "export default function ({ console }) {",
  "  console.log(JSON.stringify(memoryUsage()));",
  "}",
].join("\n");
const runtime = await createHostNodeRuntime(
  {
    nodePath: process.execPath,
    cwd: process.cwd(),
  },
  AbortSignal.timeout(5_000),
);
const executionSignal = new AbortController().signal;

console.log("execution,rss_mib,heap_used_mib,heap_total_mib,external_mib");
try {
  for (let execution = 1; execution <= executionCount; execution += 1) {
    let output = "";
    const outcome = await runtime.execute({
      source,
      signal: executionSignal,
      async invokeTool() {
        throw new Error("The memory benchmark does not expose tools");
      },
      emitOutput(chunk) {
        if (chunk.stream === "stdout") output += chunk.text;
      },
    });
    if (outcome.kind !== "success") {
      throw new Error(outcome.error.message);
    }
    if (execution % sampleInterval === 0) {
      printSample(execution, parseMemoryUsage(output));
    }
  }
} finally {
  await runtime[Symbol.asyncDispose]();
}

function parseMemoryUsage(output) {
  const value = JSON.parse(output.trim());
  for (const field of ["rss", "heapUsed", "heapTotal", "external"]) {
    if (typeof value[field] !== "number") {
      throw new Error(`Missing numeric memoryUsage().${field}`);
    }
  }
  return value;
}

function printSample(execution, usage) {
  console.log([
    execution,
    toMebibytes(usage.rss),
    toMebibytes(usage.heapUsed),
    toMebibytes(usage.heapTotal),
    toMebibytes(usage.external),
  ].join(","));
}

function toMebibytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}
