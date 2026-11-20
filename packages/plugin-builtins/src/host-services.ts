import { approvalBrokerRef, definePlugin, sessionStoreRef, type KernelPlugin } from '@weave/plugin';
import { type ApprovalBroker, type SessionEventStore } from '@weave/runtime';

export interface HostServicesOptions {
  readonly approvalBroker?: ApprovalBroker | undefined;
  readonly sessionStore?: SessionEventStore | undefined;
}

/**
 * Creates the builtin plugin that exposes services the host already owns to
 * kernel plugins, as `weave.approval.broker` and `weave.session.store`.
 *
 * The host keeps the lifecycle: these instances are created and closed by the
 * host's Runtime, so the plugin only hands them out and never disposes them.
 * Only the services passed in are provided, and the manifest lists exactly
 * those under `contributes.services`.
 */
export function hostServicesPlugin(options: HostServicesOptions): KernelPlugin {
  const { approvalBroker, sessionStore } = options;
  const services = [
    ...(approvalBroker === undefined ? [] : [approvalBrokerRef.id]),
    ...(sessionStore === undefined ? [] : [sessionStoreRef.id]),
  ];

  return definePlugin({
    manifest: {
      id: 'host-services',
      name: 'Host Services',
      version: '1.0.0',
      apiVersion: '1.0.0',
      // A services-only plugin has no capability of its own, but a manifest
      // needs one; the approval broker backs tool approvals, so `tool` fits.
      capabilities: ['tool'],
      contributes: { services },
    },
    setup(env) {
      if (approvalBroker !== undefined) {
        env.provide(approvalBrokerRef, { factory: () => approvalBroker });
      }
      if (sessionStore !== undefined) {
        env.provide(sessionStoreRef, { factory: () => sessionStore });
      }
    },
  });
}
