import { managedManifest, managedPreview } from './managed-plugin-fixtures.js';
import type {
  ManagedManifest,
  ManagedPreview,
} from '../../src/features/plugins/managed-plugin-types.js';

export const declarativeManifest = {
  ...managedManifest,
  name: 'Review Skills',
  description: 'Review instructions and reference checklists',
  host: 'declarative' as const,
  capabilities: ['skill'],
  contributes: { skills: ['review-change'] },
  permissions: [],
} satisfies ManagedManifest;

export const declarativePreview = {
  ...managedPreview,
  expiresAt: '2099-01-01T00:00:00.000Z',
  candidate: { ...managedPreview.candidate, manifest: declarativeManifest },
} satisfies ManagedPreview;
