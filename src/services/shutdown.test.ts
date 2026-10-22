import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { createShutdown } from './shutdown.js';

const log = pino({ level: 'silent' });

describe('shutdown', () => {
  it('runs steps in order once, then exits', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const s = createShutdown(log, { exit: exit as never });
    s.add({ name: 'flush', run: () => void order.push('flush') });
    s.add({ name: 'discord', run: () => void order.push('discord') });
    s.add({ name: 'leader', run: () => void order.push('leader') });

    await Promise.all([s.run('SIGTERM'), s.run('SIGINT')]);
    expect(order).toEqual(['flush', 'discord', 'leader']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps going after a failed step and exits non-zero', async () => {
    const exit = vi.fn();
    const ran: string[] = [];
    const s = createShutdown(log, { exit: exit as never });
    s.add({ name: 'bad', run: () => Promise.reject(new Error('boom')) });
    s.add({ name: 'leader', run: () => void ran.push('leader') });
    await s.run('SIGTERM');
    expect(ran).toEqual(['leader']);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
