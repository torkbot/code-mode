import { startRunner } from "./index.ts";

/**
 * Self-contained ESM source exporting `startRunner()` for environments that
 * cannot preinstall `@torkbot/code-mode/runner`.
 */
export const runnerSource = `export ${startRunner.toString()}\n`;
