import { useCallback, useEffect, useState, type JSX } from 'react';

/**
 * The shell. One header, one empty state, one action — everything else arrives with the
 * wizard and workspace screens (APP.md "UI surface").
 */

type VersionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly version: string }
  | { readonly status: 'failed' };

type ProjectState =
  | { readonly status: 'none' }
  | { readonly status: 'selecting' }
  | { readonly status: 'selected'; readonly path: string }
  | { readonly status: 'failed'; readonly message: string };

export function App(): JSX.Element {
  const [version, setVersion] = useState<VersionState>({ status: 'loading' });
  const [project, setProject] = useState<ProjectState>({ status: 'none' });

  useEffect((): (() => void) => {
    let cancelled = false;

    void window.matchline.app.version().then(
      (result): void => {
        if (cancelled) {
          return;
        }
        setVersion(
          result.ok ? { status: 'ready', version: result.data.version } : { status: 'failed' },
        );
      },
      (): void => {
        if (!cancelled) {
          setVersion({ status: 'failed' });
        }
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, []);

  const openProject = useCallback(async (): Promise<void> => {
    setProject({ status: 'selecting' });

    // Contract failures come back as `ok: false`; invoke itself only rejects if the
    // channel is gone entirely (main process torn down mid-call).
    let result: Awaited<ReturnType<typeof window.matchline.dialog.openFile>>;
    try {
      result = await window.matchline.dialog.openFile({
        filters: [{ name: 'Matchline project', extensions: ['matchline'] }],
      });
    } catch (error: unknown) {
      setProject({
        status: 'failed',
        message: error instanceof Error ? error.message : 'The file dialog is unavailable.',
      });
      return;
    }

    if (!result.ok) {
      setProject({ status: 'failed', message: result.error.message });
      return;
    }

    setProject(
      result.data.cancelled ? { status: 'none' } : { status: 'selected', path: result.data.path },
    );
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__wordmark">Matchline</span>
        <span className="app__version">
          {version.status === 'ready' ? `v${version.version}` : ''}
          {version.status === 'loading' ? 'checking version…' : ''}
          {version.status === 'failed' ? 'version unavailable' : ''}
        </span>
      </header>

      <main className="app__main">
        <div className="empty-state">
          <h1 className="empty-state__title">No project open</h1>
          <p className="empty-state__body">
            A Matchline project holds your models, spreadsheets, site profile, and every
            compile it has produced. Open one to pick up where you left off, or start a new
            one to import your first sources.
          </p>

          <button
            className="empty-state__action"
            type="button"
            onClick={(): void => {
              void openProject();
            }}
            disabled={project.status === 'selecting'}
          >
            {project.status === 'selecting' ? 'Choosing…' : 'Open project…'}
          </button>

          {project.status === 'selected' ? (
            <p className="empty-state__note" role="status">
              Selected <code>{project.path}</code>. Opening projects arrives with the project
              store.
            </p>
          ) : null}

          {project.status === 'failed' ? (
            <p className="empty-state__note empty-state__note--error" role="alert">
              {project.message}
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
