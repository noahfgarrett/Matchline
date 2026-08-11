import { useCallback, useEffect, useState, type JSX } from 'react';

import type {
  WireAttributeChoice,
  WireHierarchyLevel,
  WireProfileSection,
  WirePublishBlocker,
} from '../../../shared/schemas';
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

/**
 * What a level's boundary actually compares, in the words the person chose.
 *
 * The KEY attribute unless the level names a different one for the comparison
 * (P0-6) — never the display attribute, or a re-worded system would read as a
 * crossing. Falls back to the raw attribute key when the Composer's menu has
 * not loaded a plain-language name for it: an unfamiliar string is a worse
 * answer than a familiar one, and both are better than a blank.
 */
function boundaryComparisonOf(
  level: WireHierarchyLevel,
  attributes: readonly WireAttributeChoice[],
): string {
  const key = level.boundaryAttributeKey ?? level.attributeKey;
  return attributes.find((choice) => choice.attributeKey === key)?.label ?? key;
}

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
  /**
   * Decisions in this draft the engine will refuse to compile (P0-3).
   *
   * Read from the same call as the sections, and re-read on every draft change,
   * because a blocker is a fact about the draft AND about the models currently
   * open — taking a set off the filter on screen 3 clears it, and so does
   * re-extracting the model that could not resolve it.
   */
  const [blockers, setBlockers] = useState<readonly WirePublishBlocker[]>([]);
  const [attributes, setAttributes] = useState<readonly WireAttributeChoice[]>([]);
  /**
   * Whether the person has confirmed the boundary summary for THIS publish
   * (P0-5, "Pre-publication confirmation step").
   *
   * Reset by every edit to the profile, because a confirmation is about the
   * boundaries that were on screen when it was given. Confirming, then moving
   * the System level, then saving would publish something nobody read.
   */
  const [boundariesConfirmed, setBoundariesConfirmed] = useState<boolean>(false);
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await call(window.matchline.profile.sections());
      setSections(data.sections);
      setBlockers(data.blockers);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  useEffect((): void => {
    void refresh();
  }, [refresh, context.draft, context.config]);

  useEffect((): void => {
    setBoundariesConfirmed(false);
  }, [context.draft]);

  useEffect((): (() => void) => {
    let cancelled = false;
    void call(window.matchline.hierarchy.attributes()).then(
      (data): void => {
        if (!cancelled) {
          setAttributes(data.attributes);
        }
      },
      (): void => {
        // The summary degrades to raw attribute keys rather than failing: a
        // person must never be blocked from publishing by a menu that did not
        // load, and the keys still say which field each boundary compares.
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, []);

  const levels = context.draft.hierarchy.levels;
  const boundaries = levels.filter((level) => level.boundary);

  const configured = sections.filter((section) => section.configured).length;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const revision = await onSave(note.trim());
      setBoundariesConfirmed(false);
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

      {blockers.map((blocker: WirePublishBlocker, index: number): JSX.Element => (
        // Addressed by position rather than by set name: a Navisworks set name
        // is whatever somebody typed, spaces and quotes included, and a test id
        // built from one is not a selector.
        <Callout
          key={`${blocker.kind}:${blocker.setName}`}
          tone="error"
          data-testid={`publish-blocker-${String(index)}`}
        >
          {blocker.message}
        </Callout>
      ))}

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
        title="Before you publish: check the boundaries"
        description="A boundary is the one rule nothing overrides — not a manual parent, not the model's own tree. Read this once, then confirm it."
      >
        {levels.length === 0 ? (
          <Callout tone="warning" data-testid="publish-no-levels">
            No levels are configured on screen 6. This profile groups nothing and no boundary
            stops anything nesting.
          </Callout>
        ) : (
          <TableScroll>
            <table className="table" data-testid="publish-boundary-summary">
              <thead>
                <tr>
                  <th>Level, outermost first</th>
                  <th>Structural boundary</th>
                  <th>What it compares</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((level: WireHierarchyLevel): JSX.Element => (
                  <tr key={level.levelId} data-testid={`publish-level-${level.levelId}`}>
                    <td>{level.displayName}</td>
                    <td>
                      {level.boundary ? (
                        <span className="badge">boundary</span>
                      ) : (
                        <span className="muted">grouping only</span>
                      )}
                    </td>
                    <td>
                      {level.boundary ? (
                        boundaryComparisonOf(level, attributes)
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <p data-testid="publish-boundary-consequence">
          {boundaries.length === 0
            ? 'No level is a structural boundary, so nothing stops equipment nesting under ' +
              'anything else in this profile.'
            : `Equipment whose ${boundaries
                .map((level) => level.displayName)
                .join(' or ')} differs from its parent's keeps that parent as a listed ` +
              'dependency instead of nesting under it, and the review queue says which level ' +
              'broke it.'}
        </p>

        <label className="toggle">
          <input
            id="confirm-boundaries"
            type="checkbox"
            data-testid="publish-confirm-boundaries"
            checked={boundariesConfirmed}
            onChange={(event): void => {
              setBoundariesConfirmed(event.target.checked);
            }}
          />
          <span>These boundaries are right</span>
        </label>
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
            disabled={busy || !boundariesConfirmed || blockers.length > 0}
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
        {blockers.length > 0 ? (
          <p className="muted" data-testid="publish-blocked-by-filter">
            {blockers.length === 1
              ? `Saving is off until the '${blockers[0]?.setName ?? ''}' filter is dealt with — ` +
                'a profile that names an unresolved set cannot be compiled, so publishing it ' +
                'would store a revision that never produces a register.'
              : 'Saving is off until the filters named above are dealt with — a profile that ' +
                'names an unresolved set cannot be compiled, so publishing it would store a ' +
                'revision that never produces a register.'}
          </p>
        ) : boundariesConfirmed ? null : (
          <p className="muted" data-testid="publish-blocked">
            Confirm the boundaries above first. They are the decisions this profile makes that
            nothing downstream can undo.
          </p>
        )}
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
