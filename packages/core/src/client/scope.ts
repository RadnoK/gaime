/**
 * Collects cleanup functions so a hot-reloaded module can tear everything down in one call.
 *
 *   const scope = new Scope();
 *   scope.add(stage.onFrame(tick));
 *   scope.interval(poll, 500);
 *   scope.listen(window, 'keydown', onKey);
 *   if (import.meta.hot) { import.meta.hot.accept(); import.meta.hot.dispose(() => scope.dispose()); }
 */
export class Scope {
  private readonly cleanups: Array<() => void> = [];
  private readonly abort = new AbortController();

  /** Register a cleanup (or an object with `dispose()`); returns it for chaining. */
  add<T extends (() => unknown) | { dispose(): unknown }>(item: T): T {
    this.cleanups.push(typeof item === 'function' ? () => { item(); } : () => { item.dispose(); });
    return item;
  }

  /** `addEventListener` that is removed on dispose. */
  listen<K extends keyof WindowEventMap>(target: Window, type: K, listener: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, listener: (event: Event) => void, options: AddEventListenerOptions = {}) {
    target.addEventListener(type, listener, { ...options, signal: this.abort.signal });
  }

  interval(callback: () => void, ms: number) {
    const timer = setInterval(callback, ms);
    this.cleanups.push(() => clearInterval(timer));
    return timer;
  }

  timeout(callback: () => void, ms: number) {
    const timer = setTimeout(callback, ms);
    this.cleanups.push(() => clearTimeout(timer));
    return timer;
  }

  dispose() {
    this.abort.abort();
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { cleanup(); } catch (error) { console.error('[gaime] cleanup', error); }
    }
  }
}

/**
 * Keep a value (typically the GameClient) across client hot reloads of the module:
 *   const net = keep(import.meta.hot, 'net', () => new GameClient(...));
 */
export function keep<T>(hot: { data: Record<string, unknown> } | undefined, key: string, create: () => T): T {
  if (!hot) return create();
  return (hot.data[key] ??= create()) as T;
}
