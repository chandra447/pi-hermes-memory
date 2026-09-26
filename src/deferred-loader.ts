/** Coalesce concurrent first uses without permanently caching a rejected load. */
export function createRetryableLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let pending: Promise<T> | undefined;

  return () => {
    if (value !== undefined) return Promise.resolve(value);
    pending ??= load().then((loaded) => {
      value = loaded;
      return loaded;
    }).catch((error) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
