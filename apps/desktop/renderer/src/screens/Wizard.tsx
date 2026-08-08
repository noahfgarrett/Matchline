import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type {
  WireClassCount,
  WireDraftPatch,
  WireDraftProfile,
  WireModelScan,
  WireProjectSummary,
  WirePropertyCatalogRow,
  WireSourceSummary,
} from '../../../shared/schemas';
import { call, messageOf } from '../api';

import { Screen1Sources } from './Screen1Sources';
import { Screen2Model } from './Screen2Model';
import { Screen3Assets } from './Screen3Assets';
import { Screen4Anatomy } from './Screen4Anatomy';
import { Screen5Resolver } from './Screen5Resolver';

/**
 * The Site Setup wizard shell (PRODUCT.md §7).
 *
 * All nine screens are listed from the start. Screens 6-9 are visible and
 * disabled rather than hidden, because the shape of the work is part of the
 * promise the first screen makes — "about an hour" is only credible if you can
 * see how far it goes.
 *
 * The draft Site Profile lives in the main process. This component holds a
 * mirror of it for rendering and re-reads that mirror from every `profile:update`
 * response, so the screen can never drift from what main will actually save.
 */

export interface WizardScreen {
  readonly number: number;
  readonly title: string;
  readonly subtitle: string;
  readonly available: boolean;
}

export const WIZARD_SCREENS: readonly WizardScreen[] = [
  { number: 1, title: 'Project sources', subtitle: 'Models and spreadsheets', available: true },
  { number: 2, title: 'Model scan', subtitle: 'What the model contains', available: true },
  { number: 3, title: 'Asset definition', subtitle: 'What counts as equipment', available: true },
  { number: 4, title: 'Tag anatomy', subtitle: 'How your tags decompose', available: true },
  { number: 5, title: 'System Resolver', subtitle: 'Where systems come from', available: true },
  { number: 6, title: 'Hierarchy Composer', subtitle: 'Next round', available: false },
  { number: 7, title: 'Relationship rules', subtitle: 'Next round', available: false },
  { number: 8, title: 'Preview and QA', subtitle: 'Next round', available: false },
  { number: 9, title: 'Publish Site Profile', subtitle: 'Next round', available: false },
];

/** How many catalog rows the property pickers offer. Sorted by coverage. */
const PICKER_PROPERTY_LIMIT = 500;

export interface WizardContext {
  readonly draft: WireDraftProfile;
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly classes: readonly WireClassCount[];
  readonly scan: WireModelScan | null;
  readonly sources: readonly WireSourceSummary[];
  /**
   * Writes one section, computed from the draft as it stands *now*.
   *
   * The updater is a function rather than a literal patch on purpose. A screen
   * builds a whole section — `{...mappings, building: ref}` — from the draft it
   * last rendered, and two picks in quick succession both render before either
   * round-trips, so the second would rebuild from the pre-first draft and quietly
   * undo the first. Handing the current draft to the updater, and running
   * updaters one at a time, makes that impossible.
   */
  update: (build: (draft: WireDraftProfile) => WireDraftPatch) => Promise<void>;
  refreshModel: () => Promise<void>;
}

export function Wizard({
  project,
  onClosed,
}: {
  readonly project: WireProjectSummary;
  readonly onClosed: () => void;
}): JSX.Element {
  const [screen, setScreen] = useState<number>(1);
  const [draft, setDraft] = useState<WireDraftProfile | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(project.savedRevision);
  const [sources, setSources] = useState<readonly WireSourceSummary[]>([]);
  const [scan, setScan] = useState<WireModelScan | null>(null);
  const [properties, setProperties] = useState<readonly WirePropertyCatalogRow[]>([]);
  const [classes, setClasses] = useState<readonly WireClassCount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  /** The draft as main last confirmed it, readable without waiting for a render. */
  const latestDraft = useRef<WireDraftProfile | null>(null);
  /** Serializes writes, so two edits can never race over one section. */
  const updateQueue = useRef<Promise<void>>(Promise.resolve());

  const refreshSources = useCallback(async (): Promise<void> => {
    const data = await call(window.matchline.source.list());
    setSources(data.sources);
  }, []);

  /**
   * Re-reads everything that depends on which model is loaded. Called after any
   * source change, because adding or removing a cache changes screens 2-5 whole.
   */
  const refreshModel = useCallback(async (): Promise<void> => {
    const scanned = await call(window.matchline.model.scan());
    setScan(scanned.scan);

    if (scanned.scan === null) {
      setProperties([]);
      setClasses([]);
      return;
    }

    const [page, classList] = await Promise.all([
      call(
        window.matchline.model.propertyPage({
          offset: 0,
          limit: PICKER_PROPERTY_LIMIT,
          sortBy: 'coverage',
          descending: true,
          search: '',
        }),
      ),
      call(window.matchline.model.classList()),
    ]);
    setProperties(page.rows);
    setClasses(classList.classes);
  }, []);

  useEffect((): (() => void) => {
    let cancelled = false;

    void (async (): Promise<void> => {
      try {
        const state = await call(window.matchline.profile.draft());
        if (cancelled) {
          return;
        }
        latestDraft.current = state.draft;
        setDraft(state.draft);
        setSavedRevision(state.savedRevision);
        await refreshSources();
        await refreshModel();
      } catch (caught: unknown) {
        if (!cancelled) {
          setError(messageOf(caught));
        }
      }
    })();

    return (): void => {
      cancelled = true;
    };
  }, [refreshModel, refreshSources]);

  const update = useCallback(
    async (build: (current: WireDraftProfile) => WireDraftPatch): Promise<void> => {
      const run = async (): Promise<void> => {
        const current = latestDraft.current;
        if (current === null) {
          return;
        }
        try {
          const result = await call(
            window.matchline.profile.update({ patch: build(current) }),
          );
          latestDraft.current = result.draft;
          setDraft(result.draft);
          setError(null);
        } catch (caught: unknown) {
          setError(messageOf(caught));
        }
      };

      // Chained through `finally` so one failed write cannot wedge the queue.
      const queued = updateQueue.current.then(run, run);
      updateQueue.current = queued;
      await queued;
    },
    [],
  );

  const saveProfile = useCallback(async (): Promise<void> => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const result = await call(window.matchline.profile.save({ note: saveNote.trim() }));
      setSavedRevision(result.revision);
      setSaveMessage(`Saved as revision ${String(result.revision)}.`);
      setError(null);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  }, [saveNote]);

  const closeProject = useCallback(async (): Promise<void> => {
    try {
      await call(window.matchline.project.close());
    } catch {
      // Closing is best-effort: the session is being abandoned either way.
    }
    onClosed();
  }, [onClosed]);

  const context: WizardContext | null = useMemo(
    (): WizardContext | null =>
      draft === null
        ? null
        : { draft, properties, classes, scan, sources, update, refreshModel },
    [draft, properties, classes, scan, sources, update, refreshModel],
  );

  const refreshSourcesAndModel = useCallback(async (): Promise<void> => {
    await refreshSources();
    await refreshModel();
  }, [refreshModel, refreshSources]);

  return (
    <div className="wizard">
      <nav className="wizard__nav" aria-label="Site setup steps">
        <div className="wizard__project">
          <span className="wizard__project-name" data-testid="project-name-label">
            {project.name}
          </span>
          <span className="wizard__project-path">{project.path}</span>
        </div>

        <ol className="step-list">
          {WIZARD_SCREENS.map((entry: WizardScreen): JSX.Element => (
            <li key={entry.number}>
              <button
                type="button"
                className={`step${screen === entry.number ? ' step--current' : ''}`}
                data-testid={`step-${String(entry.number)}`}
                disabled={!entry.available}
                aria-current={screen === entry.number ? 'step' : undefined}
                onClick={(): void => {
                  setScreen(entry.number);
                }}
              >
                <span className="step__number">{entry.number}</span>
                <span className="step__text">
                  <span className="step__title">{entry.title}</span>
                  <span className="step__subtitle">{entry.subtitle}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>

        <div className="wizard__save">
          <label className="wizard__save-label" htmlFor="save-note">
            Save the site profile
          </label>
          <p className="wizard__save-what">
            Writes everything you have decided so far into the project as a new revision.
            Old revisions are kept.
          </p>
          <input
            id="save-note"
            className="control control--text"
            type="text"
            placeholder="What changed?"
            data-testid="save-note"
            value={saveNote}
            onChange={(event): void => {
              setSaveNote(event.target.value);
            }}
          />
          <button
            className="button button--primary"
            type="button"
            data-testid="save-profile"
            disabled={saving}
            onClick={(): void => {
              void saveProfile();
            }}
          >
            {saving ? 'Saving…' : 'Save profile'}
          </button>
          <p className="wizard__revision" data-testid="saved-revision">
            {savedRevision === null
              ? 'Not saved yet'
              : `Saved revision ${String(savedRevision)}`}
          </p>
          <button
            className="button button--quiet"
            type="button"
            onClick={(): void => {
              void closeProject();
            }}
          >
            Close project
          </button>
        </div>
      </nav>

      <main className="wizard__main">
        {error === null ? null : (
          <p className="callout callout--error" role="alert" data-testid="wizard-error">
            {error}
          </p>
        )}
        {saveMessage === null ? null : (
          <p className="callout callout--success" role="status" data-testid="save-message">
            {saveMessage}
          </p>
        )}

        {context === null ? (
          <p className="callout callout--info">Loading this project…</p>
        ) : (
          <ScreenBody screen={screen} context={context} onSourcesChanged={refreshSourcesAndModel} />
        )}
      </main>
    </div>
  );
}

function ScreenBody({
  screen,
  context,
  onSourcesChanged,
}: {
  readonly screen: number;
  readonly context: WizardContext;
  readonly onSourcesChanged: () => Promise<void>;
}): JSX.Element {
  switch (screen) {
    case 1:
      return <Screen1Sources context={context} onSourcesChanged={onSourcesChanged} />;
    case 2:
      return <Screen2Model context={context} />;
    case 3:
      return <Screen3Assets context={context} />;
    case 4:
      return <Screen4Anatomy context={context} />;
    case 5:
      return <Screen5Resolver context={context} />;
    default:
      return (
        <p className="callout callout--info">
          This screen arrives in the next round. Screens 1 to 5 are ready now.
        </p>
      );
  }
}
