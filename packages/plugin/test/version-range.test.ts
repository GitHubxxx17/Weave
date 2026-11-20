import { describe, expect, it } from 'vitest';

import { isValidVersionRange, parseVersion, parseVersionRange } from '../src/version-range.js';

function satisfies(version: string, range: string): boolean {
  return parseVersionRange(range).test(version);
}

describe('parseVersion', () => {
  it('parses a full numeric x.y.z', () => {
    expect(parseVersion('1.20.3')).toEqual([1, 20, 3]);
  });

  it.each([
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '1.2.3-beta.1',
    '1.2.x',
    '',
    ' 1.2.3',
    '1.2.99999999999999999',
  ])('rejects %j', (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });
});

describe('parseVersionRange', () => {
  it.each(['*', 'x', 'X'])('%s accepts any version', (range) => {
    expect(satisfies('0.0.1', range)).toBe(true);
    expect(satisfies('99.99.99', range)).toBe(true);
  });

  it('matches an exact version with or without =', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
  });

  it.each([
    ['>=1.2.3', '1.2.3', true],
    ['>=1.2.3', '1.2.2', false],
    ['>=1.2.3', '2.0.0', true],
    ['>1.2.3', '1.2.3', false],
    ['>1.2.3', '1.2.4', true],
    ['<1.2.3', '1.2.2', true],
    ['<1.2.3', '1.2.3', false],
    ['<=1.2.3', '1.2.3', true],
    ['<=1.2.3', '1.2.4', false],
  ])('compares %s against %s', (range, version, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it.each([
    ['^1.2.3', '1.2.3', true],
    ['^1.2.3', '1.9.9', true],
    ['^1.2.3', '1.2.2', false],
    ['^1.2.3', '2.0.0', false],
    ['^0.2.3', '0.2.9', true],
    ['^0.2.3', '0.3.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
  ])('caret %s against %s', (range, version, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it.each([
    ['~1.2.3', '1.2.3', true],
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    ['~1.2.3', '1.2.2', false],
  ])('tilde %s against %s', (range, version, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it.each([
    ['1.x', '1.0.0', true],
    ['1.x', '1.9.9', true],
    ['1.x', '2.0.0', false],
    ['1.x', '0.9.9', false],
    ['1.*', '1.4.0', true],
    ['1.2.x', '1.2.0', true],
    ['1.2.X', '1.2.7', true],
    ['1.2.x', '1.3.0', false],
  ])('wildcard %s against %s', (range, version, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('requires every space-separated comparator to hold', () => {
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.2.0 <2.0.0')).toBe(false);
    expect(satisfies('1.1.9', '>=1.2.0 <2.0.0')).toBe(false);
    expect(satisfies('1.5.0', '  >=1.2.0   <2.0.0  ')).toBe(true);
  });

  it('refuses to test a version that is not a full x.y.z', () => {
    expect(() => satisfies('1.2', '>=1.0.0')).toThrowError(RangeError);
  });
});

describe('isValidVersionRange', () => {
  it.each(['*', '1.x', '1.2.x', '1.2.3', '>=1.2.3', '^1.2.3', '~1.2.3', '>=1.2.0 <2.0.0'])(
    'accepts %j',
    (range) => {
      expect(isValidVersionRange(range)).toBe(true);
    },
  );

  it.each([
    '',
    '   ',
    '1',
    '1.2',
    '>=1.2',
    '^1',
    '>= 1.2.3',
    '1.0.0 || 2.0.0',
    '1.0.0 - 2.0.0',
    '1.2.3-beta.1',
    'latest',
    '>=1.2.3 foo',
    '>=>1.2.3',
  ])('rejects %j instead of guessing', (range) => {
    expect(isValidVersionRange(range)).toBe(false);
    expect(() => parseVersionRange(range)).toThrowError(RangeError);
  });
});
