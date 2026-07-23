import assert from "node:assert/strict";
import test from "node:test";

import type {
  RuntimeConnection,
  RuntimeDriver,
} from "../runtime/index.ts";
import { createRuntimeFactory } from "../runtime/index.ts";
import {
  startRunner,
  type RunnerConsole,
  type RunnerProgramOutput,
} from "../runner/index.ts";

test("a runtime driver boots one runner and executes programs through the connected runtime", async () => {
  const observedRunnerSources: string[] = [];
  const driver: RuntimeDriver<Record<string, never>> = {
    description: "in-memory JavaScript",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async connect(_options, request) {
      request.signal.throwIfAborted();
      observedRunnerSources.push(request.runnerSource);
      return createInMemoryConnection((execute) => execute());
    },
  };
  const createRuntime = createRuntimeFactory(driver);
  const runtime = await createRuntime({}, AbortSignal.timeout(5_000));
  const outputs: RunnerProgramOutput[] = [];

  const outcome = await runtime.execute({
    source: [
      "export default async function ({ codemode, console }) {",
      "  console.log('calling tool');",
      "  const result = await codemode.echo({ value: 'hello' });",
      "  if (result.value !== 'hello') throw new Error('unexpected result');",
      "  return 42;",
      "}",
    ].join("\n"),
    signal: AbortSignal.timeout(5_000),
    async invokeTool(request) {
      assert.equal(request.name, "echo");
      assert.deepEqual(request.input, { value: "hello" });
      assert.equal(request.signal.aborted, false);
      return request.input;
    },
    emitOutput(output) {
      outputs.push(output);
    },
  });

  assert.deepEqual(outcome, { kind: "success" });
  assert.deepEqual(outputs, [{ stream: "stdout", text: "calling tool\n" }]);
  assert.equal(runtime.description, "in-memory JavaScript");
  assert.equal(observedRunnerSources.length, 1);
  assert.match(observedRunnerSources[0] ?? "", /export async function startRunner/);

  await runtime[Symbol.asyncDispose]();
  assert.deepEqual(await runtime.finished, { kind: "closed" });
});

test("a runtime factory rejects malformed runner messages and cleans up the connection", async () => {
  let disposalCount = 0;
  const runnerToHost = new TransformStream<Uint8Array, Uint8Array>();
  const hostToRunner = new TransformStream<Uint8Array, Uint8Array>();
  const runnerWriter = runnerToHost.writable.getWriter();
  const malformedMessage = runnerWriter.write(encodeFrame({
    kind: "ready-but-not-really",
  }));
  const connectionFinished = Promise.withResolvers<{
    readonly kind: "closed";
  }>();
  const driver: RuntimeDriver<Record<string, never>> = {
    description: "malformed runner",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async connect() {
      return {
        channel: {
          readable: runnerToHost.readable,
          writable: hostToRunner.writable,
        },
        finished: connectionFinished.promise,
        async [Symbol.asyncDispose]() {
          disposalCount += 1;
          await malformedMessage.catch(() => {});
          await runnerWriter.close().catch(() => {});
          await hostToRunner.readable.cancel().catch(() => {});
          connectionFinished.resolve({ kind: "closed" });
        },
      };
    },
  };

  await assert.rejects(
    createRuntimeFactory(driver)({}, AbortSignal.timeout(5_000)),
    /Invalid code-mode runner message/,
  );
  assert.equal(disposalCount, 1);
});

test("runtime execution observes cancellation while installing its abort listener", async () => {
  const driver: RuntimeDriver<Record<string, never>> = {
    description: "in-memory JavaScript",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async connect() {
      return createInMemoryConnection((execute) => execute());
    },
  };
  const runtime = await createRuntimeFactory(driver)(
    {},
    AbortSignal.timeout(5_000),
  );
  const controller = new AbortController();
  const reason = new Error("cancelled while subscribing");
  const signal = controller.signal;
  const addEventListener = signal.addEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    value(...args: Parameters<AbortSignal["addEventListener"]>) {
      controller.abort(reason);
      return addEventListener(...args);
    },
  });

  try {
    await assert.rejects(runtime.execute({
      source: "export default function () {}",
      signal,
      async invokeTool() {
        throw new Error("cancelled program must not invoke tools");
      },
      emitOutput() {},
    }), (error) => error === reason);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("runtime treats an unannounced runner channel close as a failure", async () => {
  const runnerToHost = new TransformStream<Uint8Array, Uint8Array>();
  const hostToRunner = new TransformStream<Uint8Array, Uint8Array>();
  const runnerWriter = runnerToHost.writable.getWriter();
  const ready = runnerWriter.write(encodeFrame({ kind: "ready" }));
  const connectionFinished = Promise.withResolvers<{
    readonly kind: "closed";
  }>();
  const driver: RuntimeDriver<Record<string, never>> = {
    description: "closing runner",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async connect() {
      return {
        channel: {
          readable: runnerToHost.readable,
          writable: hostToRunner.writable,
        },
        finished: connectionFinished.promise,
        async [Symbol.asyncDispose]() {
          await hostToRunner.readable.cancel().catch(() => {});
          connectionFinished.resolve({ kind: "closed" });
        },
      };
    },
  };
  const runtime = await createRuntimeFactory(driver)(
    {},
    AbortSignal.timeout(5_000),
  );

  await ready;
  await runnerWriter.close();
  const timeout = Promise.withResolvers<never>();
  const timeoutHandle = setTimeout(() => {
    timeout.reject(new Error("runtime did not observe channel close"));
  }, 100);
  const finished = await Promise.race([
    runtime.finished,
    timeout.promise,
  ]).finally(() => clearTimeout(timeoutHandle));
  assert.equal(finished.kind, "failed");
  assert.match(finished.error.message, /runner channel closed/);
  await runtime[Symbol.asyncDispose]();
});

test("runner delegates whole-execution scheduling to its runtime adapter", async () => {
  let queue: Promise<void> = Promise.resolve();
  const schedule = (execute: () => Promise<void>): Promise<void> => {
    const scheduled = queue.then(execute);
    queue = scheduled.catch(() => {});
    return scheduled;
  };
  const driver: RuntimeDriver<Record<string, never>> = {
    description: "serial in-memory JavaScript",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async connect() {
      return createInMemoryConnection(schedule);
    },
  };
  const runtime = await createRuntimeFactory(driver)(
    {},
    AbortSignal.timeout(5_000),
  );
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let secondStarted = false;
  const execute = (label: string) => runtime.execute({
    source: [
      "export default async function ({ codemode }) {",
      `  await codemode.wait({ label: ${JSON.stringify(label)} });`,
      "}",
    ].join("\n"),
    signal: AbortSignal.timeout(5_000),
    async invokeTool(request) {
      const input = request.input as { readonly label: string };
      if (input.label === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else {
        secondStarted = true;
      }
      return {};
    },
    emitOutput() {},
  });

  try {
    const first = execute("first");
    await firstStarted.promise;
    const second = execute("second");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondStarted, false);
    releaseFirst.resolve();
    assert.deepEqual(await Promise.all([first, second]), [
      { kind: "success" },
      { kind: "success" },
    ]);
    assert.equal(secondStarted, true);
  } finally {
    releaseFirst.resolve();
    await runtime[Symbol.asyncDispose]();
  }
});

test("a non-JSON tool result fails one program without closing the runtime", async () => {
  const driver: RuntimeDriver<Record<string, never>> = {
    description: "in-memory JavaScript",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async connect() {
      return createInMemoryConnection((execute) => execute());
    },
  };
  const runtime = await createRuntimeFactory(driver)(
    {},
    AbortSignal.timeout(5_000),
  );

  try {
    const failed = await runtime.execute({
      source: [
        "export default async function ({ codemode }) {",
        "  await codemode.nonJson({});",
        "}",
      ].join("\n"),
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        return 1n;
      },
      emitOutput() {},
    });
    assert.equal(failed.kind, "program-failed");
    assert.match(failed.error.message, /JSON-compatible/);

    assert.deepEqual(await runtime.execute({
      source: "export default function () {}",
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        throw new Error("program must not invoke tools");
      },
      emitOutput() {},
    }), { kind: "success" });
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("a non-JSON tool input fails before reaching the host", async () => {
  const driver: RuntimeDriver<Record<string, never>> = {
    description: "in-memory JavaScript",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async connect() {
      return createInMemoryConnection((execute) => execute());
    },
  };
  const runtime = await createRuntimeFactory(driver)(
    {},
    AbortSignal.timeout(5_000),
  );
  let invoked = false;

  try {
    const failed = await runtime.execute({
      source: [
        "export default async function ({ codemode }) {",
        "  await codemode.nonJson(1n);",
        "}",
      ].join("\n"),
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        invoked = true;
        return null;
      },
      emitOutput() {},
    });
    assert.equal(failed.kind, "program-failed");
    assert.match(failed.error.message, /JSON-compatible/);
    assert.equal(invoked, false);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("an oversized program error fails one execution without closing the runtime", async () => {
  const driver: RuntimeDriver<Record<string, never>> = {
    description: "in-memory JavaScript",
    async loadTypeDefinitionFiles() {
      return [];
    },
    async connect() {
      return createInMemoryConnection((execute) => execute());
    },
  };
  const runtime = await createRuntimeFactory(driver)(
    {},
    AbortSignal.timeout(5_000),
  );

  try {
    const failed = await runtime.execute({
      source: [
        "export default function () {",
        '  throw new Error("x".repeat(17 * 1024 * 1024));',
        "}",
      ].join("\n"),
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        throw new Error("program must not invoke tools");
      },
      emitOutput() {},
    });
    assert.equal(failed.kind, "program-failed");
    assert.match(failed.error.message, /truncated/);
    assert.ok(failed.error.message.length <= 64 * 1024);
    assert.ok((failed.error.stack?.length ?? 0) <= 128 * 1024);

    assert.deepEqual(await runtime.execute({
      source: "export default function () {}",
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        throw new Error("program must not invoke tools");
      },
      emitOutput() {},
    }), { kind: "success" });
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

function createInMemoryConnection(
  schedule: (execute: () => Promise<void>) => Promise<void>,
): RuntimeConnection {
  const hostToRunner = new TransformStream<Uint8Array, Uint8Array>();
  const runnerToHost = new TransformStream<Uint8Array, Uint8Array>();
  const closed = Promise.withResolvers<void>();
  let disposed = false;

  const runner = startRunner({
    channel: {
      readable: hostToRunner.readable,
      writable: runnerToHost.writable,
    },
    schedule,
    async importModule(request) {
      request.signal.throwIfAborted();
      const encoded = Buffer.from(request.source).toString("base64");
      return import(`data:text/javascript;base64,${encoded}#${crypto.randomUUID()}`);
    },
    createConsole(emit): RunnerConsole {
      return {
        debug: (...values) => emitText("stdout", values),
        error: (...values) => emitText("stderr", values),
        info: (...values) => emitText("stdout", values),
        log: (...values) => emitText("stdout", values),
        warn: (...values) => emitText("stderr", values),
      };

      function emitText(
        stream: RunnerProgramOutput["stream"],
        values: readonly unknown[],
      ): void {
        emit({ stream, text: `${values.join(" ")}\n` });
      }
    },
  }).finally(() => closed.resolve());

  return {
    channel: {
      readable: runnerToHost.readable,
      writable: hostToRunner.writable,
    },
    finished: closed.promise.then(() => ({ kind: "closed" as const })),
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      await hostToRunner.readable.cancel().catch(() => {});
      await runner;
    },
  };
}

function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(4 + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, true);
  frame.set(body, 4);
  return frame;
}
