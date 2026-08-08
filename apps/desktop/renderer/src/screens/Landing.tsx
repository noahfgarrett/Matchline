import { useCallback, useEffect, useState, type JSX } from 'react';

import type { WireProjectSummary, WireRecentProject } from '../../../shared/schemas';
import { call, messageOf } from '../api';

/**
 * The first screen: start a project or reopen one.
 *
 * A project is created before any file is chosen, deliberately. The `.matchline`
 * file is where every later decision is recorded, so the wizard should never be
 * in the position of holding work it has nowhere to put.
 */

const PROJECT_FILTERS = [{ name: 'Matchline project', extensions: ['matchline'] }];

type Busy = 'idle' | 'creating' | 'opening';

export function Landing({
  onOpened,
}: {
  readonly onOpened: (project: WireProjectSummary) => void;
}): JSX.Element {
  const [name, setName] = useState<string>('');
  const [recents, setRecents] = useState<readonly WireRecentProject[]>([]);
  const [busy, setBusy] = useState<Busy>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    let cancelled = false;
    void call(window.matchline.project.recent()).then(
      (data): void => {
        if (!cancelled) {
          setRecents(data.projects);
        }
      },
      (): void => {
        // A missing recents list is not worth an error banner on the first
        // screen; the two buttons below still work.
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, []);

  const createProject = useCallback(async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Give the project a name first — it becomes the file name and the profile name.');
      return;
    }

    setBusy('creating');
    setError(null);
    try {
      const chosen = await call(
        window.matchline.dialog.saveFile({
          defaultName: `${trimmed}.matchline`,
          filters: PROJECT_FILTERS,
        }),
      );
      if (chosen.cancelled) {
        return;
      }
      const created = await call(
        window.matchline.project.create({ path: chosen.path, name: trimmed }),
      );
      onOpened(created.project);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setBusy('idle');
    }
  }, [name, onOpened]);

  const openProject = useCallback(
    async (knownPath?: string): Promise<void> => {
      setBusy('opening');
      setError(null);
      try {
        let target = knownPath;
        if (target === undefined) {
          const chosen = await call(
            window.matchline.dialog.openFile({ filters: PROJECT_FILTERS }),
          );
          if (chosen.cancelled) {
            return;
          }
          target = chosen.path;
        }
        const opened = await call(window.matchline.project.open({ path: target }));
        onOpened(opened.project);
      } catch (caught: unknown) {
        setError(messageOf(caught));
      } finally {
        setBusy('idle');
      }
    },
    [onOpened],
  );

  return (
    <div className="landing">
      <div className="landing__intro">
        <h1 className="landing__title">Set up a site in about an hour</h1>
        <p className="landing__body">
          A Matchline project holds your model extraction, your spreadsheets, the rules you
          teach it about this site, and every compile it has produced. Start one, drop your
          files in, and the wizard walks you through the rest.
        </p>
      </div>

      <div className="landing__columns">
        <section className="landing__card" data-testid="landing-new">
          <h2 className="landing__card-title">Start a new project</h2>
          <p className="landing__card-body">
            Name it after the site. You will pick where to save the file next.
          </p>
          <input
            className="control control--text"
            type="text"
            placeholder="Dragon"
            aria-label="Project name"
            data-testid="project-name"
            value={name}
            onChange={(event): void => {
              setName(event.target.value);
            }}
            onKeyDown={(event): void => {
              if (event.key === 'Enter') {
                void createProject();
              }
            }}
          />
          <button
            className="button button--primary"
            type="button"
            data-testid="create-project"
            disabled={busy !== 'idle'}
            onClick={(): void => {
              void createProject();
            }}
          >
            {busy === 'creating' ? 'Creating…' : 'Choose where to save…'}
          </button>
        </section>

        <section className="landing__card" data-testid="landing-open">
          <h2 className="landing__card-title">Open an existing project</h2>
          <p className="landing__card-body">
            Everything you saved last time comes back, including the site profile.
          </p>
          <button
            className="button"
            type="button"
            data-testid="open-project"
            disabled={busy !== 'idle'}
            onClick={(): void => {
              void openProject();
            }}
          >
            {busy === 'opening' ? 'Opening…' : 'Open project…'}
          </button>

          {recents.length === 0 ? (
            <p className="landing__empty">No projects opened on this machine yet.</p>
          ) : (
            <ul className="recent-list">
              {recents.map((entry: WireRecentProject): JSX.Element => (
                <li key={entry.path} className="recent-list__item">
                  <button
                    className="recent-list__button"
                    type="button"
                    disabled={entry.missing || busy !== 'idle'}
                    onClick={(): void => {
                      void openProject(entry.path);
                    }}
                  >
                    <span className="recent-list__name">{entry.name}</span>
                    <span className="recent-list__path">{entry.path}</span>
                  </button>
                  {entry.missing ? <span className="recent-list__missing">moved</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {error === null ? null : (
        <p className="callout callout--error" role="alert" data-testid="landing-error">
          {error}
        </p>
      )}
    </div>
  );
}
