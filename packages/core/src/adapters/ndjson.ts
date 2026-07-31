/** Tolerant NDJSON parsing: returns undefined for non-JSON lines instead of throwing. */
export function tryParseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function getString(obj: unknown, ...path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function getNumber(obj: unknown, ...path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' ? cur : undefined;
}

export function getObject(obj: unknown, ...path: string[]): Record<string, unknown> | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur !== null && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : undefined;
}
