import { useCallback, useEffect, useState, type JSX } from 'react';

import type { WireProfileSection } from '../../../shared/schemas';
import { call, messageOf } from '../api';
import { Callout, Panel, TableScroll } from '../components/Panel';

import type { WizardContext } from './Wizard';

/**
 * Screen 9 — Publish Site Profile (PRODUCT.md §7 screen 9, §13.3).
 *
 * Two artifacts leave this screen and they are not the same thing:
 *
 * - **A saved revision** inside the project file. Old revisions are kept, so
 *   "what did this project believe last Tuesday" stays answerable.
 * - **A profile package**, a portable JSON file carrying the same decisions and
 *   nothing else — no model objects, no spreadsheet rows, not even file names.
 *   That is what makes the next site's setup start from this one's answers.
 */

const PROFILE_FILTERS = [{ name: 'Matchline profile package', extensions: ['json'] }];

export function Screen9Publish({
  context,
  savedRevision,
  onSave,
  onImported,
}: {
  readonly context: WizardContext;
  readonly savedRevision: number | null;
  readonly onSave: (note: string) => Promise<number | null>;
  readonly onImported: () => Promise<void>;
}): JSX.Element {
  const [sections, setSections] = useState<readonly WireProfileSection[]>([]);
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await call(window.matchline.profile.sections());
      setSections(data.sections);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  useEffect((): void => {
    void refresh();
  }, [refresh, context.draft, context.config]);

  const configured = sections.filter((section) => section.configured).length;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const revision = await onSave(note.trim());
      if (revision !== null) {
        setMessage(`Saved as revision ${String(revision)}. Earlier revisions are still there.`);
        setNote('');
      }
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const exportPackage = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const picked = await call(
        window.matchline.dialog.saveFile({
          defaultName: `${context.draft.profileId}.matchline-profile.json`,
          filters: PROFILE_FILTERS,
        }),
      );
      if (picked.cancelled) {
        return;
      }
      const data = await call(window.matchline.profile.export({ path: picked.path }));
      setMessage(
        data.result.written
          ? `Written to ${data.result.path}. ${data.result.note}`
          : data.result.reason,
      );
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const importPackage = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const picked = await call(
        window.matchline.dialog.openFile({ filters: PROFILE_FILTERS }),
      );
      if (picked.cancelled) {
        return;
      }
      await call(window.matchline.profile.import({ path: picked.path }));
      await onImported();
      await refresh();
      setMessage(
        'Profile package loaded. This project keeps its own name; every rule came from the package. ' +
          'Nothing is compiled against it yet — run Compile on screen 8.',
      );
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen" data-testid="screen-9">
      <header className="screen__header">
        <h1 className="screen__title">9. Publish Site Profile</h1>
        <p className="screen__lede">
          Everything you have decided, written down as one reusable set of rules. Next revision
          of this site: replace the sources, reuse this profile, review what changed, export.
        </p>
      </header>

      {error === null ? null : <Callout tone="error">{error}</Callout>}
      {message === null ? null : <Callout tone="success">{message}</Callout>}

      <Panel
        title="What this profile says"
        description={`${String(configured)} of ${String(sections.length)} sections are configured. A section nobody set is not an error — it means Matchline falls back to the commissioning baseline for it.`}
      >
        <TableScroll>
          <table className="table" data-testid="profile-sections">
            <thead>
              <tr>
                <th>Section</th>
                <th>What it decides</th>
                <th>Set to</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((section: WireProfileSection): JSX.Element => (
                <tr key={section.name}>
                  <td>
                    {section.name}
                    {section.configured ? null : (
                      <>
                        {' '}
                        <span className="badge">not set</span>
                      </>
                    )}
                  </td>
                  <td className="muted">{section.what}</td>
                  <td>{section.detail === '' ? <span className="muted">—</span> : section.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>

      <Panel
        title="Save a revision"
        description="Writes the profile into this project file as a new revision. Old revisions are never deleted."
      >
        <div className="toolbar">
          <input
            className="control control--text"
            type="text"
            placeholder="What changed?"
            aria-label="Revision note"
            data-testid="publish-note"
            value={note}
            onChange={(event): void => {
              setNote(event.target.value);
            }}
          />
          <button
            className="button button--primary"
            type="button"
            data-testid="publish-save"
            disabled={busy}
            onClick={(): void => {
              void save();
            }}
          >
            Save revision
          </button>
        </div>
        <p className="muted" data-testid="publish-revision">
          {savedRevision === null
            ? 'Nothing saved yet.'
            : `Latest saved revision: ${String(savedRevision)}.`}
        </p>
      </Panel>

      <Panel
        title="Reuse this profile somewhere else"
        description="A profile package is a plain JSON file of decisions. It carries no model objects, no spreadsheet rows and no file paths, so it is safe to hand to another team."
        actions={
          <>
            <button
              className="button button--small"
              type="button"
              data-testid="profile-export"
              disabled={busy}
              onClick={(): void => {
                void exportPackage();
              }}
            >
              Export profile
            </button>
            <button
              className="button button--small"
              type="button"
              data-testid="profile-import"
              disabled={busy}
              onClick={(): void => {
                void importPackage();
              }}
            >
              Import profile
            </button>
          </>
        }
      >
        <Callout tone="info">
          The next revision of this site is: replace the sources on screen 1, keep this profile,
          compile, review what changed, export. Nothing on screens 2 to 7 has to be answered
          twice. Importing a package replaces every rule in this project — the project keeps its
          own name, and the sources you have added stay where they are.
        </Callout>
      </Panel>
    </div>
  );
}
