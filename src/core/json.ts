/** Assert that a tool value can cross the runtime's JSON wire boundary intact. */
export function assertJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Code-mode tool values must be JSON-compatible");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length
        || keys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError("Code-mode tool values must be JSON-compatible");
      }
      for (const item of value) assertJsonValue(item, ancestors);
      return;
    }

    if (
      Object.prototype.toString.call(value) !== "[object Object]"
      || typeof Reflect.get(value, "toJSON") === "function"
    ) {
      throw new TypeError("Code-mode tool values must be JSON-compatible");
    }
    for (const item of Object.values(value)) assertJsonValue(item, ancestors);
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true) {
        throw new TypeError("Code-mode tool values must be JSON-compatible");
      }
    }
  } finally {
    ancestors.delete(value);
  }
}
