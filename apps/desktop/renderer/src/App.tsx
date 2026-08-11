import { useCallback, useEffect, useState, type JSX } from 'react';

import type { WireProjectSummary } from '../../shared/schemas';
import { call } from './api';
import { Landing } from './screens/Landing';
import { Wizard } from './screens/Wizard';

/**
 * The shell. Two states: no project, or a project with the setup wizard in it.
 *
 * Which one is showing is decided by the main process, not by this component —
 * a reloaded renderer asks `project:current` and lands back where the session
 * actually is, rather than assuming it starts empty.
 */

type Shell =
  | { readonly status: 'loading' }
  | { readonly status: 'landing' }
  | {
      readonly status: 'open';
      readonly project: WireProjectSummary;
      /**
       * What opening the project had to do to the file first, or `null`.
       *
       * Held here rather than on the Landing screen, which is unmounted the
       * moment a project opens. A reloaded renderer restores the project from
       * `project:current` and has no notice to show, which is right: the file
       * was already fixed, and saying so twice would read as it happening again.
       */
      readonly notice: string | null;
      /**
       * True when this project was created in this session, which is the one
       * case where "how do you want to set this up?" is a live question. A
       * reopened project has answered it already, by having decisions in it.
       */
      readonly justCreated: boolean;
    };

export function App(): JSX.Element {
  const [version, setVersion] = useState<string>('');
  const [shell, setShell] = useState<Shell>({ status: 'loading' });

  useEffect((): (() => void) => {
    let cancelled = false;

    void call(window.matchline.app.version()).then(
      (data): void => {
        if (!cancelled) {
          setVersion(data.version);
        }
      },
      (): void => {
        // A missing version string is cosmetic; the app still works.
      },
    );

    void call(window.matchline.project.current()).then(
      (data): void => {
        if (cancelled) {
          return;
        }
        setShell(
          data.project === null
            ? { status: 'landing' }
            : { status: 'open', project: data.project, notice: null, justCreated: false },
        );
      },
      (): void => {
        if (!cancelled) {
          setShell({ status: 'landing' });
        }
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, []);

  const onOpened = useCallback(
    (project: WireProjectSummary, notice: string | null, justCreated: boolean): void => {
      setShell({ status: 'open', project, notice, justCreated });
    },
    [],
  );

  const onClosed = useCallback((): void => {
    setShell({ status: 'landing' });
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__wordmark">Matchline</span>
        <span className="app__version">{version === '' ? '' : `v${version}`}</span>
      </header>

      <main className="app__main" data-testid="app-main">
        {shell.status === 'loading' ? (
          <p className="callout callout--info">Starting up…</p>
        ) : null}
        {shell.status === 'landing' ? <Landing onOpened={onOpened} /> : null}
        {shell.status === 'open' ? (
          <>
            {shell.notice === null ? null : (
              <p className="callout callout--info" role="status" data-testid="open-notice">
                {shell.notice}
              </p>
            )}
            <Wizard
              project={shell.project}
              justCreated={shell.justCreated}
              onClosed={onClosed}
            />
          </>
        ) : null}
      </main>
    </div>
  );
}
