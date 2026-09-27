import { defineWorker } from '../../../../src/worker';

export default defineWorker({
  sum(input: { values: number[] }) { return input.values.reduce((a, b) => a + b, 0); },
  async fail() { throw new Error('intentional failure'); },
  slow() { return new Promise(resolve => setTimeout(resolve, 500)); },
});
