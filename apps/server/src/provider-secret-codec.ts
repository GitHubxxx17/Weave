/**
 * Encryption boundary used by Desktop-managed Provider settings.
 *
 * The Server only knows how to call this small interface. Electron owns the
 * concrete implementation backed by the operating system key store.
 */
export interface ProviderSecretCodec {
  /** Returns whether the host can encrypt and persist Provider secrets. */
  isAvailable(): boolean;
  /** Encrypts one API key into an opaque storage value. */
  encrypt(value: string): string;
  /** Decrypts one persisted API key for an in-memory LLM client. */
  decrypt(value: string): string;
}
