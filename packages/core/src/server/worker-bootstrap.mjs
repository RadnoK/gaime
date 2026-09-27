// Entry of every gaime worker thread. Plain JS: Node runs it directly.
//  mode "vite": load the TypeScript worker module through the dev server's module runner
//               (same transforms, aliases and hot reload as the game server).
//  mode "node": import a worker bundled by `vite build` (dist/server/workers/<name>.mjs).
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

let handlers;
if (workerData.mode === 'vite') {
  const { ModuleRunner, ESModulesEvaluator, createNodeImportMeta } = await import('vite/module-runner');
  const pending = new Map();
  let seq = 0;
  parentPort.on('message', message => {
    if (message?.kind !== 'invoke-result') return;
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  const runner = new ModuleRunner({
    transport: {
      invoke: payload => new Promise(resolve => {
        const id = ++seq;
        pending.set(id, resolve);
        parentPort.postMessage({ kind: 'invoke', id, payload });
      }),
    },
    createImportMeta: createNodeImportMeta,
    sourcemapInterceptor: 'node',
    hmr: false,
  }, new ESModulesEvaluator());
  handlers = (await runner.import(workerData.entry)).default;
} else {
  handlers = (await import(pathToFileURL(workerData.entry).href)).default;
}

if (!handlers || typeof handlers !== 'object') throw new Error(`${workerData.entry}: missing "export default defineWorker({...})"`);

parentPort.on('message', async message => {
  if (message?.kind !== 'task') return;
  try {
    const handler = handlers[message.task];
    if (typeof handler !== 'function') throw new Error(`Worker "${workerData.name}" has no task "${message.task}". Available: ${Object.keys(handlers).join(', ')}`);
    const result = await handler(message.payload);
    parentPort.postMessage({ kind: 'result', id: message.id, result });
  } catch (error) {
    parentPort.postMessage({ kind: 'error', id: message.id, error: error instanceof Error ? `${error.message}` : String(error) });
  }
});
parentPort.postMessage({ kind: 'ready' });
