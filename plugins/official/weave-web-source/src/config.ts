import type { PluginSdk } from '@weave/plugin';
import type { SearchConfiguration } from './types.js';

/** Only the factory-selected two values cross this boundary; never capture all env. */
export function readSearchConfiguration(
  z: PluginSdk['z'],
  input: { readonly provider?: string | undefined; readonly apiKey?: string | undefined },
): SearchConfiguration {
  const parsed = z
    .strictObject({ provider: z.string().optional(), apiKey: z.string().optional() })
    .safeParse(input);
  if (!parsed.success) return Object.freeze({ status: 'invalid' });
  const { provider, apiKey } = parsed.data;
  if (provider === undefined || provider === 'none')
    return Object.freeze({ status: 'unconfigured' });
  if (provider !== 'tavily') return Object.freeze({ status: 'invalid' });
  if (apiKey === undefined) return Object.freeze({ status: 'unconfigured' });
  if (
    !z
      .string()
      .min(8)
      .max(512)
      .regex(/^[\x21-\x7e]+$/)
      .safeParse(apiKey).success
  )
    return Object.freeze({ status: 'invalid' });
  return Object.freeze({ status: 'ready', value: Object.freeze({ provider: 'tavily', apiKey }) });
}
