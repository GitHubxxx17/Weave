import { safeStorage } from 'electron';
import type { ProviderSecretCodec } from '@weave/server';

export type ElectronProviderSecretCodecErrorCode =
  'provider-settings-secret-unavailable' | 'provider-settings-secret-invalid';

export class ElectronProviderSecretCodecError extends Error {
  readonly code: ElectronProviderSecretCodecErrorCode;

  constructor(code: ElectronProviderSecretCodecErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ElectronProviderSecretCodecError';
    this.code = code;
  }
}

function unavailableError(cause?: unknown): ElectronProviderSecretCodecError {
  return new ElectronProviderSecretCodecError(
    'provider-settings-secret-unavailable',
    '系统密钥存储不可用',
    cause === undefined ? undefined : { cause },
  );
}

function invalidError(cause?: unknown): ElectronProviderSecretCodecError {
  return new ElectronProviderSecretCodecError(
    'provider-settings-secret-invalid',
    'Provider API Key 处理失败',
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Adapts Electron safeStorage to the Server's opaque Provider secret contract.
 *
 * The encrypted value is serialized as Base64 only for transport into SQLite;
 * the plaintext API key remains inside the Electron Main process.
 */
export function createElectronProviderSecretCodec(): ProviderSecretCodec {
  const isAvailable = (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  return {
    isAvailable,

    encrypt(value: string): string {
      if (!isAvailable()) {
        throw unavailableError();
      }
      if (value.length === 0) {
        throw invalidError();
      }

      try {
        return safeStorage.encryptString(value).toString('base64');
      } catch (error: unknown) {
        throw invalidError(error);
      }
    },

    decrypt(value: string): string {
      if (!isAvailable()) {
        throw unavailableError();
      }
      if (value.length === 0) {
        throw invalidError();
      }

      try {
        return safeStorage.decryptString(Buffer.from(value, 'base64'));
      } catch (error: unknown) {
        throw invalidError(error);
      }
    },
  };
}
