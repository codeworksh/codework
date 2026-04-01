export function lazy<T>(fn: () => T) {
  let value: T | undefined;
  let loaded = false;

  const result = (): T => {
    if (loaded) return value as T;
    try {
      value = fn();
      loaded = true;
      return value as T;
    } catch (error) {
      // Do not mark the lazy value as loaded if initialization fails.
      throw error;
    }
  };

  result.reset = () => {
    loaded = false;
    value = undefined;
  };

  return result;
}
