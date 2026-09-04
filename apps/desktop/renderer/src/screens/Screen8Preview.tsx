import { useCallback, useEffect, useState, type JSX } from 'react';

import type {
  WireCompileIssueKind,
  WireCompileIssueRow,
  WireCompileStatus,
  WireCompileSummary,
  WireLedgerEvent,
  WireLevelCompleteness,
} from '../../../shared/schemas';
import { call, count, messageOf } from '../api';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';

import type { WizardContext } from './Wizard';

/**
 * Screen 8 — Preview and QA (PRODUCT.md §7 screen 8).
 *
 * The checklist §7 asks for, as cards that open the list behind them. Every
 * number is a count the compiler produced; the cards add only the sentence that
 * says what the number means and whether it is something to act on.
 *
 * Compile state is honest. The pipeline runs on a worker thread now, so the
 * window keeps drawing while it works, the panel reports which stage it is on
 * out of how many, and Stop actually stops it — a cancelled compile leaves the
 * project file untouched and the previous compile still open in the workspace.
 * A failure shows the message the service wrote rather than a generic one.
 */

const PAGE_SIZE = 100;

interface Card {
  readonly kind: WireCompileIssueKind;
  readonly label: string;
  readonly hint: string;
  readonly value: (summary: WireCompileSummary) => number;
  /** Whether a non-zero count is something to look at, or just the size of the job. */
  readonly tone: 'neutral' | 'attention';
}

const CARDS: readonly Card[] = [
  {
    kind: 'assets',
    label: 'Assets',
    hint: 'Equipment the model defines',
    value: (summary) => summary.assetCount,
    tone: 'neutral',
  },
  {
    kind: 'flow-nodes',
    label: 'Flow nodes',
    hint: 'Things the connectivity sources name',
    value: (summary) => summary.flowNodeCount,
    tone: 'neutral',
  },
  {
    kind: 'flow-nodes',
    label: 'Model-confirmed',
    hint: 'Flow nodes matched to a model asset',
    value: (summary) => summary.modelConfirmedCount,
    tone: 'neutral',
  },
  {
    kind: 'flow-nodes',
    label: 'Flow-only',
    hint: 'Named by a one-line, absent from the model',
    value: (summary) => summary.flowOnlyCount,
    tone: 'attention',
  },
  {
    kind: 'flow-nodes',
    label: 'PMD-only',
    hint: 'Instruments the model does not carry',
    value: (summary) => summary.pmdOnlyCount,
    tone: 'attention',
  },
  {
    kind: 'demotions',
    label: 'Cross-boundary demotions',
    hint: 'Parents that became dependencies',
    value: (summary) => summary.demotionCount,
    tone: 'attention',
  },
  {
    kind: 'duplicate-tags',
    label: 'Duplicate tags',
    hint: 'One tag on more than one object',
    value: (summary) => summary.duplicateTagCount,
    tone: 'attention',
  },
  {
    kind: 'ambiguous-parents',
    label: 'Ambiguous parents',
    hint: 'A rung offered two answers and stopped',
    value: (summary) => summary.ambiguousParentCount,
    tone: 'attention',
  },
  {
    kind: 'cycles',
    label: 'Cycles',
    hint: 'Loops in the hierarchy or the feeds',
    value: (summary) => summary.cycleCount,
    tone: 'attention',
  },
  {
    kind: 'missing-systems',
    label: 'Missing systems',
    hint: 'Assets no resolver rung could place',
    value: (summary) => summary.missingSystemCount,
    tone: 'attention',
  },
  {
    kind: 'system-conflicts',
    label: 'Conflicting system evidence',
    hint: 'Rungs that disagreed about a key',
    value: (summary) => summary.systemConflictCount,
    tone: 'attention',
  },
  {
    kind: 'unresolved-parents',
    label: 'Unplaced equipment',
    hint: 'No structural decision could be made',
    value: (summary) => summary.unresolvedParentCount,
    tone: 'attention',
  },
  {
    kind: 'review-items',
    label: 'Review queue',
    hint: 'Everything waiting for a decision',
    value: (summary) => summary.reviewItemCount,
    tone: 'attention',
  },
];

export function Screen8Preview({
  context,
  onCompiled,
}: {
  readonly context: WizardContext;
  readonly onCompiled: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<WireCompileStatus>({ state: 'never-run' });
  const [running, setRunning] = useState<boolean>(false);
  /** What main last said it was doing, polled while a compile is outstanding. */
  const [progress, setProgress] = useState<WireCompileStatus | null>(null);
  const [openKind, setOpenKind] = useState<WireCompileIssueKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    let cancelled = false;
    void call(window.matchline.compile.status()).then(
      (data): void => {
        if (cancelled) {
          return;
        }
        setStatus(data.status);
        if (data.status.state === 'running') {
          // A compile started before this screen was mounted — the user
          // navigated away and came back, or reloaded the window mid-run. The
          // panel used to draw as if nothing were happening, so the only
          // evidence of a multi-minute compile was that Compile did nothing
          // when pressed. Entering the running state here starts the poll below
          // and puts the progress line back.
          setRunning(true);
          setProgress(data.status);
        }
      },
      (): void => {
        // A status read that fails leaves the screen in never-run, which is
        // what it would show anyway.
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, []);

  /**
   * Follows the compile while it runs.
   *
   * Polled rather than pushed: `compile:run` does not resolve until the worker
   * has returned, and every other channel goes on answering in the meantime —
   * which is the whole point of moving the compile off the main loop, and is
   * also the cheapest possible proof that it worked.
   */
  useEffect((): (() => void) | undefined => {
    if (!running) {
      return undefined;
    }
    const timer = setInterval((): void => {
      void call(window.matchline.compile.status()).then(
        (data): void => {
          if (data.status.state === 'running') {
            setProgress(data.status);
            return;
          }
          // The compile settled. Usually `compile()`'s own await has already
          // said so and this is redundant; it is not redundant for a compile
          // this screen did not start — one adopted on mount — where the poll
          // is the only thing watching.
          setStatus(data.status);
          setRunning(false);
          setProgress(null);
          if (data.status.state === 'done') {
            onCompiled();
          }
        },
        (): void => {
          // A dropped status read says nothing about the compile itself; the
          // run's own answer is what settles it.
        },
      );
    }, 250);
    return (): void => {
      clearInterval(timer);
    };
  }, [running, onCompiled]);

  const compile = useCallback(async (): Promise<void> => {
    setRunning(true);
    setError(null);
    setOpenKind(null);
    setProgress(null);
    try {
      const data = await call(window.matchline.compile.run());
      setStatus(data.status);
      if (data.status.state === 'done') {
        onCompiled();
      }
    } catch (caught: unknown) {
      setError(messageOf(caught));
      // The transport failed rather than the compile, so nothing here knows
      // whether a previous view survived; main's own status is the authority on
      // that and this screen is only reporting what it saw.
      setStatus({ state: 'failed', reason: messageOf(caught), staleViewFrom: null });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [onCompiled]);

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await call(window.matchline.compile.cancel());
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  const summary = status.state === 'done' ? status.summary : null;

  return (
    <div className="screen" data-testid="screen-8">
      <header className="screen__header">
        <h1 className="screen__title">8. Preview and QA</h1>
        <p className="screen__lede">
          Runs the whole pipeline over this project’s real sources and reports what it found.
          Nothing here is a warning about a rule — every number is about your site, and every
          card opens the list behind it.
        </p>
      </header>

      <Panel
        title="Compile"
        description="Reads the model cache, the connectivity workbooks and the MEL, then builds the hierarchy, the flow and the generated MEL."
        actions={
          <>
            <button
              className="button button--primary"
              type="button"
              data-testid="compile-run"
              disabled={running}
              onClick={(): void => {
                void compile();
              }}
            >
              {running ? 'Compiling…' : 'Compile'}
            </button>
            {running ? (
              <button
                className="button"
                type="button"
                data-testid="compile-cancel"
                onClick={(): void => {
                  void cancel();
                }}
              >
                Stop
              </button>
            ) : null}
          </>
        }
      >
        {running ? (
          <Callout tone="info">
            <span data-testid="compile-progress">
              {progress !== null && progress.state === 'running' && progress.stageIndex > 0
                ? `${progress.note} (step ${count(progress.stageIndex)} of ${count(progress.stageCount)})`
                : 'Starting the compile.'}
            </span>{' '}
            It runs on a worker thread, so the rest of the app stays usable — and Stop really
            stops it, leaving the project exactly as it is.
          </Callout>
        ) : null}
        {status.state === 'cancelled' && !running ? (
          <Callout tone="info">
            The compile was stopped. Nothing was written to the project, and whatever the last
            finished compile produced is still what the workspace is showing.
          </Callout>
        ) : null}
        {error === null ? null : <Callout tone="error">{error}</Callout>}
        {status.state === 'failed' && error === null ? (
          <Callout tone="error">{status.reason}</Callout>
        ) : null}
        {status.state === 'never-run' && !running ? (
          <Callout tone="info">
            Not compiled yet. The project workspace — the SSM tree, Electrical Flow, the review
            queue and every export — opens once this has run.
          </Callout>
        ) : null}
        {status.state === 'restored' && !running ? (
          <Callout tone="info" data-testid="compile-restored">
            Showing compile {status.compileId} from{' '}
            {status.at.slice(0, 16).replace('T', ' ')} — {count(status.assetCount)} assets, read
            back from this project when it was opened. The hierarchy, the tag search, the review
            queue and the register exports work from it; the checklist below, the electrical
            projection and the previews are built from the model, so recompile to refresh.
          </Callout>
        ) : null}
        {summary === null ? null : (
          <p className="muted" data-testid="compile-meta">
            {summary.compileId === null
              ? 'This compile was not saved.'
              : `Compile ${String(summary.compileId)} from profile revision ${String(summary.profileRevision)}.`}{' '}
            Finished in {count(summary.durationMs)} ms. {count(summary.generatedMelRowCount)} rows
            in the generated MEL.
          </p>
        )}
        {status.state === 'done' && status.unsavedDraft ? (
          <Callout tone="warning" data-testid="compile-unsaved-draft">
            Compiled from an unsaved draft, so nothing was written to the project: no compile
            row, no snapshot and no revision. The numbers below are real — publish on screen 9 to
            keep them, and to make this the compile the project reopens onto.
          </Callout>
        ) : null}
      </Panel>

      {summary === null ? null : (
        <>
          <Panel title="What the compile found">
            <div className="card-grid" data-testid="compile-cards">
              {CARDS.map((card: Card, index: number): JSX.Element => {
                const value = card.value(summary);
                const isOpen = openKind === card.kind;
                return (
                  <button
                    key={`${card.kind}-${String(index)}`}
                    type="button"
                    className={`qa-card${isOpen ? ' qa-card--open' : ''}${
                      card.tone === 'attention' && value > 0 ? ' qa-card--attention' : ''
                    }`}
                    data-testid={`card-${card.label.toLowerCase().replace(/[^a-z]+/g, '-')}`}
                    onClick={(): void => {
                      setOpenKind(isOpen ? null : card.kind);
                    }}
                  >
                    <span className="qa-card__value">{count(value)}</span>
                    <span className="qa-card__label">{card.label}</span>
                    <span className="qa-card__hint">{card.hint}</span>
                  </button>
                );
              })}
            </div>
          </Panel>

          {openKind === null ? null : <IssueList kind={openKind} />}

          <CompletenessPanel summary={summary} />

          <IdentityPanel summary={summary} />

          {summary.skippedClaimInputCount === 0 ? null : (
            <Callout tone="warning">
              {count(summary.skippedClaimInputCount)} relationship inputs named something this
              compile does not know — a tag that resolved to nothing, or a parent outside the
              asset set. They produced no claim rather than an invented one.
            </Callout>
          )}
          {summary.learnedProposalCount === 0 ? null : (
            <Callout tone="info">
              {count(summary.learnedProposalCount)} learned pairings were proposed. Proposals never
              build hierarchy; they are in the review queue.
            </Callout>
          )}
          <Callout tone={summary.undecidedReviewItemCount === 0 ? 'success' : 'info'}>
            {summary.undecidedReviewItemCount === 0
              ? 'Every review item has a decision recorded against it.'
              : `${count(summary.undecidedReviewItemCount)} of ${count(summary.reviewItemCount)} review items are still undecided. The Review tab in the workspace is where they are settled.`}
          </Callout>
        </>
      )}

      {context.draft.hierarchy.levels.length === 0 ? (
        <Callout tone="warning">
          No hierarchy levels are configured on screen 6, so this compile groups nothing and no
          boundary stops anything nesting.
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * How much of the site this compile actually described (audit blocker B3).
 *
 * Every other card on this screen counts something the engine *did*. This one
 * counts what is still missing, and it exists because the most expensive
 * failure this app has is a compile that succeeds and describes nothing: a
 * boundary level nobody states a value for refuses every nesting on the site,
 * so the register comes out complete, every asset is a root, and no number
 * anywhere says why.
 *
 * Read straight off `summary.completeness`, which the engine reports from the
 * fold's own decisions. Nothing here is recomputed — a second count could
 * disagree with the snapshot it is describing, and a site would then have two
 * answers to "is my equipment nested".
 */
function CompletenessPanel({ summary }: { readonly summary: WireCompileSummary }): JSX.Element {
  const completeness = summary.completeness;
  const blocking = completeness.levels.filter((level) => level.blocksNesting);

  return (
    <Panel
      title="Completeness"
      description="Not what the compile did, but how much of the site it left unsaid. A level nobody states a value for is the one failure that looks like success."
    >
      <StatRow>
        <Stat
          label="Nested"
          value={count(completeness.assetsNested)}
          hint={`of ${count(completeness.assetCount)} assets`}
        />
        <Stat
          label="Roots"
          value={count(completeness.assetsRooted)}
          hint={
            completeness.assetsRooted === completeness.assetCount
              ? 'every asset — nothing nested at all'
              : 'top of their own grouping'
          }
        />
        <Stat
          label="No parent candidate"
          value={count(completeness.assetsWithNoParentCandidate)}
          hint={
            completeness.assetsWithNoParentCandidate === 0
              ? 'every asset had somewhere to go'
              : 'no rung proposed a parent at all'
          }
        />
        <Stat
          label="No system"
          value={count(completeness.assetsWithoutSystem)}
          hint={
            completeness.assetsWithoutSystem === 0
              ? 'every asset was placed'
              : 'no resolver rung answered'
          }
        />
        <Stat
          label="MEL rows dropped"
          value={count(completeness.melRowsDropped)}
          hint={
            completeness.melRowsDropped === 0
              ? 'every asset produced a row'
              : 'assets that produced no register row'
          }
        />
      </StatRow>

      {blocking.length === 0 ? null : (
        <Callout tone="error" data-testid="completeness-blocking">
          {blocking
            .map(
              (level) =>
                `${count(level.assetsWithoutValue)} assets have no ${level.displayName} value`,
            )
            .join('; ')}
          . {blocking.length === 1 ? 'That level is' : 'Those levels are'} a structural boundary,
          so these cannot nest under anything — a boundary refuses a parent whose value differs,
          and an asset with no value differs from every parent there is. Map a property for it on
          screen 3, or turn the boundary off on screen 6.
        </Callout>
      )}

      {completeness.levels.length === 0 ? (
        <Callout tone="warning">
          No hierarchy levels are configured, so there is nothing to group by and no boundary to
          state. Screen 6 is where the level stack is built.
        </Callout>
      ) : (
        <TableScroll>
          <table className="table table--compact" data-testid="completeness-levels">
            <thead>
              <tr>
                <th>Level, outermost first</th>
                <th>Compares</th>
                <th>Boundary</th>
                <th>Assets with no value</th>
              </tr>
            </thead>
            <tbody>
              {completeness.levels.map((level: WireLevelCompleteness): JSX.Element => (
                <tr key={level.levelId} data-testid={`completeness-${level.levelId}`}>
                  <td>{level.displayName === '' ? level.levelId : level.displayName}</td>
                  <td className="muted">{level.attributeKey}</td>
                  <td>
                    {level.boundary ? (
                      <span className="badge">boundary</span>
                    ) : (
                      <span className="muted">grouping only</span>
                    )}
                  </td>
                  <td>
                    {level.assetsWithoutValue === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      <>
                        {count(level.assetsWithoutValue)}
                        {level.blocksNesting ? (
                          <>
                            {' '}
                            <span className="badge badge--file-missing">cannot nest</span>
                          </>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {completeness.unresolvedSystemBySkipReason.length === 0 ? null : (
        <>
          <h3 className="panel__subtitle">Why the resolver came up empty</h3>
          <TableScroll>
            <table className="table table--compact" data-testid="completeness-skip-reasons">
              <thead>
                <tr>
                  <th>Every rung skipped, because</th>
                  <th>Assets</th>
                </tr>
              </thead>
              <tbody>
                {completeness.unresolvedSystemBySkipReason.map((group): JSX.Element => (
                  <tr key={group.skipReasons.join('|')}>
                    <td className="muted">
                      {group.skipReasons.length === 0
                        ? 'no rung was configured at all'
                        : group.skipReasons.join(', ')}
                    </td>
                    <td>{count(group.assetCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
    </Panel>
  );
}

/**
 * What the asset identity ledger did this compile (P0-9).
 *
 * Its own panel rather than another QA card, because these are not defects.
 * A tag correction that kept its asset id is the thing working, and the numbers
 * that matter are the ones that say identity moved — a split, an asset that
 * disappeared, a decision that could no longer be re-addressed.
 */
function IdentityPanel({ summary }: { readonly summary: WireCompileSummary }): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const moved =
    summary.ledgerTagChangedCount +
    summary.ledgerRematchedByTagCount +
    summary.ledgerSplitCount +
    summary.ledgerDisappearedCount;

  return (
    <Panel
      title="Asset identity"
      description="An asset id outlives the tag it was first read from, so a corrected tag keeps every manual system, parent and review decision recorded against it."
      actions={
        <button
          className="button button--small"
          type="button"
          data-testid="identity-log-toggle"
          onClick={(): void => {
            setOpen(!open);
          }}
        >
          {open ? 'Hide the identity log' : 'Show the identity log'}
        </button>
      }
    >
      <StatRow>
        <Stat
          label="New assets"
          value={count(summary.ledgerNewAssetCount)}
          hint="ids minted this compile"
        />
        <Stat
          label="Tags corrected"
          value={count(summary.ledgerTagChangedCount)}
          hint="same equipment, new spelling"
        />
        <Stat
          label="Matched on tag alone"
          value={count(summary.ledgerRematchedByTagCount)}
          hint="the weakest evidence there is"
        />
        <Stat label="Split" value={count(summary.ledgerSplitCount)} hint="one entry, several assets" />
        <Stat
          label="Disappeared"
          value={count(summary.ledgerDisappearedCount)}
          hint="known before, absent now"
        />
        <Stat
          label="Orphaned decisions"
          value={count(summary.orphanedDecisionCount)}
          hint={
            summary.orphanedDecisionCount === 0 ? 'none to re-address' : 'kept, in the review queue'
          }
        />
      </StatRow>

      {summary.orphanedDecisionCount > 0 ? (
        <Callout tone="warning">
          {count(summary.orphanedDecisionCount)}{' '}
          {summary.orphanedDecisionCount === 1 ? 'stored decision names' : 'stored decisions name'}{' '}
          equipment this compile does not have. Nothing was dropped — each one is in the review
          queue with the words that were written on it.
        </Callout>
      ) : null}
      {moved === 0 && summary.ledgerNewAssetCount > 0 ? (
        <Callout tone="info">
          Every asset in this compile is new to the project, so every id was minted here. The next
          compile is the one that has something to hold on to.
        </Callout>
      ) : null}

      {open ? <LedgerEventList /> : null}
    </Panel>
  );
}

/** The identity log itself, paged through `compile:ledger-events`. */
function LedgerEventList(): JSX.Element {
  const [rows, setRows] = useState<readonly WireLedgerEvent[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset: number): Promise<void> => {
    try {
      const page = await call(window.matchline.compile.ledgerEvents({ offset, limit: PAGE_SIZE }));
      setTotal(page.total);
      setRows((current) => (offset === 0 ? page.rows : [...current, ...page.rows]));
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  useEffect((): void => {
    void load(0);
  }, [load]);

  if (error !== null) {
    return <Callout tone="error">{error}</Callout>;
  }
  if (total === 0) {
    return (
      <Callout tone="success">
        Nothing moved. Every asset in this compile kept the id it already had.
      </Callout>
    );
  }

  return (
    <>
      <TableScroll>
        <table className="table table--compact" data-testid="ledger-events">
          <thead>
            <tr>
              <th>What happened</th>
              <th>Equipment</th>
              <th>Evidence</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: WireLedgerEvent): JSX.Element => (
              <tr key={`${row.kind}:${row.assetId}`}>
                <td>
                  <span className="badge">{row.kind}</span>
                </td>
                <td>
                  {row.tag === '' ? row.assetId : row.tag}
                  {row.previousTag === '' ? null : (
                    <span className="muted"> — was {row.previousTag}</span>
                  )}
                </td>
                <td className="muted">{row.tier === '' ? 'minted' : row.tier}</td>
                <td className="muted">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {rows.length < total ? (
        <button
          className="button button--small"
          type="button"
          onClick={(): void => {
            void load(rows.length);
          }}
        >
          Show {count(Math.min(PAGE_SIZE, total - rows.length))} more
        </button>
      ) : null}
    </>
  );
}

/** One drill-down list, paged. */
function IssueList({ kind }: { readonly kind: WireCompileIssueKind }): JSX.Element {
  const [rows, setRows] = useState<readonly WireCompileIssueRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number): Promise<void> => {
      try {
        const page = await call(
          window.matchline.compile.issues({ kind, offset, limit: PAGE_SIZE }),
        );
        setTotal(page.total);
        setRows((current) => (offset === 0 ? page.rows : [...current, ...page.rows]));
      } catch (caught: unknown) {
        setError(messageOf(caught));
      }
    },
    [kind],
  );

  useEffect((): void => {
    setRows([]);
    setTotal(0);
    setError(null);
    void load(0);
  }, [load]);

  return (
    <Panel
      title={`${count(total)} rows`}
      description="Read straight off the compile. Nothing here has been re-derived."
    >
      {error === null ? null : <Callout tone="error">{error}</Callout>}
      {total === 0 ? (
        <Callout tone="success">Nothing in this list.</Callout>
      ) : (
        <>
          <TableScroll>
            <table className="table table--compact" data-testid={`issues-${kind}`}>
              <thead>
                <tr>
                  <th>What</th>
                  <th>Detail</th>
                  <th>Kind</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row: WireCompileIssueRow): JSX.Element => (
                  <tr key={row.id}>
                    <td>{row.title}</td>
                    <td className="muted">{row.detail}</td>
                    <td>
                      <span className="badge">{row.badge}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {rows.length < total ? (
            <button
              className="button button--small"
              type="button"
              onClick={(): void => {
                void load(rows.length);
              }}
            >
              Show {count(Math.min(PAGE_SIZE, total - rows.length))} more
            </button>
          ) : null}
        </>
      )}
    </Panel>
  );
}
