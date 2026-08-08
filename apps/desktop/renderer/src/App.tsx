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
  | { readonly status: 'open'; readonly project: WireProjectSummary };

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
            : { status: 'open', project: data.project },
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

  const onOpened = useCallback((project: WireProjectSummary): void => {
    setShell({ status: 'open', project });
  }, []);

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
          <Wizard project={shell.project} onClosed={onClosed} />
        ) : null}
      </main>
    </div>
  );
}
