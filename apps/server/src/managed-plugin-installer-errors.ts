export class ManagedInstallerError extends Error {
  constructor(
    readonly code:
      | 'plugin-installer-unavailable'
      | 'plugin-installer-disabled'
      | 'plugin-artifact-unavailable'
      | 'plugin-invalid-request'
      | 'plugin-request-too-large'
      | 'plugin-preview-stale'
      | 'plugin-preview-capacity'
      | 'plugin-managed-id-conflict'
      | 'plugin-managed-namespace-unavailable',
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ManagedInstallerError';
  }
}
