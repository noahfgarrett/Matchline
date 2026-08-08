import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type {
  WireClassCount,
  WireCompileStatus,
  WireConfigPatch,
  WireDraftPatch,
  WireDraftProfile,
  WireModelScan,
  WireProjectConfig,
  WireProjectSummary,
  WirePropertyCatalogRow,
  WireSourceSummary,
} from '../../../shared/schemas';
import { call, messageOf } from '../api';
import { Workspace } from '../workspace/Workspace';

import { Screen1Sources } from './Screen1Sources';
import { Screen2Model } from './Screen2Model';
import { Screen3Assets } from './Screen3Assets';
import { Screen4Anatomy } from './Screen4Anatomy';
import { Screen5Resolver } from './Screen5Resolver';
import { Screen6Hierarchy } from './Screen6Hierarchy';
import { Screen7Relationships } from './Screen7Relationships';
import { Screen8Preview } from './Screen8Preview';
import { Screen9Publish } from './Screen9Publish';

/**
 * The Site Setup wizard shell (PRODUCT.md §7), and the project workspace it
 * opens onto.
 *
 * The draft Site Profile and the screens 6-7 sections both live in the main
 * process. This component holds a mirror of each for rendering and re-reads
 * that mirror from every write's response, so a screen can never drift from
 * what main will actually compile.
 */

export interface WizardScreen {
  readonly number: number;
  readonly title: string;
  readonly subtitle: string;
}

export const WIZARD_SCREENS: readonly WizardScreen[] = [
  { number: 1, title: 'Project sources', subtitle: 'Models and spreadsheets' },
  { number: 2, title: 'Model scan', subtitle: 'What the model contains' },
  { number: 3, title: 'Asset definition', subtitle: 'What counts as equipment' },
  { number: 4, title: 'Tag anatomy', subtitle: 'How your tags decompose' },
  { number: 5, title: 'System Resolver', subtitle: 'Where systems come from' },
  { number: 6, title: 'Hierarchy Composer', subtitle: 'Levels and boundaries' },
  { number: 7, title: 'Relationship rules', subtitle: 'What may parent what' },
  { number: 8, title: 'Preview and QA', subtitle: 'Compile and check' },
  { number: 9, title: 'Publish Site Profile', subtitle: 'Save and reuse' },
];

/** How many catalog rows the property pickers offer. Sorted by coverage. */
const PICKER_PROPERTY_LIMIT = 500;

export interface WizardContext {
  readonly draft: WireDraftProfile;
  readonly config: WireProjectConfig;
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
  /**
   * Writes one screens-6/7 section.
   *
   * A plain patch rather than an updater: these sections are whole values the
   * screen already holds (a level list, a rule list), so there is no
   * read-modify-write to lose. Writes are still queued, so two fast edits land
   * in order.
   */
  updateConfig: (patch: WireConfigPatch) => Promise<void>;
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
  const [inWorkspace, setInWorkspace] = useState<boolean>(false);
  const [draft, setDraft] = useState<WireDraftProfile | null>(null);
  const [config, setConfig] = useState<WireProjectConfig | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(project.savedRevision);
  const [sources, setSources] = useState<readonly WireSourceSummary[]>([]);
  const [scan, setScan] = useState<WireModelScan | null>(null);
  const [properties, setProperties] = useState<readonly WirePropertyCatalogRow[]>([]);
  const [classes, setClasses] = useState<readonly WireClassCount[]>([]);
  const [compileStatus, setCompileStatus] = useState<WireCompileStatus>({ state: 'never-run' });
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
        const [state, configState, status] = await Promise.all([
          call(window.matchline.profile.draft()),
          call(window.matchline.config.get()),
          call(window.matchline.compile.status()),
        ]);
        if (cancelled) {
          return;
        }
        latestDraft.current = state.draft;
        setDraft(state.draft);
        setConfig(configState.config);
        setSavedRevision(state.savedRevision);
        setCompileStatus(status.status);
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

  /** Chained through `finally` so one failed write cannot wedge the queue. */
  const enqueue = useCallback(async (run: () => Promise<void>): Promise<void> => {
    const queued = updateQueue.current.then(run, run);
    updateQueue.current = queued;
    await queued;
  }, []);

  const update = useCallback(
    async (build: (current: WireDraftProfile) => WireDraftPatch): Promise<void> => {
      await enqueue(async (): Promise<void> => {
        const current = latestDraft.current;
        if (current === null) {
          return;
        }
        try {
          const result = await call(window.matchline.profile.update({ patch: build(current) }));
          latestDraft.current = result.draft;
          setDraft(result.draft);
          setError(null);
        } catch (caught: unknown) {
          setError(messageOf(caught));
        }
      });
    },
    [enqueue],
  );

  const updateConfig = useCallback(
    async (patch: WireConfigPatch): Promise<void> => {
      await enqueue(async (): Promise<void> => {
        try {
          const result = await call(window.matchline.config.update({ patch }));
          setConfig(result.config);
          setError(null);
        } catch (caught: unknown) {
          setError(messageOf(caught));
        }
      });
    },
    [enqueue],
  );

  const saveProfile = useCallback(
    async (note: string): Promise<number | null> => {
      setSaving(true);
      setSaveMessage(null);
      try {
        const result = await call(window.matchline.profile.save({ note }));
        setSavedRevision(result.revision);
        setSaveMessage(`Saved as revision ${String(result.revision)}.`);
        setError(null);
        return result.revision;
      } catch (caught: unknown) {
        setError(messageOf(caught));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  /** After an imported package: re-read both mirrors from main. */
  const reloadFromMain = useCallback(async (): Promise<void> => {
    const [state, configState, status] = await Promise.all([
      call(window.matchline.profile.draft()),
      call(window.matchline.config.get()),
      call(window.matchline.compile.status()),
    ]);
    latestDraft.current = state.draft;
    setDraft(state.draft);
    setConfig(configState.config);
    setSavedRevision(state.savedRevision);
    setCompileStatus(status.status);
  }, []);

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
      draft === null || config === null
        ? null
        : { draft, config, properties, classes, scan, sources, update, updateConfig, refreshModel },
    [draft, config, properties, classes, scan, sources, update, updateConfig, refreshModel],
  );

  const refreshSourcesAndModel = useCallback(async (): Promise<void> => {
    await refreshSources();
    await refreshModel();
  }, [refreshModel, refreshSources]);

  const compiled = compileStatus.state === 'done';

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
                className={`step${screen === entry.number && !inWorkspace ? ' step--current' : ''}`}
                data-testid={`step-${String(entry.number)}`}
                aria-current={screen === entry.number && !inWorkspace ? 'step' : undefined}
                onClick={(): void => {
                  setInWorkspace(false);
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

        <button
          type="button"
          className={`step step--workspace${inWorkspace ? ' step--current' : ''}`}
          data-testid="open-workspace"
          disabled={!compiled}
          aria-current={inWorkspace ? 'step' : undefined}
          onClick={(): void => {
            setInWorkspace(true);
          }}
        >
          <span className="step__number">→</span>
          <span className="step__text">
            <span className="step__title">Project workspace</span>
            <span className="step__subtitle">
              {compiled ? 'Tree, flow, review, exports' : 'Compile on screen 8 first'}
            </span>
          </span>
        </button>

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
              void saveProfile(saveNote.trim());
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
        ) : inWorkspace ? (
          <Workspace
            projectName={project.name}
            status={compileStatus}
            onStatusChange={setCompileStatus}
          />
        ) : (
          <ScreenBody
            screen={screen}
            context={context}
            savedRevision={savedRevision}
            onSourcesChanged={refreshSourcesAndModel}
            onSave={saveProfile}
            onImported={reloadFromMain}
            onCompiled={(): void => {
              void call(window.matchline.compile.status()).then(
                (data): void => {
                  setCompileStatus(data.status);
                },
                (): void => {
                  // The compile itself already reported; a status re-read that
                  // fails changes nothing the user can act on.
                },
              );
            }}
          />
        )}
      </main>
    </div>
  );
}

function ScreenBody({
  screen,
  context,
  savedRevision,
  onSourcesChanged,
  onSave,
  onImported,
  onCompiled,
}: {
  readonly screen: number;
  readonly context: WizardContext;
  readonly savedRevision: number | null;
  readonly onSourcesChanged: () => Promise<void>;
  readonly onSave: (note: string) => Promise<number | null>;
  readonly onImported: () => Promise<void>;
  readonly onCompiled: () => void;
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
    case 6:
      return <Screen6Hierarchy context={context} />;
    case 7:
      return <Screen7Relationships context={context} />;
    case 8:
      return <Screen8Preview context={context} onCompiled={onCompiled} />;
    case 9:
      return (
        <Screen9Publish
          context={context}
          savedRevision={savedRevision}
          onSave={onSave}
          onImported={onImported}
        />
      );
    default:
      return <p className="callout callout--info">That screen does not exist.</p>;
  }
}
