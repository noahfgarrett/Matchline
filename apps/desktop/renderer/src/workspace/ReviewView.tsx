import { useCallback, useEffect, useState, type JSX } from 'react';

import type { WireDecisionValue, WireReviewPage, WireReviewRow } from '../../../shared/schemas';
import { call, count, messageOf } from '../api';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';

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

const KIND_LABELS: Readonly<Record<string, string>> = {
  'system-conflict': 'Systems disagree',
  'duplicate-model-tag': 'Duplicate tags',
  'system-catalog-conflict': 'MEL describes a system twice',
  'fuzzy-identity': 'Near-miss tag match',
  'ambiguous-suffix': 'Tag could mean several assets',
  'ambiguous-parent': 'Two equally good parents',
  'structural-cycle': 'Equipment parenting each other',
  'missing-boundary': 'Boundary value not stated',
  'nesting-proposal': 'Learned suggestion',
};

const DECISIONS: ReadonlyArray<readonly [WireDecisionValue, string]> = [
  ['accepted', 'Accept'],
  ['rejected', 'Reject'],
  ['deferred', 'Defer'],
];

export function ReviewView({
  onUndecidedChange,
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
}): JSX.Element {
  const [page, setPage] = useState<WireReviewPage | null>(null);
  const [kind, setKind] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (filter: string): Promise<void> => {
      try {
        const data = await call(
          window.matchline.review.page({ kind: filter, offset: 0, limit: PAGE_SIZE }),
        );
        setPage(data);
        onUndecidedChange(data.undecidedCount);
      } catch (caught: unknown) {
        setError(messageOf(caught));
      }
    },
    [onUndecidedChange],
  );

  useEffect((): void => {
    void load(kind);
  }, [kind, load]);

  const decide = async (reviewKey: string, decision: WireDecisionValue): Promise<void> => {
    setBusy(reviewKey);
    setError(null);
    try {
      await call(window.matchline.review.decide({ reviewKey, decision, note: '' }));
      await load(kind);
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

        {page.rows.length === 0 ? (
          <Callout tone="success">
            Nothing here. The compiler settled everything it had evidence for.
          </Callout>
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
                {page.rows.map((row: WireReviewRow): JSX.Element => (
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

        {page.rows.length < page.total ? (
          <Callout tone="info">
            Showing the first {count(page.rows.length)} of {count(page.total)}. Filter by kind to
            narrow the list.
          </Callout>
        ) : null}
      </Panel>
    </div>
  );
}
