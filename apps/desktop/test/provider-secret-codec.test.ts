import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorage = {
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
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

  it('treats the Linux basic_text backend as unavailable', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');

    const codec = createElectronProviderSecretCodec('linux');

    expect(codec.isAvailable()).toBe(false);
    expect(() => codec.encrypt('secret')).toThrow();
  });

  it('accepts a real Linux keyring backend', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');

    expect(createElectronProviderSecretCodec('linux').isAvailable()).toBe(true);
  });

  it('does not query the storage backend on other platforms', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(true);

    expect(createElectronProviderSecretCodec('darwin').isAvailable()).toBe(true);
    expect(safeStorage.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it('decrypts persisted base64 values through Electron safeStorage', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.decryptString.mockReturnValue('deepseek-secret');

    const codec = createElectronProviderSecretCodec();

    expect(codec.decrypt(Buffer.from('ciphertext').toString('base64'))).toBe('deepseek-secret');
    expect(safeStorage.decryptString).toHaveBeenCalledWith(Buffer.from('ciphertext'));
  });
});
