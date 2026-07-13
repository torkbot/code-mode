import assert from "node:assert/strict";
import test from "node:test";

import { settleBeforeAbort } from "./abort.ts";

test("settleBeforeAbort rejects without waiting for a hanging operation", async () => {
  const reason = new Error("cancelled");
  const controller = new AbortController();
  const result = settleBeforeAbort(new Promise<never>(() => {}), controller.signal);

  controller.abort(reason);

  await assert.rejects(result, (error) => error === reason);
});
