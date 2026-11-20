import type { ApprovalBroker } from '@weave/runtime';

/**
 * The part of the Approval Broker a plugin gets. A plugin can raise a request
 * and watch requests, but it cannot approve, reject, cancel or expire one: only
 * the user, through the host's approval API, decides what a protected tool may
 * do. Cancelling a request and timing it out go through the `signal` and
 * `timeoutMs` the plugin passes to `request`.
 */
export type PluginApprovalBroker = Pick<ApprovalBroker, 'request' | 'get' | 'list' | 'subscribe'>;

/**
 * Returns a frozen view of `broker` with only `request`, `get`, `list` and
 * `subscribe`. The view calls the broker, so it sees the same requests and
 * events; it cannot be turned back into the broker.
 *
 * This is the shape of the API, not an isolation boundary: a plugin that runs
 * in the host's process can still reach other objects the process holds. It
 * does stop code written against the kernel's API from deciding approvals, and
 * it is the shape an out-of-process plugin would be given.
 */
export function createRestrictedApprovalBroker(broker: ApprovalBroker): PluginApprovalBroker {
  const view: PluginApprovalBroker = {
    request: (input) => broker.request(input),
    get: (approvalId) => broker.get(approvalId),
    list: () => broker.list(),
    subscribe: (listener) => broker.subscribe(listener),
  };
  return Object.freeze(view);
}
