import { useCallback, useState, type DragEvent, type JSX } from 'react';

import type {
  WireAddSourceResult,
  WireSheetSummary,
  WireSourceStatus,
  WireSourceSummary,
} from '../../../shared/schemas';
import { call, fileSize, messageOf } from '../api';
import { Callout, Panel, TableScroll } from '../components/Panel';

import type { WizardContext } from './Wizard';

/**
 * Screen 1 — Project sources (PRODUCT.md §7).
 *
 * Drop files in; Matchline says what each one is and what state it is in. It
 * identifies by opening the file, never by its name, so the status line is a
 * report rather than a guess — and a `.nwd` that needs a Windows extraction run
 * says exactly that instead of silently doing nothing.
 */

const SOURCE_FILTERS = [
  {
    name: 'Matchline sources',
    extensions: ['matchline-cache', 'sqlite', 'db', 'nwd', 'nwf', 'nwc', 'xlsx', 'xlsm', 'xer'],
  },
];

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
  'requires-windows-extraction': 'Needs Windows extraction',
  'needs-attention': 'Needs attention',
  'file-missing': 'File not found',
  'file-changed': 'File has changed',
};

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
        await call(
          window.matchline.source.remove({ role: source.role, fileName: source.fileName }),
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

  return (
    <div className="screen" data-testid="screen-1">
      <header className="screen__header">
        <h1 className="screen__title">1. Project sources</h1>
        <p className="screen__lede">
          Add the model extraction and the spreadsheets for this site. Matchline opens each
          file to work out what it is — an EasyPower export is recognised by its column
          headers, not by its name — and tells you what it found.
        </p>
      </header>

      <Panel
        title="Add files"
        description="Extraction caches (.matchline-cache), Navisworks files (.nwd), workbooks (.xlsx, .xlsm) and P6 exports (.xer)."
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
        </div>

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
        description={`${String(context.sources.length)} registered.`}
      >
        {context.sources.length === 0 ? (
          <Callout tone="info">
            Nothing added yet. Start with the model extraction cache — it is the equipment
            universe every other source is matched against.
          </Callout>
        ) : (
          <ul className="source-list" data-testid="source-list">
            {context.sources.map((source: WireSourceSummary): JSX.Element => (
              <li className="source" key={`${source.role} ${source.fileName}`}>
                <div className="source__head">
                  <span className="source__role">{ROLE_LABELS[source.role] ?? source.role}</span>
                  <span className="source__name">{source.fileName}</span>
                  <span className={`badge badge--${source.status}`}>
                    {STATUS_LABELS[source.status]}
                  </span>
                  <span className="source__size">{fileSize(source.byteSize)}</span>
                  <button
                    className="button button--quiet button--small"
                    type="button"
                    disabled={busy}
                    onClick={(): void => {
                      void removeSource(source);
                    }}
                  >
                    Remove
                  </button>
                </div>
                <p className="source__note">{source.note}</p>
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
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
