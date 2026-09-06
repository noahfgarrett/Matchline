import { useCallback, useEffect, useState, type JSX } from 'react';

import type {
  WireDecisionValue,
  WireReviewPage,
  WireReviewRow,
  WireStaleDecision,
} from '../../../shared/schemas';
import { call, count, messageOf } from '../api';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';

import { RecompileNotice } from './RecompileNotice';

/**
 * The review queue: everything the compiler refused to decide on its own.
 *
 * Claims-not-writes means a disagreement is an output, not an exception — the
 * compile finished, every claim survived, and what is here is the set of
 * questions only a person can answer. Deciding one records the decision
 * (append-only: earlier decisions are kept) and dims the row; it does not
 * delete the item, because the item is still what the compile found.
 */

const PAGE_SIZE = 100;

/**
 * One plain-language name per `ReviewItem['kind']`.
 *
 * The filter chips are built from the kinds the compile actually produced, so a
 * kind the engine adds appears here on its own; what this table adds is the
 * words. A kind with no entry falls back to its own slug, which is honest but
 * reads like a bug report, so every kind the engine can emit has a line.
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  'system-conflict': 'Systems disagree',
  'duplicate-model-tag': 'Duplicate tags',
  'system-catalog-conflict': 'MEL describes a system twice',
  'fuzzy-identity': 'Near-miss tag match',
  'ambiguous-suffix': 'Tag could mean several assets',
  'ambiguous-parent': 'Two equally good parents',
  'structural-cycle': 'Equipment parenting each other',
  'missing-boundary': 'Boundary value not stated',
  // P0-4: somebody stated this parent and an enabled boundary refused it. The
  // relationship is kept as a dependency; what needs a person is whether the
  // boundary or the decision is the thing that is wrong.
  'manual-boundary-demotion': 'Manual parent crosses a boundary',
  'nesting-proposal': 'Learned suggestion',
  'dead-claim-rule': 'A rule produced nothing',
  'unresolvable-alias': 'Alias points at no asset',
  'absorbed-tagged-component': 'Tagged component absorbed',
  // P0-9: a decision recorded against an asset id this compile cannot find. The
  // decision is kept, note and all; what is lost is the thing it pointed at.
  'orphaned-decision': 'Stored decision no longer resolves',
  // P0-9, the other direction: an id was KEPT on the strength of a tag alone,
  // in circumstances where a reused tag is as likely as a re-tagged unit.
  'possible-rematch': 'Kept its id on the tag alone',
  // B-series: the three aggregate kinds. Each one is counted rather than
  // repeated per asset, so the label says the thing being counted — a level, a
  // group of assets, a rung — and not the asset, which there is no single one of.
  'missing-boundary-level': 'A level placed nothing',
  'unresolved-system': 'No system could be found',
  'boundary-demotion': 'A boundary took parents away',
};

/**
 * What a person is actually being asked, one sentence per kind.
 *
 * `KIND_LABELS` names the kind; this says what deciding it means. The two are
 * separate tables because the label has to survive in a filter chip and a table
 * cell, where a sentence would not fit, and the sentence is only ever shown once
 * — under the chips, for the kind currently being looked at.
 *
 * A kind with no entry renders nothing at all. That is deliberate: an invented
 * sentence about a kind nobody has written the words for is worse than silence,
 * because it reads with the same authority as the ones that are true.
 */
const KIND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'missing-boundary-level':
    'A level you switched on states no value across this much equipment, so what fixes it is usually one mapping rather than one decision per asset.',
  'unresolved-system':
    'No rung of the system chain could place these assets, and the reasons grouping them name the rung that ran out of evidence.',
  'boundary-demotion':
    'A boundary level refused parents a ladder rung had already chosen and holds them as dependencies instead — what needs deciding is whether that level really is a boundary here.',
  'possible-rematch':
    'This asset kept the id it had last compile on the strength of its tag alone — what needs deciding is whether it is the same equipment or a new unit on a reused tag.',
  'orphaned-decision':
    'A decision recorded earlier names equipment this compile cannot find — what needs deciding is whether it still says anything worth keeping.',
  'manual-boundary-demotion':
    'Somebody set this parent by hand and an enabled boundary refused it — what needs deciding is which of the two is wrong.',
  'missing-boundary':
    'This asset states no value for a boundary level, so the level could not decide whether it nests or not.',
};

const DECISIONS: ReadonlyArray<readonly [WireDecisionValue, string]> = [
  ['accepted', 'Accept'],
  ['rejected', 'Reject'],
  ['deferred', 'Defer'],
];

export function ReviewView({
  onUndecidedChange,
  restored,
  onRecompile,
  recompiling,
}: {
  /**
   * Reports how many items are still waiting.
   *
   * The tab badge cannot be read off the compile summary: that number was true
   * when the compile ran, and it stops being true the moment somebody decides
   * something. A badge that still says "1" after the queue is empty is a lie
   * about the only thing the badge is for.
   */
  readonly onUndecidedChange: (undecided: number) => void;
  /**
   * True when the compile on screen was read back from the project file rather
   * than produced by a run in this session.
   *
   * A restored compile carries its results but not its queue — review items are
   * rebuilt by the compiler, not stored — so an empty list means "nothing was
   * reloaded", which is the opposite of what the empty state otherwise says.
   * Congratulating somebody on a settled model they have not compiled is the
   * one wrong answer this panel can give without showing a single bad number.
   */
  readonly restored?: boolean | undefined;
  readonly onRecompile: () => Promise<void>;
  readonly recompiling: boolean;
}): JSX.Element {
  const [page, setPage] = useState<WireReviewPage | null>(null);
  /**
   * The rows paged in so far, kept apart from the page metadata.
   *
   * `total`, `kinds`, `undecidedCount` and `staleDecisions` describe the whole
   * queue and are true of whichever response arrived last; the rows accumulate.
   * Holding both in one state would mean either throwing away the earlier rows
   * on every page or letting the counts drift behind the newest answer.
   */
  const [rows, setRows] = useState<readonly WireReviewRow[]>([]);
  const [kind, setKind] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [staleOpen, setStaleOpen] = useState<boolean>(false);

  const load = useCallback(
    async (filter: string, offset: number): Promise<void> => {
      try {
        const data = await call(
          window.matchline.review.page({ kind: filter, offset, limit: PAGE_SIZE }),
        );
        setPage(data);
        setRows((current) => (offset === 0 ? data.rows : [...current, ...data.rows]));
        onUndecidedChange(data.undecidedCount);
      } catch (caught: unknown) {
        setError(messageOf(caught));
      }
    },
    [onUndecidedChange],
  );

  // Changing the filter is a different queue, not more of this one, so the
  // accumulated rows go before the first page of the new one is asked for.
  useEffect((): void => {
    setRows([]);
    void load(kind, 0);
  }, [kind, load]);

  const decide = async (reviewKey: string, decision: WireDecisionValue): Promise<void> => {
    setBusy(reviewKey);
    setError(null);
    try {
      await call(window.matchline.review.decide({ reviewKey, decision, note: '' }));
      // Re-read from the top and drop whatever had been paged in. A decision
      // changes `undecidedCount` and can change what any later offset points
      // at, so patching the row in place would leave the pages below it
      // describing an order the server no longer has. Re-paging is the honest
      // fix; the cost is that somebody deep in a long queue is sent back to
      // the first page.
      await load(kind, 0);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Forgets a decision whose key names nothing.
   *
   * The only place in the product where a decision is deleted rather than
   * superseded, and it is offered only here because there is nothing left for
   * it to be superseded against.
   */
  const dismissStale = async (reviewKey: string): Promise<void> => {
    setBusy(reviewKey);
    setError(null);
    try {
      await call(window.matchline.decision.delete({ reviewKey }));
      await load(kind, 0);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  };

  if (page === null) {
    return (
      <div className="workspace-pane" data-testid="review-view">
        {error === null ? (
          <Callout tone="info">Reading the review queue…</Callout>
        ) : (
          <Callout tone="error">{error}</Callout>
        )}
      </div>
    );
  }

  return (
    <div className="workspace-pane" data-testid="review-view">
      {error === null ? null : <Callout tone="error">{error}</Callout>}

      <Panel
        title="Review queue"
        description="One decision per item. Deciding records what you said and keeps the item — a decision is history, not a delete."
      >
        <StatRow>
          <Stat label="Items in this compile" value={count(page.total)} />
          <Stat
            label="Still undecided"
            value={count(page.undecidedCount)}
            hint={page.undecidedCount === 0 ? 'nothing waiting' : 'waiting on a person'}
          />
          <Stat label="Kinds" value={count(page.kinds.length)} />
        </StatRow>

        <div className="chip-row" data-testid="review-filters">
          <button
            type="button"
            className={`chip${kind === '' ? ' chip--active' : ''}`}
            onClick={(): void => {
              setKind('');
            }}
          >
            <span className="chip__label">Everything</span>
            <span className="chip__hint">{count(page.total)} shown</span>
          </button>
          {page.kinds.map((entry): JSX.Element => (
            <button
              key={entry.kind}
              type="button"
              className={`chip${kind === entry.kind ? ' chip--active' : ''}`}
              data-testid={`review-filter-${entry.kind}`}
              onClick={(): void => {
                setKind(entry.kind);
              }}
            >
              <span className="chip__label">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
              <span className="chip__hint">{count(entry.count)}</span>
            </button>
          ))}
        </div>

        {kind === '' || KIND_DESCRIPTIONS[kind] === undefined ? null : (
          <p className="muted" data-testid="review-kind-description">
            {KIND_DESCRIPTIONS[kind]}
          </p>
        )}

        {rows.length === 0 ? (
          restored === true ? (
            <RecompileNotice
              sentence="The review queue is rebuilt by a compile rather than stored with it, so this project reopened without one. Everything still waiting comes back."
              onRecompile={onRecompile}
              recompiling={recompiling}
              data-testid="review-restored"
            />
          ) : (
            <Callout tone="success">
              Nothing here. The compiler settled everything it had evidence for.
            </Callout>
          )
        ) : (
          <TableScroll>
            <table className="table table--compact" data-testid="review-rows">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>What needs deciding</th>
                  <th>Equipment</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row: WireReviewRow): JSX.Element => (
                  <tr
                    key={row.reviewKey}
                    className={row.decision === null ? '' : 'review-row--decided'}
                    data-testid={`review-${row.reviewKey}`}
                  >
                    <td>{KIND_LABELS[row.kind] ?? row.kind}</td>
                    <td>{row.summary}</td>
                    <td className="muted">{row.detail}</td>
                    <td>
                      {row.decision === null ? (
                        <div className="toolbar__group">
                          {DECISIONS.map(([value, label]): JSX.Element => (
                            <button
                              key={value}
                              type="button"
                              className="button button--small"
                              data-testid={`decide-${value}`}
                              disabled={busy === row.reviewKey}
                              onClick={(): void => {
                                void decide(row.reviewKey, value);
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="badge badge--ready">
                          {row.decision}
                          {row.decidedAt === '' ? '' : ` · ${row.decidedAt.slice(0, 10)}`}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        {rows.length < page.total ? (
          <button
            className="button button--small"
            type="button"
            data-testid="review-show-more"
            onClick={(): void => {
              void load(kind, rows.length);
            }}
          >
            Show {count(Math.min(PAGE_SIZE, page.total - rows.length))} more
          </button>
        ) : null}
      </Panel>

      {page.staleDecisions.length === 0 ? null : (
        <StaleDecisionPanel
          decisions={page.staleDecisions}
          open={staleOpen}
          busy={busy}
          onToggle={(): void => {
            setStaleOpen(!staleOpen);
          }}
          onDismiss={dismissStale}
        />
      )}
    </div>
  );
}

/**
 * Decisions with nothing left to apply to.
 *
 * A review key carries the asset and the evidence together, so when the
 * equipment leaves the model or the evidence behind it changes, the key stops
 * naming anything and the decision applies to nothing. Deleting it silently
 * would be the easy answer and the wrong one — somebody sat and answered that
 * question, and the record of it is the only thing saying so. It is kept here,
 * out of the way but findable, until a person decides it is finished with.
 *
 * Collapsed by default for the same reason the identity log is: on a healthy
 * project this list is a footnote, and a footnote does not get to push the
 * queue off the screen.
 */
function StaleDecisionPanel({
  decisions,
  open,
  busy,
  onToggle,
  onDismiss,
}: {
  readonly decisions: readonly WireStaleDecision[];
  readonly open: boolean;
  readonly busy: string | null;
  readonly onToggle: () => void;
  readonly onDismiss: (reviewKey: string) => Promise<void>;
}): JSX.Element {
  return (
    <Panel
      title="Decisions that no longer match an item"
      description={`${count(decisions.length)} recorded ${
        decisions.length === 1 ? 'decision has' : 'decisions have'
      } nothing in this compile to apply to.`}
      actions={
        <button
          className="button button--small"
          type="button"
          data-testid="stale-decisions-toggle"
          onClick={onToggle}
        >
          {open ? 'Hide them' : 'Show them'}
        </button>
      }
    >
      {open ? (
        <>
          <p className="muted">
            A review key carries the asset and the evidence together, so when the equipment leaves
            the model or the evidence behind it changes, the key stops naming anything and the
            decision applies to nothing. These are kept rather than dropped, because somebody
            answered them. Dismiss one when its answer has stopped meaning anything.
          </p>
          <TableScroll>
            <table className="table table--compact" data-testid="stale-decisions">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Decision</th>
                  <th>When</th>
                  <th>Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {decisions.map((entry: WireStaleDecision): JSX.Element => (
                  <tr key={entry.reviewKey} data-testid={`stale-${entry.reviewKey}`}>
                    <td>{KIND_LABELS[entry.kind] ?? entry.kind}</td>
                    <td>
                      <span className="badge">{entry.decision}</span>
                    </td>
                    <td className="muted">
                      {entry.decidedAt === '' ? '—' : entry.decidedAt.slice(0, 10)}
                    </td>
                    <td className="muted">{entry.note === '' ? '—' : entry.note}</td>
                    <td>
                      <button
                        className="button button--quiet button--small"
                        type="button"
                        data-testid="dismiss-stale"
                        disabled={busy === entry.reviewKey}
                        onClick={(): void => {
                          void onDismiss(entry.reviewKey);
                        }}
                      >
                        Dismiss
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      ) : null}
    </Panel>
  );
}
