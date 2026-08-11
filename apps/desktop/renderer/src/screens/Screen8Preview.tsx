import { useCallback, useEffect, useState, type JSX } from 'react';

import type {
  WireCompileIssueKind,
  WireCompileIssueRow,
  WireCompileStatus,
  WireCompileSummary,
  WireLedgerEvent,
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
 * Compile state is honest. `compileProject` runs synchronously in the main
 * process, so "Compiling…" is on screen for exactly as long as main is busy,
 * and a failure shows the message the service wrote rather than a generic one.
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
  const [openKind, setOpenKind] = useState<WireCompileIssueKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    let cancelled = false;
    void call(window.matchline.compile.status()).then(
      (data): void => {
        if (!cancelled) {
          setStatus(data.status);
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

  const compile = useCallback(async (): Promise<void> => {
    setRunning(true);
    setError(null);
    setOpenKind(null);
    try {
      const data = await call(window.matchline.compile.run());
      setStatus(data.status);
      if (data.status.state === 'done') {
        onCompiled();
      }
    } catch (caught: unknown) {
      setError(messageOf(caught));
      setStatus({ state: 'failed', reason: messageOf(caught) });
    } finally {
      setRunning(false);
    }
  }, [onCompiled]);

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
        }
      >
        {running ? <Callout tone="info">Compiling. This runs in the main process.</Callout> : null}
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
        {summary === null ? null : (
          <p className="muted" data-testid="compile-meta">
            Compile {summary.compileId} from profile revision {summary.profileRevision}, finished
            in {count(summary.durationMs)} ms. {count(summary.generatedMelRowCount)} rows in the
            generated MEL.
          </p>
        )}
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
