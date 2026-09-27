/** Pressed keys by `KeyboardEvent.code`, cleared when the window loses focus. */
export class Keyboard {
  readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly abort = new AbortController();

  constructor(target: Window = window, private readonly ignoreWhileTyping = true) {
    const signal = this.abort.signal;
    target.addEventListener('keydown', event => {
      if (this.ignoreWhileTyping && isTyping(event)) return;
      if (!event.repeat) this.pressed.add(event.code);
      this.down.add(event.code);
    }, { signal });
    target.addEventListener('keyup', event => { this.down.delete(event.code); }, { signal });
    target.addEventListener('blur', () => { this.down.clear(); }, { signal });
  }

  /** -1, 0 or 1 from two key sets, e.g. `axis(['KeyA','ArrowLeft'], ['KeyD','ArrowRight'])`. */
  axis(negative: string[], positive: string[]) {
    return (positive.some(code => this.down.has(code)) ? 1 : 0) - (negative.some(code => this.down.has(code)) ? 1 : 0);
  }

  /** True once per physical press; call every frame. */
  consume(code: string) {
    const hit = this.pressed.has(code);
    this.pressed.delete(code);
    return hit;
  }

  dispose() { this.abort.abort(); this.down.clear(); }
}

export function isTyping(event: Event) {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** Pointer position in normalised device coordinates plus button state over an element. */
export class Pointer {
  x = 0;
  y = 0;
  inside = false;
  readonly buttons = new Set<number>();
  private readonly pressed = new Set<number>();
  private readonly abort = new AbortController();

  constructor(private readonly element: HTMLElement) {
    const signal = this.abort.signal;
    element.addEventListener('pointermove', event => this.move(event), { signal });
    element.addEventListener('pointerdown', event => { this.move(event); this.buttons.add(event.button); this.pressed.add(event.button); }, { signal });
    window.addEventListener('pointerup', event => { this.buttons.delete(event.button); }, { signal });
    element.addEventListener('pointerleave', () => { this.inside = false; }, { signal });
    element.addEventListener('contextmenu', event => event.preventDefault(), { signal });
    window.addEventListener('blur', () => { this.buttons.clear(); }, { signal });
  }

  private move(event: PointerEvent) {
    const rect = this.element.getBoundingClientRect();
    this.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.inside = true;
  }

  consume(button: number) {
    const hit = this.pressed.has(button);
    this.pressed.delete(button);
    return hit;
  }

  dispose() { this.abort.abort(); this.buttons.clear(); }
}
