import { describe, expect, it } from 'vitest';
import { isTrustedSender } from '../src/sender-origin.js';

const origin = 'http://127.0.0.1:5173';

describe('isTrustedSender', () => {
  it('trusts a frame whose origin and URL both match', () => {
    expect(isTrustedSender({ senderFrame: { url: `${origin}/app`, origin } }, origin)).toBe(true);
  });

  it.each([
    {
      name: 'a different origin',
      frame: { url: 'https://evil.example/', origin: 'https://evil.example' },
    },
    {
      name: 'a matching URL but different frame origin',
      frame: { url: `${origin}/`, origin: 'http://127.0.0.1:1' },
    },
    {
      name: 'a matching frame origin but different URL',
      frame: { url: 'https://evil.example/', origin },
    },
    { name: 'an opaque origin', frame: { url: `${origin}/`, origin: 'null' } },
    { name: 'a missing origin', frame: { url: `${origin}/` } },
    { name: 'an invalid URL', frame: { url: 'not a url', origin } },
    { name: 'a null frame', frame: null },
    { name: 'an undefined frame', frame: undefined },
  ])('rejects $name', ({ frame }) => {
    expect(isTrustedSender({ senderFrame: frame }, origin)).toBe(false);
  });
});
