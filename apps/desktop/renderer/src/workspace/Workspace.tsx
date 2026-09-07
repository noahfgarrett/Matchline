import { useCallback, useState, type JSX } from 'react';

import type { WireCompileStatus, WireCompileSummary } from '../../../shared/schemas';
import { call, count, messageOf } from '../api';
import { Callout } from '../components/Panel';

import type { ReviewRequest } from '../screens/Wizard';

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
 *
 * ## Three states carry a view, not one
 *
 * `done` is the obvious one. `restored` is the compile the project file was
 * holding when it was opened, rebuilt from the stored snapshot and register —
 * the tree and the review queue work, the electrical projection and the
 * checklist are not stored and say so. `failed` used to mean the workspace
 * emptied itself: main nulled the view on a failed recompile, so one bad run
 * took away the result the person still had. It no longer does, and the failure
 * is drawn ABOVE the previous compile rather than instead of it.
 */

type Tab = 'ssm' | 'flow' | 'review' | 'exports';

const TABS: ReadonlyArray<readonly [Tab, string, string]> = [
  ['ssm', 'SSM Hierarchy', 'Levels, structural parents and dependencies'],
  ['flow', 'Electrical Flow', 'Source to load, boundaries not applied'],
  ['review', 'Review', 'What the compiler refused to decide'],
  ['exports', 'Exports', 'MEL, EXTO, predecessors, revision diff'],
];

/**
 * The one line of completeness the header carries (audit blocker B3).
 *
 * Not a second summary of the compile — screen 8 has that. This answers the one
 * question the workspace itself keeps raising, which is whether the tree below
 * is the site or a flat list wearing its name.
 */
function completenessChip(summary: WireCompileSummary): string {
  const completeness = summary.completeness;
  const blocking = completeness.levels.filter((level) => level.blocksNesting);
  if (blocking.length > 0) {
    return `${blocking.map((level) => level.displayName).join(', ')} unstated — nothing nests across it`;
  }
  if (completeness.assetCount > 0 && completeness.assetsNested === 0) {
    return 'nothing nested — every asset is a root';
  }
  return `${count(completeness.assetsNested)} nested · ${count(completeness.assetsRooted)} roots`;
}

export function Workspace({
  projectName,
  status,
  onStatusChange,
  openReview,
  onReviewOpened,
}: {
  readonly projectName: string;
  readonly status: WireCompileStatus;
  readonly onStatusChange: (status: WireCompileStatus) => void;
  /**
   * A queue to open on, or `null` for the ordinary "SSM Hierarchy first".
   *
   * Screen 8's SSM Audit card sends one: a person who has just read "34 Exto
   * would refuse" wants those 34 rows, not the tab they happened to leave open.
   */
  readonly openReview?: ReviewRequest | null | undefined;
  /** Told once the request has been taken, so it is not applied twice. */
  readonly onReviewOpened?: (() => void) | undefined;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>(openReview == null ? 'ssm' : 'review');
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

  /**
   * Whether main still holds a view the tabs below can read.
   *
   * A failed compile carries the id of the compile whose view survived it, so
   * "failed with something still on screen" and "failed with nothing to show"
   * are different states and are drawn differently.
   */
  const hasView =
    status.state === 'done' ||
    status.state === 'restored' ||
    (status.state === 'failed' && status.staleViewFrom !== null);

  if (!hasView) {
    return (
      <div className="workspace" data-testid="workspace">
        <Callout tone={status.state === 'failed' ? 'error' : 'info'}>
          {status.state === 'failed'
            ? status.reason
            : 'Nothing has been compiled yet. Run Compile on screen 8 and this fills in.'}
        </Callout>
      </div>
    );
  }

  const summary = status.state === 'done' ? status.summary : null;
  const waiting = undecided ?? summary?.undecidedReviewItemCount ?? 0;
  const restored = status.state === 'restored';

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
        <span className="workspace__meta muted" data-testid="workspace-meta">
          {summary === null
            ? status.state === 'restored'
              ? `Compile ${String(status.compileId)} · ${count(status.assetCount)} assets · restored on open`
              : 'Showing the last compile that finished'
            : `${summary.compileId === null ? 'Unsaved compile' : `Compile ${String(summary.compileId)}`} · ${count(summary.assetCount)} assets · ${completenessChip(summary)}`}
        </span>
      </div>

      {status.state === 'failed' ? (
        <Callout tone="error" data-testid="workspace-stale">
          {status.reason} Everything below is still compile{' '}
          {String(status.staleViewFrom ?? '')} — the one that last finished. It is not stale in
          the sense of being wrong; it simply does not include whatever you changed.
        </Callout>
      ) : null}

      {restored ? (
        <Callout tone="info" data-testid="workspace-restored">
          Showing compile {String(status.state === 'restored' ? status.compileId : '')} from{' '}
          {status.state === 'restored' ? status.at.slice(0, 16).replace('T', ' ') : ''}; recompile
          to refresh. The hierarchy, the tag search and the register exports are read back from
          the project file. The electrical projection and the previews are built from the model
          and are not stored, so those tabs ask for a compile.
        </Callout>
      ) : null}

      {status.state === 'done' && status.unsavedDraft ? (
        <Callout tone="warning" data-testid="workspace-unsaved-draft">
          This compile ran from an unsaved draft, so nothing was written to the project. Publish
          on screen 9 to keep it.
        </Callout>
      ) : null}

      {error === null ? null : <Callout tone="error">{error}</Callout>}

      {tab === 'ssm' ? <SsmTreeView onRecompile={recompile} recompiling={recompiling} /> : null}
      {tab === 'flow' ? (
        <FlowView restored={restored} onRecompile={recompile} recompiling={recompiling} />
      ) : null}
      {tab === 'review' ? (
        <ReviewView
          onUndecidedChange={setUndecided}
          restored={restored}
          onRecompile={recompile}
          recompiling={recompiling}
          openFilter={openReview ?? null}
          onFilterApplied={onReviewOpened}
        />
      ) : null}
      {tab === 'exports' ? (
        <ExportsView
          projectName={projectName}
          restored={restored}
          onRecompile={recompile}
          recompiling={recompiling}
        />
      ) : null}
    </div>
  );
}
