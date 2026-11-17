import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorage = {
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
};

vi.mock('electron', () => ({ safeStorage }));

const { createElectronProviderSecretCodec } = await import('../src/provider-secret-codec.js');

describe('Electron Provider Secret Codec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encodes encrypted API keys as base64 without exposing plaintext', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.encryptString.mockReturnValue(Buffer.from('ciphertext'));

    const codec = createElectronProviderSecretCodec();

    expect(codec.isAvailable()).toBe(true);
    expect(codec.encrypt('deepseek-secret')).toBe(Buffer.from('ciphertext').toString('base64'));
    expect(codec.encrypt('deepseek-secret')).not.toContain('deepseek-secret');
    expect(safeStorage.encryptString).toHaveBeenCalledWith('deepseek-secret');
  });

  it('reports unavailable system encryption before saving', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false);

    const codec = createElectronProviderSecretCodec();

    expect(() => codec.encrypt('secret')).toThrow();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it('decrypts persisted base64 values through Electron safeStorage', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.decryptString.mockReturnValue('deepseek-secret');

    const codec = createElectronProviderSecretCodec();

    expect(codec.decrypt(Buffer.from('ciphertext').toString('base64'))).toBe('deepseek-secret');
    expect(safeStorage.decryptString).toHaveBeenCalledWith(Buffer.from('ciphertext'));
  });
});
