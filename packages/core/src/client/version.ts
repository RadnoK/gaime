import type { Health } from '../shared/types';

/**
 * Production builds cannot hot-reload: poll `/health` and reload the page once the
 * server reports a new version. Identity and reconnection survive the reload.
 * In dev (Vite / live supervisor) this is a no-op — Vite HMR delivers the new code.
 */
export function watchVersion(options: { interval?: number; onUpdate?: (version: string) => void } = {}): () => void {
  if (!import.meta.env.PROD) return () => {};
  const built = import.meta.env.GAIME_VERSION as string | undefined;
  let known = built && built !== 'LOCAL' ? built : undefined;
  let busy = false;
  let stopped = false;
  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const response = await fetch(`/health?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (!response.ok) return;
      const health = await response.json() as Partial<Health>;
      if (health.ok !== true || typeof health.version !== 'string' || !health.version || health.version === 'LOCAL') return;
      if (!known) { known = health.version; return; }
      if (known === health.version) { sessionStorage.removeItem('gaime:reload'); return; }
      // A stale cached index.html must not trap the tab in a reload loop.
      const key = `${known}->${health.version}`;
      if (sessionStorage.getItem('gaime:reload') === key) return;
      sessionStorage.setItem('gaime:reload', key);
      stopped = true;
      options.onUpdate?.(health.version);
      setTimeout(() => location.reload(), 300);
    } catch {
      // Deploy in progress: keep playing, try again.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void check(), options.interval ?? 3000);
  void check();
  return () => { stopped = true; clearInterval(timer); };
}
