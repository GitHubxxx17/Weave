import type { PluginFactory } from '@weave/plugin';
import { readSearchConfiguration } from './config.js';
import { createWebModule } from './tools.js';

/** Import/setup is inert; capture only this plugin's selected configuration at load. */
export default ((sdk) =>
  createWebModule(sdk, {
    configuration: readSearchConfiguration(sdk.z, {
      provider: process.env.WEAVE_WEB_SEARCH_PROVIDER,
      apiKey: process.env.WEAVE_WEB_TAVILY_API_KEY,
    }),
  })) satisfies PluginFactory;
