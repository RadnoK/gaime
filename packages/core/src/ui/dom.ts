/** Tiny DOM helpers: no framework, just enough to build a HUD quickly. */

export function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

type Child = Node | string | number | null | undefined | false;
type Attributes = Record<string, string | number | boolean | undefined | ((event: Event) => void)> & { class?: string; style?: string };

/**
 * `h('button', { class: 'g-button', onclick: () => … }, 'Start')` → HTMLButtonElement.
 * `on*` attributes become listeners; `false`/`undefined` attributes and children are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value as EventListener);
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

/**
 * Writes innerHTML / textContent only when it changed — keeps DOM work tiny when a
 * HUD re-renders on every patch (15×/s).
 */
export class Writer {
  private readonly cache = new WeakMap<Element, string>();
  html(element: Element, html: string) {
    if (this.cache.get(element) === html) return;
    this.cache.set(element, html);
    element.innerHTML = html;
  }
  text(element: Element, text: string) {
    if (this.cache.get(element) === `\u0000${text}`) return;
    this.cache.set(element, `\u0000${text}`);
    element.textContent = text;
  }
}

/** A horizontal meter (health, progress). `set(0..1)`. */
export function meter(color = 'var(--g-accent)') {
  const fill = h('i');
  fill.style.background = color;
  const element = h('div', { class: 'g-meter' }, fill);
  return { element, set(value: number) { fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`; } };
}
