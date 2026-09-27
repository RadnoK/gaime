import { Keyboard, Pointer } from './input';

/**
 * Bindings:
 *   'KeyW', 'Space', 'ArrowLeft' …   KeyboardEvent.code
 *   'Mouse0' / 'Mouse1' / 'Mouse2'   left / middle / right button
 *   'Pad:A' … see PAD_BUTTONS        standard gamepad buttons
 *   'Touch:<name>'                   on-screen button from TouchControls
 */
export type Binding = string;

export interface AxisBinding {
  up?: Binding[];
  down?: Binding[];
  left?: Binding[];
  right?: Binding[];
  /** Gamepad stick feeding this axis. */
  stick?: 'left' | 'right';
  /** On-screen joystick name feeding this axis (TouchControls). */
  touch?: string;
}

export interface ControlsOptions<A extends string, X extends string> {
  /** Element that receives pointer input (usually the canvas container). */
  element: HTMLElement;
  actions: Record<A, Binding[]>;
  axes?: Record<X, AxisBinding>;
  /** Stick dead zone. Default 0.15. */
  deadZone?: number;
}

export const PAD_BUTTONS: Record<string, number> = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, Back: 8, Start: 9, LS: 10, RS: 11, Up: 12, Down: 13, Left: 14, Right: 15,
};

/** WASD + arrows, the usual movement axis. */
export const WASD: AxisBinding = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], stick: 'left', touch: 'move' };

/**
 * One input layer for keyboard, mouse, gamepad and touch, expressed as named actions
 * and axes. Call `update()` once per frame, then read `down`, `pressed` and `axis`.
 *
 *   const controls = new Controls({ element, actions: { fire: ['Mouse0', 'Pad:RT', 'Touch:fire'], dash: ['KeyQ', 'Pad:A'] }, axes: { move: WASD } });
 *   stage.onFrame(() => { controls.update(); const { x, y } = controls.axis('move'); if (controls.pressed('dash')) … });
 */
export class Controls<A extends string = string, X extends string = string> {
  readonly keyboard: Keyboard;
  readonly pointer: Pointer;
  /** Virtual state written by TouchControls. */
  readonly touch = { buttons: new Set<string>(), sticks: new Map<string, { x: number; y: number }>() };
  /** Last input device used — handy for showing the right prompts. */
  device: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';
  private readonly previous = new Set<string>();
  private readonly edges = new Set<string>();
  private pad?: Gamepad;

  constructor(private readonly options: ControlsOptions<A, X>) {
    this.keyboard = new Keyboard();
    this.pointer = new Pointer(options.element);
  }

  private binding(binding: Binding): boolean {
    if (binding.startsWith('Mouse')) return this.pointer.buttons.has(Number(binding.slice(5)));
    if (binding.startsWith('Pad:')) {
      const button = this.pad?.buttons[PAD_BUTTONS[binding.slice(4)] ?? -1];
      return !!button && (button.pressed || button.value > 0.5);
    }
    if (binding.startsWith('Touch:')) return this.touch.buttons.has(binding.slice(6));
    return this.keyboard.down.has(binding);
  }

  /** Poll gamepads and compute this frame's presses. */
  update() {
    this.pad = navigator.getGamepads?.().find((pad): pad is Gamepad => !!pad && pad.connected) ?? undefined;
    if (this.pad?.buttons.some(button => button.pressed) || (this.pad && this.pad.axes.some(value => Math.abs(value) > 0.5))) this.device = 'gamepad';
    else if (this.touch.buttons.size || [...this.touch.sticks.values()].some(s => s.x || s.y)) this.device = 'touch';
    else if (this.keyboard.down.size || this.pointer.buttons.size) this.device = 'keyboard';
    this.edges.clear();
    for (const [action, bindings] of Object.entries(this.options.actions) as Array<[A, Binding[]]>) {
      const down = bindings.some(binding => this.binding(binding));
      // Taps shorter than a frame are caught by the keyboard/pointer press buffers.
      const tapped = bindings.some(binding => (binding.startsWith('Mouse') ? this.pointer.consume(Number(binding.slice(5))) : !binding.includes(':') && this.keyboard.consume(binding)));
      if ((down && !this.previous.has(action)) || tapped) this.edges.add(action);
      if (down) this.previous.add(action); else this.previous.delete(action);
    }
  }

  /** Held right now. */
  down(action: A) { return this.previous.has(action); }

  /** Became pressed this frame (after `update()`). */
  pressed(action: A) { return this.edges.has(action); }

  /** Axis value: x = right, y = up/forward, each -1..1, length ≤ 1. */
  axis(name: X): { x: number; y: number } {
    const binding = this.options.axes?.[name];
    if (!binding) return { x: 0, y: 0 };
    const any = (list?: Binding[]) => !!list?.some(b => this.binding(b));
    let x = (any(binding.right) ? 1 : 0) - (any(binding.left) ? 1 : 0);
    let y = (any(binding.up) ? 1 : 0) - (any(binding.down) ? 1 : 0);
    const dead = this.options.deadZone ?? 0.15;
    if (binding.stick && this.pad) {
      const [sx, sy] = binding.stick === 'left' ? [this.pad.axes[0] ?? 0, this.pad.axes[1] ?? 0] : [this.pad.axes[2] ?? 0, this.pad.axes[3] ?? 0];
      if (Math.hypot(sx, sy) > dead) { x = sx; y = -sy; }
    }
    const stick = binding.touch ? this.touch.sticks.get(binding.touch) : undefined;
    if (stick && (stick.x || stick.y)) { x = stick.x; y = stick.y; }
    const length = Math.hypot(x, y);
    return length > 1 ? { x: x / length, y: y / length } : { x, y };
  }

  /** Short rumble on gamepads that support it. */
  rumble(strength = 0.5, ms = 120) {
    const actuator = (this.pad as Gamepad & { vibrationActuator?: { playEffect?(type: string, params: object): Promise<unknown> } } | undefined)?.vibrationActuator;
    void actuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength });
  }

  dispose() {
    this.keyboard.dispose();
    this.pointer.dispose();
  }
}

export interface TouchControlsOptions {
  /** Joystick names (axis `touch` binding). First is on the left, second on the right. */
  sticks?: string[];
  /** Buttons (action binding `Touch:<name>`), stacked bottom-right. */
  buttons?: Array<{ name: string; label: string }>;
  /** Show only on touch devices. Default true. */
  auto?: boolean;
}

/** On-screen joysticks and buttons feeding a `Controls` instance. */
export class TouchControls {
  readonly root: HTMLElement;
  private readonly abort = new AbortController();

  constructor(parent: HTMLElement, private readonly controls: Controls, options: TouchControlsOptions = {}) {
    this.root = document.createElement('div');
    this.root.className = 'g-touch';
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.root.hidden = (options.auto ?? true) && !coarse;
    const signal = this.abort.signal;
    (options.sticks ?? []).forEach((name, index) => {
      const pad = document.createElement('div');
      pad.className = `g-stick ${index ? 'g-stick-right' : 'g-stick-left'}`;
      const knob = document.createElement('div');
      knob.className = 'g-knob';
      pad.append(knob);
      let pointer = -1;
      const move = (event: PointerEvent) => {
        const rect = pad.getBoundingClientRect();
        const radius = rect.width / 2;
        let x = (event.clientX - rect.left - radius) / radius;
        let y = -(event.clientY - rect.top - radius) / radius;
        const length = Math.hypot(x, y);
        if (length > 1) { x /= length; y /= length; }
        controls.touch.sticks.set(name, { x, y });
        knob.style.transform = `translate(${x * radius * 0.6}px, ${-y * radius * 0.6}px)`;
      };
      const release = () => { pointer = -1; controls.touch.sticks.set(name, { x: 0, y: 0 }); knob.style.transform = ''; };
      pad.addEventListener('pointerdown', event => { pointer = event.pointerId; pad.setPointerCapture(pointer); move(event); event.preventDefault(); }, { signal });
      pad.addEventListener('pointermove', event => { if (event.pointerId === pointer) move(event); }, { signal });
      pad.addEventListener('pointerup', release, { signal });
      pad.addEventListener('pointercancel', release, { signal });
      this.root.append(pad);
    });
    const column = document.createElement('div');
    column.className = 'g-touch-buttons';
    for (const button of options.buttons ?? []) {
      const element = document.createElement('button');
      element.className = 'g-touch-button';
      element.textContent = button.label;
      const on = (event: Event) => { controls.touch.buttons.add(button.name); event.preventDefault(); };
      const off = () => controls.touch.buttons.delete(button.name);
      element.addEventListener('pointerdown', on, { signal });
      element.addEventListener('pointerup', off, { signal });
      element.addEventListener('pointercancel', off, { signal });
      element.addEventListener('pointerleave', off, { signal });
      column.append(element);
    }
    this.root.append(column);
    parent.append(this.root);
  }

  show(visible = true) { this.root.hidden = !visible; }

  dispose() {
    this.abort.abort();
    this.controls.touch.buttons.clear();
    this.controls.touch.sticks.clear();
    this.root.remove();
  }
}
