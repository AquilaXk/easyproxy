const DEFAULT_MAX_CLONE_DEPTH = 128;
const DEFAULT_MAX_CLONE_NODES = 100_000;

export interface CopyOnWriteSegment {
  container: object;
  key: string | number;
}

export function isPlainCloneableRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canWriteProperty(container: object, key: PropertyKey): boolean {
  if (Object.isFrozen(container)) return false;
  const desc = Object.getOwnPropertyDescriptor(container, key);
  if (desc !== undefined) {
    return desc.writable === true || typeof desc.set === "function";
  }
  return Object.isExtensible(container);
}

export function writePropertySafe(container: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(container, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    container[key] = value;
  }
}

export function shallowCloneMutableContainer<T extends object>(container: T): T {
  if (Array.isArray(container)) {
    return [...container] as unknown as T;
  }
  const proto = Object.getPrototypeOf(container);
  const out = (proto === null ? Object.create(null) : {}) as Record<string, unknown>;
  for (const key of Object.keys(container)) {
    writePropertySafe(out, key, (container as Record<string, unknown>)[key]);
  }
  return out as T;
}

export interface BoundedMutableCloneResult {
  value: unknown;
  limitExceeded: boolean;
}

/**
 * Iteratively deep-clones arrays and plain objects up to strict node and depth bounds,
 * preserving cycles via a WeakMap and leaving non-plain objects untouched.
 * Fails closed by returning the original root reference when limits are exceeded.
 */
export function cloneMutableJsonGraph(
  root: unknown,
  maxNodes = DEFAULT_MAX_CLONE_NODES,
  maxDepth = DEFAULT_MAX_CLONE_DEPTH,
): BoundedMutableCloneResult {
  if (typeof root !== "object" || root === null) {
    return { value: root, limitExceeded: false };
  }
  if (!Array.isArray(root) && !isPlainCloneableRecord(root)) {
    return { value: root, limitExceeded: false };
  }

  const seen = new WeakMap<object, object>();
  const makeShell = (src: object): object => {
    if (Array.isArray(src)) return new Array<unknown>(src.length);
    return Object.getPrototypeOf(src) === null ? Object.create(null) : {};
  };

  const clonedRoot = makeShell(root);
  seen.set(root, clonedRoot);
  const stack: Array<{ src: object; dst: object; depth: number }> = [{ src: root, dst: clonedRoot, depth: 0 }];
  let nodes = 1;

  while (stack.length > 0) {
    const { src, dst, depth } = stack.pop()!;
    if (depth > maxDepth) {
      return { value: root, limitExceeded: true };
    }
    if (Array.isArray(src)) {
      const dstArr = dst as unknown[];
      for (let i = 0; i < src.length; i += 1) {
        nodes += 1;
        if (nodes > maxNodes) return { value: root, limitExceeded: true };
        const child = src[i];
        if (typeof child === "object" && child !== null && (Array.isArray(child) || isPlainCloneableRecord(child))) {
          if (depth + 1 > maxDepth) return { value: root, limitExceeded: true };
          let clonedChild = seen.get(child);
          if (!clonedChild) {
            clonedChild = makeShell(child);
            seen.set(child, clonedChild);
            stack.push({ src: child, dst: clonedChild, depth: depth + 1 });
          }
          dstArr[i] = clonedChild;
        } else {
          dstArr[i] = child;
        }
      }
      continue;
    }

    const srcRec = src as Record<string, unknown>;
    const dstRec = dst as Record<string, unknown>;
    for (const key of Object.keys(srcRec)) {
      nodes += 1;
      if (nodes > maxNodes) return { value: root, limitExceeded: true };
      const child = srcRec[key];
      if (typeof child === "object" && child !== null && (Array.isArray(child) || isPlainCloneableRecord(child))) {
        if (depth + 1 > maxDepth) return { value: root, limitExceeded: true };
        let clonedChild = seen.get(child);
        if (!clonedChild) {
          clonedChild = makeShell(child);
          seen.set(child, clonedChild);
          stack.push({ src: child, dst: clonedChild, depth: depth + 1 });
        }
        writePropertySafe(dstRec, key, clonedChild);
      } else {
        writePropertySafe(dstRec, key, child);
      }
    }
  }

  return { value: clonedRoot, limitExceeded: false };
}

function readContainerProperty(container: object, key: string | number): unknown {
  if (Array.isArray(container)) return container[key as number];
  return (container as Record<string, unknown>)[String(key)];
}

function writeContainerProperty(container: object, key: string | number, value: unknown): void {
  if (Array.isArray(container)) container[key as number] = value;
  else writePropertySafe(container as Record<string, unknown>, String(key), value);
}

/**
 * Writes along a container path, mutating directly when writable and falling back to
 * shallow copy-on-write cloning whenever any ancestor or target container is frozen,
 * sealed/non-extensible, or holds a non-writable property.
 */
export class CopyOnWriteMutator {
  public root: unknown;
  private readonly rootProtected: boolean;
  private readonly clones = new WeakMap<object, object>();
  private readonly createdClones = new WeakSet<object>();
  private readonly protectedChildrenOf = new WeakSet<object>();
  private cloneCount = 0;

  constructor(root: unknown) {
    this.root = root;
    this.rootProtected = typeof root === "object" && root !== null && (Object.isFrozen(root) || !Object.isExtensible(root));
  }

  get hasClones(): boolean {
    return this.cloneCount > 0;
  }

  resolve<T extends object>(obj: T): T {
    return (this.clones.get(obj) as T | undefined) ?? obj;
  }

  write(path: readonly CopyOnWriteSegment[], value: unknown): void {
    if (path.length === 0) return;

    let subtreeProtected = this.rootProtected;
    let firstCloneIdx = -1;
    let needsRelink = false;

    for (let i = 0; i < path.length; i += 1) {
      const seg = path[i]!;
      const cur = this.resolve(seg.container);
      const isOurClone = this.createdClones.has(cur);
      if (!isOurClone && (Object.isFrozen(cur) || !Object.isExtensible(cur))) {
        subtreeProtected = true;
      }
      const needsClone = (!isOurClone && subtreeProtected)
        || (i === path.length - 1 && !canWriteProperty(cur, seg.key));
      if (needsClone && firstCloneIdx === -1) {
        firstCloneIdx = i;
      }
      if (i > 0 && cur !== seg.container) {
        const prevSeg = path[i - 1]!;
        const prevCur = this.resolve(prevSeg.container);
        if (readContainerProperty(prevCur, prevSeg.key) !== cur) {
          needsRelink = true;
          if (!canWriteProperty(prevCur, prevSeg.key) && (firstCloneIdx === -1 || firstCloneIdx > i - 1)) {
            firstCloneIdx = i - 1;
          }
        }
      }
      if (this.protectedChildrenOf.has(cur)) {
        subtreeProtected = true;
      }
    }

    if (firstCloneIdx === -1 && !needsRelink) {
      const leafSeg = path[path.length - 1]!;
      writeContainerProperty(this.resolve(leafSeg.container), leafSeg.key, value);
      return;
    }

    if (firstCloneIdx !== -1) {
      // Ensure the parent receiving the first clone can accept a property write.
      while (firstCloneIdx > 0) {
        const parentSeg = path[firstCloneIdx - 1]!;
        const parentCur = this.resolve(parentSeg.container);
        if (canWriteProperty(parentCur, parentSeg.key)) break;
        firstCloneIdx -= 1;
      }
    }

    let propagateProtected = this.rootProtected;
    for (let i = 0; i < path.length; i += 1) {
      const seg = path[i]!;
      const cur = this.resolve(seg.container);
      const isOurClone = this.createdClones.has(cur);
      if (!isOurClone && (Object.isFrozen(cur) || !Object.isExtensible(cur))) {
        propagateProtected = true;
      }
      if (firstCloneIdx !== -1 && i >= firstCloneIdx && !isOurClone) {
        const mutable = shallowCloneMutableContainer(cur);
        this.clones.set(seg.container, mutable);
        this.clones.set(cur, mutable);
        this.createdClones.add(mutable);
        this.cloneCount += 1;
        if (propagateProtected) {
          this.protectedChildrenOf.add(mutable);
        }
        if (i === 0) {
          this.root = mutable;
        } else {
          const prevSeg = path[i - 1]!;
          const prevMutable = this.resolve(prevSeg.container);
          writeContainerProperty(prevMutable, prevSeg.key, mutable);
        }
      } else {
        if (i > 0) {
          const prevSeg = path[i - 1]!;
          const prevMutable = this.resolve(prevSeg.container);
          if (cur !== seg.container && readContainerProperty(prevMutable, prevSeg.key) !== cur) {
            writeContainerProperty(prevMutable, prevSeg.key, cur);
          }
        }
        if (this.protectedChildrenOf.has(cur)) {
          propagateProtected = true;
        }
      }
    }

    const leafSeg = path[path.length - 1]!;
    writeContainerProperty(this.resolve(leafSeg.container), leafSeg.key, value);
  }
}
