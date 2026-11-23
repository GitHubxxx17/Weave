import { PluginHostError } from '@weave/plugin-host';

export class ManagedGenerationOwnershipError extends PluginHostError {
  constructor() {
    super('plugin-generation-blocked', 'Managed plugin store ownership was lost');
    this.name = 'ManagedGenerationOwnershipError';
  }
}
