import { useState, type JSX } from 'react';

/**
 * What a panel says when the project is showing a restored compile.
 *
 * A reopened project rebuilds what the project file stores — the hierarchy, the
 * tag search, the review queue and the register exports. The electrical
 * projection, the checklist and the previews are built from the model and are
 * not stored, so main refuses them by name (`restoredRefusal` in
 * compile-service.ts). That refusal used to arrive in the panel as a red error
 * callout, which says "something went wrong" about a project in a perfectly
 * ordinary state — and offered nothing to do about it.
 *
 * One sentence and the button that fixes it, in the same tone the SSM tree uses
 * for its own recompile bar.
 */
export function RecompileNotice({
  sentence,
  onRecompile,
  recompiling,
  'data-testid': testId,
}: {
  /** The whole sentence, so each panel says what it is actually missing. */
  readonly sentence: string;
  readonly onRecompile: () => Promise<void>;
  readonly recompiling: boolean;
  readonly 'data-testid'?: string | undefined;
}): JSX.Element {
  // Local, because a panel that owns no compile state still has to show the
  // button working while the compile it started runs.
  const [starting, setStarting] = useState(false);
  const busy = recompiling || starting;

  return (
    <div className="callout callout--info recompile-bar" role="status" data-testid={testId}>
      <span>{sentence}</span>
      <button
        className="button button--primary button--small"
        type="button"
        data-testid="recompile"
        disabled={busy}
        onClick={(): void => {
          setStarting(true);
          void onRecompile().finally((): void => {
            setStarting(false);
          });
        }}
      >
        {busy ? 'Recompiling…' : 'Recompile'}
      </button>
    </div>
  );
}
