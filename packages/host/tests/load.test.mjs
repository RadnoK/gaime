import { expect, test } from 'vitest';
import { compileTemplate } from '../src/load.mjs';

test('load input templates generate fresh values', () => {
  const next = compileTemplate('{"mx":"$rand","ax":"$rand*25","fire":"$bool","slot":"$int(0,1)","mode":"$pick(a|b)","fixed":3}');
  for (let i = 0; i < 50; i++) {
    const input = next();
    expect(Math.abs(input.mx)).toBeLessThanOrEqual(1);
    expect(Math.abs(input.ax)).toBeLessThanOrEqual(25);
    expect(typeof input.fire).toBe('boolean');
    expect([0, 1]).toContain(input.slot);
    expect(['a', 'b']).toContain(input.mode);
    expect(input.fixed).toBe(3);
  }
});
