import { rm, writeFile } from "node:fs/promises";

import { runnerSource } from "../dist/runner/source.js";

const output = [
  "/**",
  " * Self-contained ESM source exporting `startRunner()` for environments that",
  " * cannot preinstall `@torkbot/code-mode/runner`.",
  " */",
  `export const runnerSource = ${JSON.stringify(runnerSource)};`,
  "",
].join("\n");

await writeFile(new URL("../dist/runner/source.js", import.meta.url), output);
await rm(new URL("../dist/runner/source.js.map", import.meta.url), { force: true });
