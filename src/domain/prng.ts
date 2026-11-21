/**
 * A small seeded random source. Pure and platform-free, so a seed means the
 * same numbers in the browser, the Worker and the tests.
 */

/** 32-bit FNV-1a of a string, finished with the murmur3 mixer so nearby seeds diverge. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** mulberry32: a float in [0, 1) per call, fully determined by the 32-bit state. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rng = {
  /** Float in [0, 1). */
  next(): number
  /** Integer in [lo, hi], inclusive. */
  int(lo: number, hi: number): number
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T
  /** A shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[]
}

export function rng(seed: string): Rng {
  const next = mulberry32(hashSeed(seed))
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  return {
    next,
    int,
    pick: (items) => items[int(0, items.length - 1)],
    shuffle: (items) => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i)
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
  }
}
