/**
 * Serializes best-effort publication of versioned snapshots so that the last
 * write is always the newest one.
 *
 * Writes never overlap: while one is in flight, newer submissions only replace
 * the single pending snapshot, and the drain loop publishes the latest when
 * the write finishes. A snapshot whose version is not above the highest one
 * already published is dropped. The write must be a plain overwrite; ordering
 * comes from there being only one in flight at a time.
 */
export type Versioned = { version: number }

export type Publisher<T extends Versioned> = {
  /** Queues `snapshot`. The promise settles when the publisher is idle; it never rejects. */
  submit(snapshot: T): Promise<void>
  /** Highest version successfully written, or -1. */
  published(): number
}

export function createPublisher<T extends Versioned>(
  write: (snapshot: T) => Promise<void>,
  options: { attempts?: number; onError?: (e: unknown) => void } = {},
): Publisher<T> {
  const attempts = options.attempts ?? 3
  let publishedVersion = -1
  let pending: T | null = null
  let draining: Promise<void> | null = null

  async function drain() {
    while (pending && pending.version > publishedVersion) {
      const next = pending
      pending = null
      for (let i = 0; i < attempts; i++) {
        try {
          await write(next)
          publishedVersion = next.version
          break
        } catch (e) {
          // Best effort: the next commit publishes again.
          if (i === attempts - 1) options.onError?.(e)
        }
      }
    }
  }

  return {
    submit(snapshot) {
      if (snapshot.version > publishedVersion && (!pending || snapshot.version > pending.version))
        pending = snapshot
      draining ??= drain().finally(() => {
        draining = null
      })
      return draining
    },
    published: () => publishedVersion,
  }
}
