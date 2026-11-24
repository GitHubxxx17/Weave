import { useEffect, useRef } from 'react';

export function useLatestRequest() {
  const current = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => current.current?.abort(), []);
  function clear(): void {
    current.current?.abort();
    current.current = undefined;
  }
  function start(): AbortSignal {
    clear();
    const controller = new AbortController();
    current.current = controller;
    return controller.signal;
  }
  return { start, clear };
}
