import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type {
  WireClassCount,
  WireCompileStatus,
  WireConfigPatch,
  WireDraftPatch,
  WireDraftProfile,
  WireModelUniverse,
  WireProjectConfig,
  WireProjectSummary,
  WirePropertyCatalogRow,
  WireSourceSummary,
} from '../../../shared/schemas';
import { call, messageOf } from '../api';
import { Workspace } from '../workspace/Workspace';

import { QuickSetup } from './QuickSetup';
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
  { number: 6, title: 'Hierarchy Composer', subtitle: 'Levels, fields and rules' },
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
  /** Every ready model source and the totals over them; `null` when none is. */
  readonly universe: WireModelUniverse | null;
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

/**
 * Which way into a project a person chose.
 *
 * `choose` is the fork a brand-new project opens on; a project that already has
 * a saved revision skips it, because the question "how do you want to set this
 * up?" has an answer already. `quick` and `advanced` write to the SAME draft —
 * the fork is about which surface is in front of you, not about which document
 * you are editing.
 */
type SetupPath = 'choose' | 'quick' | 'advanced';

export function Wizard({
  project,
  justCreated,
  onClosed,
}: {
  readonly project: WireProjectSummary;
  /** True when this project was created a moment ago, so the fork is offered. */
  readonly justCreated: boolean;
  readonly onClosed: () => void;
}): JSX.Element {
  const [screen, setScreen] = useState<number>(1);
  const [setupPath, setSetupPath] = useState<SetupPath>(
    justCreated && project.savedRevision === null ? 'choose' : 'advanced',
  );
  const [inWorkspace, setInWorkspace] = useState<boolean>(false);
  const [draft, setDraft] = useState<WireDraftProfile | null>(null);
  const [config, setConfig] = useState<WireProjectConfig | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(project.savedRevision);
  const [sources, setSources] = useState<readonly WireSourceSummary[]>([]);
  const [universe, setUniverse] = useState<WireModelUniverse | null>(null);
  const [properties, setProperties] = useState<readonly WirePropertyCatalogRow[]>([]);
  const [classes, setClasses] = useState<readonly WireClassCount[]>([]);
  const [compileStatus, setCompileStatus] = useState<WireCompileStatus>({ state: 'never-run' });
  const [error, setError] = useState<string | null>(null);
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
    setUniverse(scanned.universe);

    if (scanned.universe === null) {
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
          // Every draft edit un-saves the profile in main — `savedRevision` is
          // what a compile labels its results with, so a stale number there
          // would name a revision that is not what produced them. The sidebar
          // has to follow, or it goes on saying "Saved revision 3" over a draft
          // that is no longer revision 3, which is the one thing that indicator
          // exists to tell you.
          setSavedRevision(null);
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
        : { draft, config, properties, classes, universe, sources, update, updateConfig, refreshModel },
    [draft, config, properties, classes, universe, sources, update, updateConfig, refreshModel],
  );

  const refreshSourcesAndModel = useCallback(async (): Promise<void> => {
    await refreshSources();
    await refreshModel();
  }, [refreshModel, refreshSources]);

  /**
   * Whether main is holding a view the workspace can read.
   *
   * Three states carry one: a compile that finished, a compile restored from
   * the project file on open, and a failed recompile that left the previous
   * view standing. The button used to require `done`, which meant reopening a
   * project disabled the workspace even though the project file was holding
   * everything the tree needs.
   */
  const compiled =
    compileStatus.state === 'done' ||
    compileStatus.state === 'restored' ||
    (compileStatus.state === 'failed' && compileStatus.staleViewFrom !== null);

  return (
    <div className="wizard">
      <nav className="wizard__nav" aria-label="Site setup steps">
        <div className="wizard__project">
          <span className="wizard__project-name" data-testid="project-name-label">
            {project.name}
          </span>
          <span className="wizard__project-path">{project.path}</span>
        </div>

        <button
          type="button"
          className={`step step--quick${setupPath === 'quick' && !inWorkspace ? ' step--current' : ''}`}
          data-testid="step-quick-setup"
          aria-current={setupPath === 'quick' && !inWorkspace ? 'step' : undefined}
          onClick={(): void => {
            setInWorkspace(false);
            setSetupPath('quick');
          }}
        >
          <span className="step__number">★</span>
          <span className="step__text">
            <span className="step__title">Quick Setup</span>
            <span className="step__subtitle">Suggestions, one decision at a time</span>
          </span>
        </button>

        <ol className="step-list">
          {WIZARD_SCREENS.map((entry: WizardScreen): JSX.Element => (
            <li key={entry.number}>
              <button
                type="button"
                className={`step${screen === entry.number && setupPath !== 'quick' && !inWorkspace ? ' step--current' : ''}`}
                data-testid={`step-${String(entry.number)}`}
                aria-current={
                  screen === entry.number && setupPath !== 'quick' && !inWorkspace
                    ? 'step'
                    : undefined
                }
                onClick={(): void => {
                  setInWorkspace(false);
                  setSetupPath('advanced');
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
              {compileStatus.state === 'restored'
                ? `Compile ${String(compileStatus.compileId)}, restored on open`
                : compiled
                  ? 'Tree, flow, review, exports'
                  : 'Compile on screen 8 first'}
            </span>
          </span>
        </button>

        <div className="wizard__save">
          <label className="wizard__save-label" htmlFor="save-profile">
            Save the site profile
          </label>
          <p className="wizard__save-what">
            Publishing happens on screen 9, where the publish blockers and the boundary summary
            are. Old revisions are kept.
          </p>
          {/*
            This used to save directly, which made it the one way into the store
            that skipped screen 9's gates: a profile naming a selection set
            nobody resolved could be published from here, and the boundary
            summary — the decisions nothing downstream can undo — never had to be
            read. It navigates now. The wording says publishing is a screen, not
            a button, because that is the point of the change.
          */}
          <button
            id="save-profile"
            className="button button--primary"
            type="button"
            data-testid="save-profile"
            onClick={(): void => {
              setInWorkspace(false);
              setSetupPath('advanced');
              setScreen(9);
            }}
          >
            Go to publish
          </button>
          <p className="wizard__revision" data-testid="saved-revision">
            {savedRevision === null
              ? 'Unsaved changes'
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
        ) : setupPath === 'choose' ? (
          <SetupFork
            onQuick={(): void => {
              setSetupPath('quick');
            }}
            onAdvanced={(): void => {
              setSetupPath('advanced');
              setScreen(1);
            }}
          />
        ) : setupPath === 'quick' ? (
          <QuickSetup
            context={context}
            onFinished={(target): void => {
              setSetupPath('advanced');
              setScreen(target);
            }}
            onSwitchToAdvanced={(): void => {
              setSetupPath('advanced');
              setScreen(1);
            }}
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

/**
 * The fork a brand-new project opens on.
 *
 * Two doors onto one draft, and the card says so, because the fear a
 * coordinator has about a "quick" path is that it is a lesser one that has to
 * be redone. It is not: Quick Setup writes the same sections screens 1-9 edit,
 * and the numbered screens stay one click away throughout.
 */
function SetupFork({
  onQuick,
  onAdvanced,
}: {
  readonly onQuick: () => void;
  readonly onAdvanced: () => void;
}): JSX.Element {
  return (
    <div className="screen" data-testid="setup-fork">
      <header className="screen__header">
        <h1 className="screen__title">How do you want to set this up?</h1>
        <p className="screen__lede">
          Both paths build the same Site Profile. You can move between them at any point, and
          nothing you have decided is lost when you do.
        </p>
      </header>

      <div className="fork-grid">
        <section className="fork-card">
          <h2 className="fork-card__title">Quick Setup</h2>
          <p className="fork-card__body">
            One decision per screen, each with a proposal Matchline read out of your model, the
            evidence behind it, and what accepting it does to the numbers. Around an hour on a
            typical site. Nothing is written until you press Accept.
          </p>
          <ul className="fork-card__list">
            <li>Suggested tag, description, building, discipline and type properties</li>
            <li>A tag shape inferred by trying candidates against your real tags</li>
            <li>Six standard System Resolver arrangements, each previewed first</li>
            <li>Class include/exclude judged by which classes carry tags</li>
            <li>The standard level stack, with the boundary consequence stated</li>
          </ul>
          <button
            className="button button--primary"
            type="button"
            data-testid="choose-quick"
            onClick={onQuick}
          >
            Start Quick Setup
          </button>
        </section>

        <section className="fork-card">
          <h2 className="fork-card__title">Full setup</h2>
          <p className="fork-card__body">
            The nine numbered screens. Every property in the catalogue with its coverage, fallback
            chains and per-source overrides, the tag anatomy taught by hand, your own derived
            fields and source-assignment rules. Use this when the site does not look like anything
            standard — or come here after Quick Setup to refine what it proposed.
          </p>
          <ul className="fork-card__list">
            <li>Ordered fallback chains, with per-file overrides</li>
            <li>Fields this site defines for itself</li>
            <li>What a whole model file asserts</li>
            <li>Role and relationship rules</li>
          </ul>
          <button
            className="button"
            type="button"
            data-testid="choose-advanced"
            onClick={onAdvanced}
          >
            Go to screen 1
          </button>
        </section>
      </div>
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
