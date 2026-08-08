import { useEffect, useState } from 'react';

import { messageOf } from './api';

/**
 * Re-runs a main-process preview whenever the thing being previewed changes.
 *
 * `key` is the caller's statement of "what this preview depends on" — usually
 * the JSON of the draft section plus the loaded model. Two rules follow from
 * that and they are why this hook exists instead of a bare `useEffect`:
 *
 * - A response whose key is no longer current is discarded. Previews run over
 *   the whole asset universe and finish out of order; painting a late one would
 *   show numbers for settings the user has already moved on from.
 * - The previous result stays on screen while the next one is computed. Blanking
 *   the panel on every keystroke makes a fast preview look like a broken one.
 */

export type PreviewState<TData> =
  | { readonly status: 'loading'; readonly data: TData | null }
  | { readonly status: 'ready'; readonly data: TData }
  | { readonly status: 'failed'; readonly data: TData | null; readonly error: string };

export function usePreview<TData>(
  key: string,
  fetcher: () => Promise<TData>,
): PreviewState<TData> {
  const [state, setState] = useState<PreviewState<TData>>({ status: 'loading', data: null });

  useEffect((): (() => void) => {
    let cancelled = false;
    setState((current: PreviewState<TData>) => ({ status: 'loading', data: current.data }));

    void fetcher().then(
      (data: TData): void => {
        if (!cancelled) {
          setState({ status: 'ready', data });
        }
      },
      (error: unknown): void => {
        if (!cancelled) {
          setState((current: PreviewState<TData>) => ({
            status: 'failed',
            data: current.data,
            error: messageOf(error),
          }));
        }
      },
    );

    return (): void => {
      cancelled = true;
    };
    // `fetcher` is rebuilt on every render by design; `key` is the caller's
    // declaration of what actually changed, and it is the only trigger.

  }, [key]);

  return state;
}
