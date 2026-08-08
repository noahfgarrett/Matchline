import { useCallback, useState, type JSX } from 'react';

import type { WireCompileStatus } from '../../../shared/schemas';
import { call, count, messageOf } from '../api';
import { Callout } from '../components/Panel';

import { ExportsView } from './ExportsView';
import { FlowView } from './FlowView';
import { ReviewView } from './ReviewView';
import { SsmTreeView } from './SsmTreeView';

/**
 * The project workspace: what the wizard opens onto once a compile exists.
 *
 * Four views over one compiled project — the SSM hierarchy, the electrical
 * projection, the review queue and the exports. Each is a different reading of
 * the same immutable snapshot (PRODUCT.md §8.3), which is why switching tabs
 * never re-runs anything.
 */

type Tab = 'ssm' | 'flow' | 'review' | 'exports';

const TABS: ReadonlyArray<readonly [Tab, string, string]> = [
  ['ssm', 'SSM Hierarchy', 'Levels, structural parents and dependencies'],
  ['flow', 'Electrical Flow', 'Source to load, boundaries not applied'],
  ['review', 'Review', 'What the compiler refused to decide'],
  ['exports', 'Exports', 'MEL, EXTO, predecessors, revision diff'],
];

export function Workspace({
  projectName,
  status,
  onStatusChange,
}: {
  readonly projectName: string;
  readonly status: WireCompileStatus;
  readonly onStatusChange: (status: WireCompileStatus) => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('ssm');
  const [recompiling, setRecompiling] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * `null` until the review queue has been read.
   *
   * The compile summary's count is the starting point, and the Review tab
   * replaces it as soon as it knows better — a decision made after the compile
   * changes the number, and the badge has to follow.
   */
  const [undecided, setUndecided] = useState<number | null>(null);

  const recompile = useCallback(async (): Promise<void> => {
    setRecompiling(true);
    setError(null);
    try {
      const data = await call(window.matchline.compile.run());
      onStatusChange(data.status);
      setUndecided(null);
      if (data.status.state === 'failed') {
        setError(data.status.reason);
      }
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setRecompiling(false);
    }
  }, [onStatusChange]);

  if (status.state !== 'done') {
    return (
      <div className="workspace" data-testid="workspace">
        <Callout tone="info">
          {status.state === 'failed'
            ? status.reason
            : 'Nothing has been compiled yet. Run Compile on screen 8 and this fills in.'}
        </Callout>
      </div>
    );
  }

  const summary = status.summary;
  const waiting = undecided ?? summary.undecidedReviewItemCount;

  return (
    <div className="workspace" data-testid="workspace">
      <div className="workspace__bar">
        <nav className="tabs" aria-label="Project views">
          {TABS.map(([key, label, hint]): JSX.Element => (
            <button
              key={key}
              type="button"
              className={`tab${tab === key ? ' tab--current' : ''}`}
              data-testid={`tab-${key}`}
              aria-current={tab === key ? 'page' : undefined}
              title={hint}
              onClick={(): void => {
                setTab(key);
              }}
            >
              {label}
              {key === 'review' && waiting > 0 ? (
                <span className="tab__count">{count(waiting)}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <span className="workspace__meta muted">
          Compile {summary.compileId} · {count(summary.assetCount)} assets ·{' '}
          {count(summary.flowNodeCount)} flow nodes
        </span>
      </div>

      {error === null ? null : <Callout tone="error">{error}</Callout>}

      {tab === 'ssm' ? <SsmTreeView onRecompile={recompile} recompiling={recompiling} /> : null}
      {tab === 'flow' ? <FlowView /> : null}
      {tab === 'review' ? <ReviewView onUndecidedChange={setUndecided} /> : null}
      {tab === 'exports' ? <ExportsView projectName={projectName} /> : null}
    </div>
  );
}
