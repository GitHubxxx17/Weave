import { describe, expect, it } from 'vitest';
import { createRuntime } from '@weave/runtime';
import { createApp } from '../src/app.js';

describe('GET /health', () => {
  it('returns running runtime health', async () => {
    const runtime = createRuntime();
    await runtime.start();

    const response = await createApp(runtime).request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      runtime: 'running',
    });

    await runtime.stop();
  });

  it('returns an unavailable response before runtime starts', async () => {
    const runtime = createRuntime();
    const response = await createApp(runtime).request('/health');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      runtime: 'created',
    });
  });
});
