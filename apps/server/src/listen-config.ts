import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import { generateAccessToken, parseAccessToken } from './access-token.js';
import {
  createTrustedHost,
  isLoopbackListenHost,
  isWildcardListenHost,
} from './local-authority.js';

export const defaultListenHost = '127.0.0.1';
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]-]+$/, 'host must be a hostname or IP address');

export interface ListenConfig {
  readonly host: string;
  /** True when the Server listens beyond loopback and therefore requires a token. */
  readonly exposed: boolean;
  readonly accessToken?: string;
}

/**
 * Resolves the listen address and, for non-loopback addresses, the access
 * token (`WEAVE_ACCESS_TOKEN` or a fresh random one). Loopback listeners never
 * get a token, so their behavior is unchanged.
 */
export function resolveListenConfig(input: {
  readonly host?: string | undefined;
  readonly accessToken?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): ListenConfig {
  const host = hostSchema.parse(input.host ?? defaultListenHost);
  if (isLoopbackListenHost(host)) return { host, exposed: false };
  const configured = input.accessToken ?? input.environment?.WEAVE_ACCESS_TOKEN;
  const accessToken =
    configured === undefined || configured === ''
      ? generateAccessToken()
      : parseAccessToken(configured);
  return { host, exposed: true, accessToken };
}

/** Reads `--host <address>` / `--host=<address>` from argv, then `WEAVE_HOST`. */
export function readHostSetting(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--host') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--host requires an address');
      return value;
    }
    if (argument?.startsWith('--host=') === true) return argument.slice('--host='.length);
  }
  const fromEnvironment = environment.WEAVE_HOST?.trim();
  return fromEnvironment === undefined || fromEnvironment === '' ? undefined : fromEnvironment;
}

/** The `Host` value the guards trust, or `undefined` for loopback listeners. */
export function trustedHostFor(config: ListenConfig, port: number): string | undefined {
  return config.exposed ? createTrustedHost(config.host, port) : undefined;
}

function reachableAddress(host: string): string {
  if (!isWildcardListenHost(host))
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return 'localhost';
}

/** The URL to print at startup: includes the token so one click opens Studio. */
export function formatAccessUrl(config: ListenConfig, port: number): string | undefined {
  if (!config.exposed || config.accessToken === undefined) return undefined;
  return `http://${reachableAddress(config.host)}:${port}/?token=${config.accessToken}`;
}
