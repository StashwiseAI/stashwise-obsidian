/**
 * Guard against out-of-order responses from a debounced search box.
 *
 * Obsidian's `requestUrl` takes no abort signal, so an in-flight search cannot
 * be cancelled when the user keeps typing. Without this, a slow query for "ag"
 * can resolve after a fast query for "agents" and overwrite the fresh results
 * with stale ones. Since we cannot stop the request, we discard its answer.
 *
 * Each call supersedes the previous one. A superseded promise resolves to
 * `null` rather than rejecting, because being outrun is normal, not an error.
 */
export function createLatestOnly<T>(): (work: Promise<T>) => Promise<T | null> {
  let latest = 0;
  return async (work: Promise<T>): Promise<T | null> => {
    const seq = ++latest;
    const value = await work;
    return seq === latest ? value : null;
  };
}
