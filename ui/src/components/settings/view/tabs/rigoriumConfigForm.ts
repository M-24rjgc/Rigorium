type Path = readonly (string | number)[];

type CronConfigShape = {
  cron?: {
    enabled?: boolean;
  };
};

/** Provider ids supported by the webSearch tool configuration form. */
export type WebSearchProvider = 'glm' | 'tavily' | 'custom';

export type WebSearchConfigShape = {
  provider?: string;
  apiKey?: string;
  endpoint?: string;
  customProvider?: Record<string, string>;
};

export const GLM_DEFAULT_ENDPOINT = 'https://api.z.ai/api/paas/v4/web_search';

/**
 * Switch the webSearch provider while MERGING the existing config — switching
 * must never silently drop the saved apiKey / customProvider mapping / a
 * user-set endpoint (that would erase credentials from rigorium.yaml).
 * The auto-injected glm default endpoint is dropped when leaving glm so the
 * next provider doesn't inherit a stale URL.
 */
export function switchWebSearchProvider(
  current: WebSearchConfigShape | undefined,
  nextProvider: WebSearchProvider,
): WebSearchConfigShape {
  const next: WebSearchConfigShape = { ...(current ?? {}), provider: nextProvider };
  if (nextProvider === 'glm') {
    // glm needs its endpoint; keep a user-set one, else auto-default.
    next.endpoint = next.endpoint || GLM_DEFAULT_ENDPOINT;
  } else if (next.endpoint === GLM_DEFAULT_ENDPOINT) {
    // Leaving glm: drop the auto-injected default URL so the other provider
    // doesn't inherit a stale glm endpoint. A user-customized endpoint
    // (different from the glm default) is preserved.
    delete next.endpoint;
  }
  return next;
}

export function patch<T>(config: T, path: Path, value: unknown): T {
  // Immutable deep set. Each key cloned along the way so React picks up the
  // change. Numeric segments materialise arrays; everything else materialises
  // objects.
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const isArrayKey = typeof head === 'number';
  const current: any = config ?? (isArrayKey ? [] : {});
  const next: any = isArrayKey ? [...(current as unknown[])] : { ...(current as object) };
  next[head as string | number] = rest.length === 0
    ? value
    : patch(
        current?.[head as string | number] ?? (typeof rest[0] === 'number' ? [] : {}),
        rest,
        value,
      );
  return next as T;
}

export function isCronConfigEnabled(config: CronConfigShape): boolean {
  return config.cron !== undefined && config.cron.enabled !== false;
}
