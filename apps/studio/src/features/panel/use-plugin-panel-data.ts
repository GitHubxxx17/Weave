import { useEffect, useRef, useState } from 'react';
import { fetchPanelData } from './plugin-panel-api.js';
import {
  validatePanelData,
  type PanelCatalog,
  type PanelData,
  type PluginPanelDescriptor,
} from './plugin-panel-types.js';
import type { ComposerOwner } from '../composer/use-composer-draft.js';
export type PanelAuthority = Pick<PanelCatalog, 'serverEpoch' | 'generation' | 'authorityEpoch'>;
export function panelRenderKey(
  owner: ComposerOwner,
  descriptor: PluginPanelDescriptor,
  authority: PanelAuthority,
  visible: boolean,
): string {
  return JSON.stringify([
    owner,
    descriptor.panelId,
    descriptor.panelRef,
    descriptor.state,
    authority.serverEpoch,
    authority.generation,
    authority.authorityEpoch,
    visible,
  ]);
}
export function samePanelAuthority(value: PanelAuthority, authority: PanelAuthority): boolean {
  return (
    value.serverEpoch === authority.serverEpoch &&
    value.generation === authority.generation &&
    value.authorityEpoch === authority.authorityEpoch
  );
}
interface PluginPanelDataState {
  key: string;
  epoch: number;
  data?: PanelData;
  error?: string;
  unavailable?: boolean;
}
export function usePluginPanelData(
  descriptor: PluginPanelDescriptor,
  authority: PanelAuthority,
  owner: ComposerOwner,
  visible: boolean,
  refresh = 0,
): PluginPanelDataState {
  const key = panelRenderKey(owner, descriptor, authority, visible);
  const current = useRef({ key, epoch: 0 });
  if (current.current.key !== key) current.current = { key, epoch: current.current.epoch + 1 };
  const [state, setState] = useState<{
    key: string;
    epoch: number;
    data?: PanelData;
    error?: string;
    unavailable?: boolean;
  }>({ key, epoch: 0 });
  useEffect(() => {
    if (!visible || owner.sessionId === '' || descriptor.state !== 'available') return;
    const controller = new AbortController();
    const epoch = current.current.epoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () =>
      !controller.signal.aborted && current.current.key === key && current.current.epoch === epoch;
    const read = async () => {
      try {
        if (!valid()) return;
        const data = await fetchPanelData(owner.sessionId, descriptor.panelRef, controller.signal);
        if (!valid()) return;
        if (
          !samePanelAuthority(data, authority) ||
          data.panelId !== descriptor.panelId ||
          data.sessionId !== owner.sessionId ||
          data.panelRef !== descriptor.panelRef ||
          !validatePanelData(descriptor.definition, data)
        )
          throw new Error('invalid');
        setState({ key, epoch, data });
      } catch (error) {
        if (valid())
          setState({
            key,
            epoch,
            error: '面板数据暂不可用',
            unavailable:
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              ['panel-stale', 'panel-unavailable', 'panel-not-found'].includes(String(error.code)),
          });
      } finally {
        if (valid()) timer = setTimeout(() => void read(), 2000);
      }
    };
    void read();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, refresh]);
  return state.key === key && state.epoch === current.current.epoch && visible
    ? state
    : { key, epoch: current.current.epoch };
}
