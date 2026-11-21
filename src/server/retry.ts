/** Runs `task` up to `attempts` times; resolves true on success, false (never throws) otherwise. */
export async function bestEffort(
  task: () => Promise<unknown>,
  options: { attempts?: number; onError?: (e: unknown) => void } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 3
  for (let i = 0; i < attempts; i++) {
    try {
      await task()
      return true
    } catch (e) {
      if (i === attempts - 1) options.onError?.(e)
    }
  }
  return false
}
