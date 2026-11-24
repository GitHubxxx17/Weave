import { describe, expect, it } from 'vitest';
import { isTrustedSender } from '../src/sender-origin.js';

const origin = 'http://127.0.0.1:5173';

function eventFor(frame: { url: string; origin: string }, pageUrl: string = frame.url) {
  return { senderFrame: frame, sender: { getURL: () => pageUrl, mainFrame: frame } };
}

describe('isTrustedSender', () => {
  it('trusts the main frame whose origin, URL and window page all match', () => {
    expect(isTrustedSender(eventFor({ url: `${origin}/app`, origin }), origin)).toBe(true);
  });

  it('rejects a same-origin child frame', () => {
    const frame = { url: `${origin}/child`, origin };
    const main = { url: `${origin}/`, origin };
    expect(
      isTrustedSender(
        { senderFrame: frame, sender: { getURL: () => `${origin}/`, mainFrame: main } },
        origin,
      ),
    ).toBe(false);
  });

  it('rejects when the window page is no longer on the trusted origin', () => {
    const frame = { url: `${origin}/`, origin };
    expect(isTrustedSender(eventFor(frame, 'https://evil.example/'), origin)).toBe(false);
  });

  it('rejects an event without a sender or with an unparsable page URL', () => {
    const frame = { url: `${origin}/`, origin };
    expect(isTrustedSender({ senderFrame: frame }, origin)).toBe(false);
    expect(isTrustedSender({ senderFrame: frame, sender: null }, origin)).toBe(false);
    expect(isTrustedSender(eventFor(frame, 'not a url'), origin)).toBe(false);
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
