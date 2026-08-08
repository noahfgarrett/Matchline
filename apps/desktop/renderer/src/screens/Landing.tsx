import { useCallback, useEffect, useState, type JSX } from 'react';

import type {
  WireOpenNotice,
  WireProjectSummary,
  WireRecentProject,
} from '../../../shared/schemas';
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

/** A file written by an older build, waiting for the user to say yes. */
interface PendingUpgrade {
  readonly path: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * What opening the project did to it, in a sentence — or `null` when it did
 * nothing worth saying.
 *
 * Both facts are the user's business. A migration rewrote the only copy of
 * their site's decisions, and the backup path is what they would need if it
 * went wrong; an adopted config moved settings out of this machine's state file
 * and into the project, which is what makes the file portable from now on.
 */
function describeNotice(notice: WireOpenNotice): string | null {
  const sentences: string[] = [];
  if (notice.migration !== null) {
    sentences.push(
      `This project was written by an earlier version of Matchline (file format ` +
        `${String(notice.migration.fromVersion)}) and has been upgraded to ` +
        `${String(notice.migration.toVersion)}. The original was copied to ` +
        `${notice.migration.backupPath} first.`,
    );
  }
  if (notice.adoptedAppStateConfig) {
    sentences.push(
      'Your hierarchy and relationship settings for this project have moved into the ' +
        'project file itself, so they now travel with it.',
    );
  }
  return sentences.length === 0 ? null : sentences.join(' ');
}

export function Landing({
  onOpened,
}: {
  /**
   * Hands the project to the shell, with anything opening it had to do first.
   *
   * The notice goes up rather than being shown here because this screen is
   * gone the instant the project opens — a migration message rendered on it
   * would be mounted and unmounted in the same tick.
   */
  readonly onOpened: (project: WireProjectSummary, notice: string | null) => void;
}): JSX.Element {
  const [name, setName] = useState<string>('');
  const [recents, setRecents] = useState<readonly WireRecentProject[]>([]);
  const [busy, setBusy] = useState<Busy>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingUpgrade, setPendingUpgrade] = useState<PendingUpgrade | null>(null);

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
      onOpened(created.project, null);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setBusy('idle');
    }
  }, [name, onOpened]);

  /**
   * Opens a project, or asks first.
   *
   * `acceptMigration` is only ever `true` on the second call, made by the
   * confirm card below. Until then an older file is left exactly as it was
   * found — nothing on this screen rewrites a file the user has not agreed to
   * have rewritten.
   */
  const openProject = useCallback(
    async (knownPath?: string, acceptMigration = false): Promise<void> => {
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

        const opened = await call(
          window.matchline.project.open(
            acceptMigration ? { path: target, acceptMigration: true } : { path: target },
          ),
        );

        if (opened.outcome === 'migration-needed') {
          setPendingUpgrade({ path: target, ...opened.migrationNeeded });
          return;
        }
        if (opened.outcome === 'backup-blocked') {
          setPendingUpgrade(null);
          setError(
            'Matchline copies a project file before upgrading it, and a backup from an ' +
              `earlier upgrade attempt is already sitting at ${opened.backupPath}. That file ` +
              'is the record of what went wrong last time, so Matchline will not write over ' +
              'it. Move it somewhere else, then open the project again.',
          );
          return;
        }

        setPendingUpgrade(null);
        onOpened(opened.project, describeNotice(opened.notice));
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

      {pendingUpgrade === null ? null : (
        <section
          className="callout callout--warning landing__confirm"
          role="alertdialog"
          aria-label="Upgrade this project file?"
          data-testid="migration-confirm"
        >
          <p>
            {pendingUpgrade.path} was written by an older version of Matchline (file format{' '}
            {String(pendingUpgrade.fromVersion)}). Opening it here upgrades it to file format{' '}
            {String(pendingUpgrade.toVersion)}, which rewrites the file — and this file is the
            only copy of everything the site has been taught. Matchline copies the original
            alongside it first and tells you exactly where afterwards. Until you choose Upgrade,
            the file is left untouched.
          </p>
          <div className="landing__confirm-actions">
            <button
              className="button button--primary"
              type="button"
              data-testid="migration-accept"
              disabled={busy !== 'idle'}
              onClick={(): void => {
                void openProject(pendingUpgrade.path, true);
              }}
            >
              {busy === 'opening' ? 'Upgrading…' : 'Upgrade and open'}
            </button>
            <button
              className="button"
              type="button"
              data-testid="migration-cancel"
              disabled={busy !== 'idle'}
              onClick={(): void => {
                setPendingUpgrade(null);
              }}
            >
              Leave it as it is
            </button>
          </div>
        </section>
      )}

      {error === null ? null : (
        <p className="callout callout--error" role="alert" data-testid="landing-error">
          {error}
        </p>
      )}
    </div>
  );
}
