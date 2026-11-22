import { isIP } from 'node:net';

function ipv4Value(address: string): bigint {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Value(address: string): bigint {
  let text = address;
  if (text.includes('.')) {
    const split = text.lastIndexOf(':');
    const tail = ipv4Value(text.slice(split + 1));
    text = `${text.slice(0, split)}:${(tail >> 16n).toString(16)}:${(tail & 65535n).toString(16)}`;
  }
  const [left = '', right] = text.split('::');
  const before = left === '' ? [] : left.split(':');
  const after = right === undefined || right === '' ? [] : right.split(':');
  const groups =
    right === undefined
      ? before
      : [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function within(value: bigint, base: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}

const blockedV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const blockedV6: readonly (readonly [string, number])[] = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

/** Literal admission only: mapped addresses are never public input. */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  if (isIP(address) === 4) {
    const value = ipv4Value(address);
    return !blockedV4.some(([base, prefix]) => within(value, ipv4Value(base), prefix, 32));
  }
  if (isIP(address) !== 6) return false;
  const value = ipv6Value(address);
  return (
    within(value, ipv6Value('2000::'), 3, 128) &&
    !blockedV6.some(([base, prefix]) => within(value, ipv6Value(base), prefix, 128))
  );
}

/** Socket equality only; this normalization does not relax literal admission. */
export function sameNetworkAddress(actual: string, expected: string): boolean {
  const value = (address: string): string | undefined => {
    if (address.includes('%')) return undefined;
    if (isIP(address) === 4) return `v4:${ipv4Value(address)}`;
    if (isIP(address) !== 6) return undefined;
    const ip = ipv6Value(address);
    return ip >> 32n === 65535n ? `v4:${ip & 0xffffffffn}` : `v6:${ip}`;
  };
  const left = value(actual);
  return left !== undefined && left === value(expected);
}
