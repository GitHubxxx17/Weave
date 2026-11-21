import console from 'node:console';
import { on } from 'node:events';
import process from 'node:process';
import { inspect } from 'node:util';

let authority;
let store;
let openStore;
let config;

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

function sendError(phase, error) {
  return send({
    kind: 'error',
    phase,
    code: typeof error?.code === 'string' ? error.code : null,
    detail: inspect(error, { depth: 5 }),
  });
}

async function closeResources() {
  if (store) {
    await store.close();
    store = undefined;
  }
  if (authority) {
    await authority.close();
    authority = undefined;
  }
}

async function run() {
  for await (const [command] of on(process, 'message', { close: ['disconnect'] })) {
    switch (command.kind) {
      case 'configure': {
        if (config) throw new Error('Child is already configured');
        config = command.config;
        const { createSqlitePluginAuthorityDatabase } = await import(config.authorityModule);
        const { openOwnedPluginArtifactStore } = await import(config.storeModule);
        openStore = openOwnedPluginArtifactStore;
        authority = createSqlitePluginAuthorityDatabase({ filename: config.databaseFile });
        await send({ kind: 'prepared', databaseId: authority.identity.databaseId });
        break;
      }
      case 'start': {
        if (!authority || store) throw new Error('Child cannot start ownership');
        try {
          store = await openStore({
            authority,
            directory: config.directory,
            initialBinding: config.initialBinding,
            onOwnershipLost: () => undefined,
          });
        } catch (error) {
          try {
            await closeResources();
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], 'Acquisition and cleanup failed', {
              cause: cleanup,
            });
          }
          await sendError('acquire', error);
          if (!config.keepAliveOnError) return;
          break;
        }
        await send({
          kind: 'held',
          pid: process.pid,
          binding: store.binding,
          nodeVersion: process.version,
          sqliteVersion: process.versions.sqlite,
        });
        break;
      }
      case 'write-main': {
        if (!store) throw new Error('Child does not own the store');
        store.assertHeldSync();
        const written = await authority.trust.append({
          kind: 'revoked',
          pluginId: command.pluginId,
        });
        const events = await authority.trust.events();
        store.assertHeldSync();
        await send({ kind: 'wrote-main', written, events });
        break;
      }
      case 'close':
        await closeResources();
        await send({ kind: 'closed' });
        return;
      default:
        throw new Error('Unknown fixture command');
    }
  }
}

let failure;
try {
  await run();
} catch (error) {
  failure = error;
}
try {
  await closeResources();
} catch (cleanup) {
  failure =
    failure === undefined
      ? cleanup
      : new AggregateError([failure, cleanup], 'Fixture and cleanup failed', { cause: cleanup });
}
try {
  if (failure !== undefined) {
    process.exitCode = 1;
    if (process.connected) await sendError('fixture', failure);
    else console.error(failure);
  }
} finally {
  if (process.connected) process.disconnect();
}
