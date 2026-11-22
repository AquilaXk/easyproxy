/**
 * Fixed-capacity power-of-two ring buffers using bitmask index wrap (`& mask`)
 * to replace O(N) `Array.shift()` and `Array.splice(0, k)` shifts in hot paths.
 */

function nextPowerOfTwo(minCap: number): number {
  let cap = 1;
  while (cap < minCap) cap <<= 1;
  return cap;
}

export class Float64RingBuffer {
  private readonly buf: Float64Array;
  private readonly mask: number;
  private head = 0;
  private count = 0;

  constructor(minCapacity: number) {
    const cap = nextPowerOfTwo(Math.max(2, minCapacity));
    this.buf = new Float64Array(cap);
    this.mask = cap - 1;
  }

  get length(): number {
    return this.count;
  }

  push(value: number): void {
    const idx = (this.head + this.count) & this.mask;
    this.buf[idx] = value;
    if (this.count <= this.mask) {
      this.count += 1;
    } else {
      this.head = (this.head + 1) & this.mask;
    }
  }

  at(index: number): number | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.buf[(this.head + index) & this.mask];
  }

  pop(): number | undefined {
    if (this.count === 0) return undefined;
    this.count -= 1;
    return this.buf[(this.head + this.count) & this.mask];
  }

  /**
   * Removes the most recent entry equal to `target` while preserving order.
   * Fast-path O(1) when removing the tail element; bounded linear shift otherwise.
   */
  removeLastEqual(target: number): boolean {
    if (this.count === 0) return false;
    const tailOffset = this.count - 1;
    if (this.buf[(this.head + tailOffset) & this.mask] === target) {
      this.count -= 1;
      return true;
    }
    for (let i = tailOffset - 1; i >= 0; i -= 1) {
      if (this.buf[(this.head + i) & this.mask] === target) {
        for (let j = i; j < tailOffset; j += 1) {
          this.buf[(this.head + j) & this.mask] = this.buf[(this.head + j + 1) & this.mask]!;
        }
        this.count -= 1;
        return true;
      }
    }
    return false;
  }

  /** Removes all leading entries `<= cutoff` in strictly non-decreasing timestamp order. */
  pruneLeq(cutoff: number): number {
    let drop = 0;
    while (drop < this.count && this.buf[(this.head + drop) & this.mask]! <= cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      this.head = (this.head + drop) & this.mask;
      this.count -= drop;
    }
    return drop;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

export class ObjectRingBuffer<T> {
  private readonly items: Array<T | undefined>;
  private readonly mask: number;
  private head = 0;
  private count = 0;

  constructor(minCapacity: number) {
    const cap = nextPowerOfTwo(Math.max(2, minCapacity));
    this.items = new Array<T | undefined>(cap);
    this.mask = cap - 1;
  }

  get length(): number {
    return this.count;
  }

  push(item: T): T | undefined {
    const tail = (this.head + this.count) & this.mask;
    if (this.count <= this.mask) {
      this.items[tail] = item;
      this.count += 1;
      return undefined;
    }
    const evicted = this.items[this.head];
    this.items[this.head] = item;
    this.head = (this.head + 1) & this.mask;
    return evicted;
  }

  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const value = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) & this.mask;
    this.count -= 1;
    return value;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
