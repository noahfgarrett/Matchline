import { useCallback, useEffect, useRef, useState, type DragEvent, type JSX } from 'react';

import type {
  WireAddSourceResult,
  WireExtractionJob,
  WireExtractionWarning,
  WireSheetSummary,
  WireSourceStatus,
  WireSourceSummary,
} from '../../../shared/schemas';
import { call, fileSize, messageOf } from '../api';
import { Callout, Panel, TableScroll } from '../components/Panel';

import type { WizardContext } from './Wizard';

/**
 * Screen 1 — Project sources (PRODUCT.md §7, RELEASE-1.0-PLAN P0-2).
 *
 * Drop files in; Matchline says what each one is and what state it is in. It
 * identifies by opening the file, never by its name, so the status line is a
 * report rather than a guess.
 *
 * A Navisworks model is dropped in raw. Extraction starts on its own, one model
 * at a time, and the row is where it is watched: a stage, a progress bar when
 * the stage knows its total, the sentence the job is currently living, and a
 * Cancel button while there is something to cancel. No cache file is ever named
 * to the user, and none has to be produced by hand.
 */

const SOURCE_FILTERS = [
  {
    name: 'Matchline sources',
    extensions: ['nwd', 'nwf', 'nwc', 'xlsx', 'xlsm', 'xer', 'matchline-cache', 'sqlite', 'db'],
  },
];

/** How often the extraction status is re-read while anything is running. */
const EXTRACTION_POLL_MS = 900;

/** Every job a project could plausibly have in flight at once, and then some. */
const EXTRACTION_PAGE_LIMIT = 200;

const ROLE_LABELS: Readonly<Record<string, string>> = {
  model: 'Model',
  easypower: 'EasyPower',
  'cable-schedule': 'Cable schedule',
  pmd: 'PMD',
  mel: 'Master equipment list',
  p6: 'P6 schedule',
  'prior-ssm': 'Previous SSM',
};

const STATUS_LABELS: Readonly<Record<WireSourceStatus, string>> = {
  ready: 'Ready',
  'needs-attention': 'Needs attention',
  'file-missing': 'File not found',
  'file-changed': 'File has changed',
  queued: 'Waiting to extract',
  hashing: 'Checking the file',
  opening: 'Opening in Navisworks',
  extracting: 'Reading the model',
  finalizing: 'Finishing up',
  'cache-hit': 'Ready — reused',
  cancelled: 'Cancelled',
  failed: 'Extraction failed',
};

/**
 * The error code a job settles with on a machine that cannot extract at all.
 *
 * Repeated rather than imported: `SERVICE_ERROR_CODES` lives in main's
 * services, which the renderer never reaches into. The value is pinned in
 * `electron/services/extraction-protocol.ts`.
 */
const PLATFORM_UNAVAILABLE_CODE = 'extraction-unavailable-on-this-platform';

/** The statuses that mean something is still happening to this source. */
const RUNNING_STATUSES: ReadonlySet<WireSourceStatus> = new Set<WireSourceStatus>([
  'queued',
  'hashing',
  'opening',
  'extracting',
  'finalizing',
]);

/**
 * What the badge says for one source.
 *
 * Normally the status; on a machine that cannot extract, a plain statement of
 * that instead. "Extraction failed" is a wrong word there — nothing was tried
 * and nothing went wrong — and a row that reads like a fault sends the user
 * looking for a fix that does not exist. Keyed on the job's error code rather
 * than on a status of its own, because the *status* really is `failed`: the
 * source is not usable and the compile must not read it.
 */
function statusLabel(
  status: WireSourceStatus,
  job: WireExtractionJob | undefined,
  unavailableReason: string,
): string {
  if (job?.errorCode === PLATFORM_UNAVAILABLE_CODE) {
    return unavailableReason.includes('darwin')
      ? 'Not available on this Mac'
      : 'Not available on this computer';
  }
  return STATUS_LABELS[status];
}

/**
 * "3 registered, 2 model sources" — the second half only once there are two,
 * because a project with one model has nothing to disambiguate.
 */
function sourcesDescription(sources: readonly WireSourceSummary[]): string {
  const models = sources.filter(
    (source: WireSourceSummary): boolean => source.role === 'model',
  ).length;
  const registered = `${String(sources.length)} registered.`;
  return models < 2 ? registered : `${registered} ${String(models)} model sources.`;
}

export function Screen1Sources({
  context,
  onSourcesChanged,
}: {
  readonly context: WizardContext;
  readonly onSourcesChanged: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState<boolean>(false);
  const [dragging, setDragging] = useState<boolean>(false);
  const [rejected, setRejected] = useState<readonly WireAddSourceResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<readonly WireExtractionJob[]>([]);
  /**
   * Whether this machine can extract at all, as main last reported it.
   *
   * Optimistic until the first poll answers: the callout is a warning, and
   * flashing one up for a moment on every machine that CAN extract would be
   * worse than showing it a second late on the ones that cannot.
   */
  const [extraction, setExtraction] = useState<{
    readonly available: boolean;
    readonly reason: string;
  }>({ available: true, reason: '' });

  /**
   * Whether the last poll found work in flight.
   *
   * It is what decides that the source list needs re-reading: the rows only
   * change when a job finishes, and refreshing on every tick would rescan the
   * whole model universe once a second for as long as an extraction runs.
   */
  const wasExtracting = useRef<boolean>(false);

  const sourcesRunning = context.sources.some((source: WireSourceSummary): boolean =>
    RUNNING_STATUSES.has(source.status),
  );

  /**
   * Follows the extraction queue for as long as it has something to say.
   *
   * Polled, not pushed: main owns the queue and every other long answer in this
   * app is asked for the same way, so a window reopened onto a project that is
   * mid-extraction sees exactly what a window that never closed sees.
   */
  useEffect((): (() => void) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const page = await call(
          window.matchline.extraction.status({ offset: 0, limit: EXTRACTION_PAGE_LIMIT }),
        );
        if (cancelled) {
          return;
        }
        setJobs(page.rows);
        setExtraction({
          available: page.extractionAvailable,
          reason: page.extractionUnavailableReason,
        });
        if (page.active) {
          wasExtracting.current = true;
          timer = setTimeout((): void => {
            void tick();
          }, EXTRACTION_POLL_MS);
          return;
        }
        if (wasExtracting.current) {
          wasExtracting.current = false;
          // Something finished: the rows, the universe and every screen built
          // on it are now different from what is on screen.
          await onSourcesChanged();
        }
      } catch (caught: unknown) {
        if (!cancelled) {
          setError(messageOf(caught));
        }
      }
    };

    void tick();

    return (): void => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [sourcesRunning, onSourcesChanged]);

  const cancelExtraction = useCallback(async (sourceId: string): Promise<void> => {
    try {
      await call(window.matchline.extraction.cancel({ sourceId }));
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  /**
   * Registers paths, on the channel that matches where they came from.
   *
   * The two are not interchangeable. `source:add` only accepts a path a dialog
   * handed out, because main recorded that dialog's answer and checks against
   * the record (electron/security/path-grants.ts). A dropped path was never in
   * that record — the renderer read it off the drag payload — so it goes to
   * `source:add-dropped`, which screens it in main instead. Sending a dropped
   * path to `source:add` would be refused, every time.
   */
  const addPaths = useCallback(
    async (paths: readonly string[], from: 'dialog' | 'drop'): Promise<void> => {
      if (paths.length === 0) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const request = { paths: [...paths] };
        const result = await call(
          from === 'dialog'
            ? window.matchline.source.add(request)
            : window.matchline.source.addDropped(request),
        );
        setRejected(
          result.results.filter(
            (entry: WireAddSourceResult): boolean => entry.outcome === 'rejected',
          ),
        );
        await onSourcesChanged();
      } catch (caught: unknown) {
        setError(messageOf(caught));
      } finally {
        setBusy(false);
      }
    },
    [onSourcesChanged],
  );

  const browse = useCallback(async (): Promise<void> => {
    try {
      const chosen = await call(
        window.matchline.dialog.openFiles({ filters: SOURCE_FILTERS }),
      );
      if (chosen.cancelled) {
        return;
      }
      await addPaths(chosen.paths, 'dialog');
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, [addPaths]);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setDragging(false);
      // A `File` has carried no `path` since Electron 43; the preload's
      // `webUtils.getPathForFile` is what is left, and it answers '' for
      // anything with no file behind it — a dragged selection of text, say.
      // Those are dropped here rather than sent for main to complain about.
      const paths = [...event.dataTransfer.files].flatMap((file: File): string[] => {
        const candidate = window.matchline.files.pathOf(file);
        return candidate === '' ? [] : [candidate];
      });
      void addPaths(paths, 'drop');
    },
    [addPaths],
  );

  const removeSource = useCallback(
    async (source: WireSourceSummary): Promise<void> => {
      setBusy(true);
      try {
        // By id: two rows may show the same file name and only one of them is
        // the one whose Remove button was pressed.
        await call(window.matchline.source.remove({ sourceId: source.sourceId }));
        await onSourcesChanged();
      } catch (caught: unknown) {
        setError(messageOf(caught));
      } finally {
        setBusy(false);
      }
    },
    [onSourcesChanged],
  );

  return (
    <div className="screen" data-testid="screen-1">
      <header className="screen__header">
        <h1 className="screen__title">1. Project sources</h1>
        <p className="screen__lede">
          Add the Navisworks models and the spreadsheets for this site. Matchline opens each
          file to work out what it is — an EasyPower export is recognised by its column
          headers, not by its name — and tells you what it found. A model is read by
          extracting it, which starts here on its own and runs one model at a time.
        </p>
      </header>

      <Panel
        title="Add files"
        description="Navisworks models (.nwd, .nwf, .nwc), workbooks (.xlsx, .xlsm) and P6 exports (.xer)."
      >
        <div
          className={`dropzone${dragging ? ' dropzone--active' : ''}`}
          data-testid="dropzone"
          onDragOver={(event): void => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(): void => {
            setDragging(false);
          }}
          onDrop={onDrop}
        >
          <p className="dropzone__text">Drop files here</p>
          <button
            className="button button--primary"
            type="button"
            data-testid="browse-sources"
            disabled={busy}
            onClick={(): void => {
              void browse();
            }}
          >
            {busy ? 'Reading…' : 'Choose files…'}
          </button>
          <p className="dropzone__aside muted">
            An extraction Matchline produced earlier — a .matchline-cache file — can be added
            here too. You never have to make one: dropping the model is the normal way.
          </p>
        </div>

        {extraction.available ? null : (
          <Callout tone="info">
            <strong>Models cannot be extracted on this computer.</strong> Navisworks runs on
            Windows only, so a model added here is registered but not read. Extract it on a
            Windows machine with Navisworks and drop the .matchline-cache that produces in
            here — everything after extraction works the same on either. {extraction.reason}
          </Callout>
        )}

        {error === null ? null : <Callout tone="error">{error}</Callout>}

        {rejected.map((entry: WireAddSourceResult): JSX.Element | null =>
          entry.outcome === 'rejected' ? (
            <Callout key={`${entry.fileName}-${entry.reason}`} tone="warning">
              <strong>{entry.fileName}</strong> — {entry.reason}
            </Callout>
          ) : null,
        )}
      </Panel>

      <Panel
        title="Sources in this project"
        description={sourcesDescription(context.sources)}
      >
        {context.sources.length === 0 ? (
          <Callout tone="info">
            Nothing added yet. Start with the Navisworks model — it is the equipment universe
            every other source is matched against.
          </Callout>
        ) : (
          <ul className="source-list" data-testid="source-list">
            {context.sources.map((source: WireSourceSummary): JSX.Element => {
              const job = jobs.find(
                (candidate: WireExtractionJob): boolean =>
                  candidate.sourceId === source.sourceId,
              );
              return (
                // Keyed and rendered by source id: a project may hold two files
                // called `Level 1.nwc` and both are real (P0-1, hard gate 4).
                <li className="source" key={source.sourceId} data-source-id={source.sourceId}>
                  <div className="source__head">
                    <span className="source__role">{ROLE_LABELS[source.role] ?? source.role}</span>
                    <span className="source__name">{source.logicalName}</span>
                    <span className={`badge badge--${source.status}`} data-testid="source-status">
                      {statusLabel(source.status, job, extraction.reason)}
                    </span>
                    <span className="source__size">{fileSize(source.rawByteSize)}</span>
                    {job === undefined || !job.cancellable ? null : (
                      <button
                        className="button button--quiet button--small"
                        type="button"
                        data-testid="cancel-extraction"
                        aria-label={`Stop extracting ${source.logicalName}`}
                        onClick={(): void => {
                          void cancelExtraction(source.sourceId);
                        }}
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      className="button button--quiet button--small"
                      type="button"
                      disabled={busy}
                      aria-label={`Remove ${source.logicalName}`}
                      onClick={(): void => {
                        void removeSource(source);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  {source.logicalName === source.rawFileName ? null : (
                    <p className="source__note muted">Extracted from {source.rawFileName}</p>
                  )}
                  <p className="source__note">{source.note}</p>
                  {job === undefined || !job.cancellable || job.status === 'queued' ? null : (
                    <ExtractionProgress job={job} />
                  )}
                  {job === undefined || job.warnings.length === 0 ? null : (
                    <ul className="source__warnings">
                      {job.warnings.map((warning: WireExtractionWarning): JSX.Element => (
                        <li key={`${warning.code}-${warning.message}`} className="source__note muted">
                          {warning.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {source.sheets.length === 0 ? null : (
                    <TableScroll>
                      <table className="table table--compact">
                        <thead>
                          <tr>
                            <th>Sheet</th>
                            <th>Recognised as</th>
                            <th>How</th>
                            <th className="table__number">Header row</th>
                            <th className="table__number">Columns found</th>
                          </tr>
                        </thead>
                        <tbody>
                          {source.sheets.map((sheet: WireSheetSummary): JSX.Element => (
                            <tr key={sheet.sheet}>
                              <td>{sheet.sheet}</td>
                              <td>{ROLE_LABELS[sheet.kind] ?? sheet.kind}</td>
                              <td>{sheet.confidence}</td>
                              <td className="table__number">
                                {sheet.headerRow === 0 ? 'not found' : sheet.headerRow}
                              </td>
                              <td className="table__number">{sheet.mappedColumnCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableScroll>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/**
 * The bar and the line under it for a running extraction.
 *
 * The bar is only drawn when the stage actually knows its total. A model walk
 * cannot know how many objects it will find until it has found them, and a bar
 * that invented a denominator would be at its most confident exactly when it
 * had the least idea — so those stages get a moving stripe and the record count
 * instead, which is a real number.
 */
function ExtractionProgress({ job }: { readonly job: WireExtractionJob }): JSX.Element {
  const percent = job.progress === null ? null : Math.round(job.progress * 100);
  return (
    <div className="extraction" data-testid="extraction-progress" data-status={job.status}>
      <div
        className={`extraction__track${percent === null ? ' extraction__track--indeterminate' : ''}`}
        role="progressbar"
        aria-label={`Extracting ${job.fileName}`}
        {...(percent === null
          ? {}
          : { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
      >
        <div
          className="extraction__bar"
          style={percent === null ? undefined : { width: `${String(percent)}%` }}
        />
      </div>
      <p className="extraction__detail muted">
        {percent === null ? job.detail : `${String(percent)}% — ${job.detail}`}
      </p>
    </div>
  );
}
