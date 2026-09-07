import { useCallback, useEffect, useState, type JSX } from 'react';

import type {
  WireCompileHistoryEntry,
  WireExportResult,
  WireExtoTemplate,
  WireTemplateAnalysis,
  WireTemplateBinding,
  WireTemplateColumn,
} from '../../../shared/schemas';
import { call, count, fileSize, messageOf } from '../api';
import { Callout, Panel, TableScroll } from '../components/Panel';

import { RecompileNotice } from './RecompileNotice';

/**
 * The exports panel.
 *
 * Every button is: pick a destination, let main run the engine writer, write
 * the bytes, then say where the file went and what is in it. The note under a
 * success is not decoration — it is where an export admits what it could not
 * fill in, so a blank column is never mistaken for a value of nothing.
 *
 * On a restored compile four of these are refused by main — they read the
 * compiled project, which the project file does not store. Saying so at the top
 * is the honest place for it: the alternative is letting somebody name a file,
 * choose a folder and press Save before finding out.
 */

const XLSX_FILTERS = [{ name: 'Excel workbook', extensions: ['xlsx'] }];

type Toast =
  | { readonly tone: 'success'; readonly text: string }
  | { readonly tone: 'error'; readonly text: string };

export function ExportsView({
  projectName,
  restored,
  onRecompile,
  recompiling,
}: {
  readonly projectName: string;
  /** True when the workspace is showing the compile read back on open. */
  readonly restored: boolean;
  readonly onRecompile: () => Promise<void>;
  readonly recompiling: boolean;
}): JSX.Element {
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<WireTemplateAnalysis | null>(null);
  const [bindings, setBindings] = useState<readonly WireTemplateBinding[]>([]);
  const [history, setHistory] = useState<readonly WireCompileHistoryEntry[]>([]);
  const [baseline, setBaseline] = useState<number | null>(null);
  const [extoTemplate, setExtoTemplate] = useState<WireExtoTemplate | null>(null);

  const refreshConfig = useCallback(async (): Promise<void> => {
    try {
      const data = await call(window.matchline.config.get());
      setExtoTemplate(data.config.extoTemplate);
    } catch (caught: unknown) {
      setToast({ tone: 'error', text: messageOf(caught) });
    }
  }, []);

  useEffect((): void => {
    void refreshConfig();
  }, [refreshConfig]);

  const refreshHistory = useCallback(async (): Promise<void> => {
    try {
      const data = await call(window.matchline.compile.history());
      setHistory(data.compiles);
      // The newest diffable compile that is not the current one is the obvious
      // baseline; a diff against the compile you are looking at is all zeroes.
      const candidate = data.compiles.filter((entry) => entry.diffable)[1];
      setBaseline(candidate?.compileId ?? null);
    } catch (caught: unknown) {
      setToast({ tone: 'error', text: messageOf(caught) });
    }
  }, []);

  useEffect((): void => {
    void refreshHistory();
  }, [refreshHistory]);

  /** Pick a destination, run `write`, report where it landed. */
  const runExport = async (
    key: string,
    suffix: string,
    write: (path: string) => Promise<{ readonly result: WireExportResult }>,
  ): Promise<void> => {
    setBusy(key);
    setToast(null);
    try {
      const picked = await call(
        window.matchline.dialog.saveFile({
          defaultName: `${projectName}-${suffix}.xlsx`,
          filters: XLSX_FILTERS,
        }),
      );
      if (picked.cancelled) {
        return;
      }
      const data = await write(picked.path);
      setToast(
        data.result.written
          ? {
              tone: 'success',
              text: `Written to ${data.result.path} (${fileSize(data.result.byteSize)}). ${data.result.note}`,
            }
          : { tone: 'error', text: data.result.reason },
      );
      await refreshHistory();
    } catch (caught: unknown) {
      setToast({ tone: 'error', text: messageOf(caught) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Capture the site's own registry layout.
   *
   * The workbook is read for its header row and nothing else — no row of it is
   * copied into the project — and what comes back is stored, so every later EXTO
   * export is written on it without the file being needed again.
   */
  const captureExtoTemplate = async (): Promise<void> => {
    setBusy('exto-template');
    setToast(null);
    try {
      const picked = await call(window.matchline.dialog.openFile({ filters: XLSX_FILTERS }));
      if (picked.cancelled) {
        return;
      }
      const data = await call(
        window.matchline.export.extoTemplateCapture({ path: picked.path }),
      );
      setExtoTemplate(data.config.extoTemplate);
      const template = data.config.extoTemplate;
      setToast({
        tone: 'success',
        text:
          template === null
            ? 'Nothing was captured from that workbook.'
            : `Captured ${count(template.headers.length)} columns from ${template.capturedFrom.label}. ` +
              `${count(template.matched.length)} of them are columns Matchline can fill; the rest stay blank.`,
      });
    } catch (caught: unknown) {
      setToast({ tone: 'error', text: messageOf(caught) });
    } finally {
      setBusy(null);
    }
  };

  const clearExtoTemplate = async (): Promise<void> => {
    setBusy('exto-template');
    setToast(null);
    try {
      const data = await call(window.matchline.export.extoTemplateClear({}));
      setExtoTemplate(data.config.extoTemplate);
      setToast({ tone: 'success', text: 'The EXTO export is back on Matchline’s own columns.' });
    } catch (caught: unknown) {
      setToast({ tone: 'error', text: messageOf(caught) });
    } finally {
      setBusy(null);
    }
  };

  const pickTemplate = async (): Promise<void> => {
    setBusy('template-analyze');
    setToast(null);
    try {
      const picked = await call(window.matchline.dialog.openFile({ filters: XLSX_FILTERS }));
      if (picked.cancelled) {
        return;
      }
      const data = await call(window.matchline.export.templateAnalyze({ path: picked.path }));
      setAnalysis(data.analysis);
      setBindings(
        data.analysis.columns.map((column: WireTemplateColumn): WireTemplateBinding => ({
          templateColumn: column.header,
          field: column.suggestedField === '' ? 'blank' : column.suggestedField,
        })),
      );
    } catch (caught: unknown) {
      setToast({ tone: 'error', text: messageOf(caught) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="workspace-pane" data-testid="exports-view">
      {toast === null ? null : (
        <Callout tone={toast.tone === 'success' ? 'success' : 'error'}>{toast.text}</Callout>
      )}

      {restored ? (
        <RecompileNotice
          sentence="The generated MEL, the EXTO sheet, the predecessor matrix and the SSM hierarchy workbook are written from the compiled project, which the project file does not store. The register exports below work as they are."
          onRecompile={onRecompile}
          recompiling={recompiling}
          data-testid="exports-restored"
        />
      ) : null}

      <Panel
        title="Generated MEL"
        description="The canonical master equipment list this project's model can describe — a deliverable in its own right, not a copy of what you started with."
        actions={
          <button
            className="button button--primary button--small"
            type="button"
            data-testid="export-generated-mel"
            disabled={busy !== null}
            onClick={(): void => {
              void runExport('generated-mel', 'MEL', async (path) =>
                call(window.matchline.export.generatedMel({ path })),
              );
            }}
          >
            Export
          </button>
        }
      >
        <p className="muted">
          Byte-stable: exporting the same compile twice writes an identical file, so “has
          anything changed?” is answerable by hash.
        </p>
      </Panel>

      <Panel
        title="SSM Audit findings"
        description="What the SSM Audit rulebook makes of the register this compile produced — the same rules SSM-Audit applies to a finished Cx Registry, on the same two sheets."
        actions={
          <button
            className="button button--small"
            type="button"
            data-testid="export-ssm-audit"
            disabled={busy !== null}
            onClick={(): void => {
              void runExport('ssm-audit', 'SSM-Audit', async (path) =>
                call(window.matchline.export.ssmAudit({ path })),
              );
            }}
          >
            Export
          </button>
        }
      >
        <p className="muted">
          All Findings carries one row per finding with the rulebook's own words — what it saw,
          what it expected, what to do — graded INVALID, RULE BROKEN, CHECK THIS or NOTE. Rules
          carries every rule that is switched on, the plain sentence saying what must be true, and
          how many times it fired.
        </p>
        <p className="muted">
          Nothing here is recomputed for the file: these are the findings on screen 8 and in the
          review queue, so the workbook and the app can never describe different registers. A rule
          switched off on screen 8 is absent from both sheets.
        </p>
      </Panel>

      <Panel
        title="SSM hierarchy"
        description="The tree itself rather than a flat list: one column per configured level, in stack order, so the shape the compile settled on is readable across the page."
        actions={
          <button
            className="button button--small"
            type="button"
            data-testid="export-ssm-hierarchy"
            disabled={busy !== null}
            onClick={(): void => {
              void runExport('ssm-hierarchy', 'SSM-Hierarchy', async (path) =>
                call(window.matchline.export.ssmHierarchy({ path })),
              );
            }}
          >
            Export
          </button>
        }
      >
        <p className="muted">
          Every configured level gets its own column under the name you gave it — a level this
          site derived for itself included — and then each asset's tag, description, type,
          disciplines, system, structural parent, dependencies, whether it is a root and its full
          level path.
        </p>
        <p className="muted">
          A second sheet says which of those levels are structural boundaries. “These two never
          nest” is the most consequential thing the configuration says and the data columns cannot
          show it, so it is stated outright rather than left to be inferred from what is missing.
        </p>
      </Panel>

      <Panel
        title="Site-template MEL"
        description="Your own MEL layout, filled from the same data. Matchline reads the template's headers and suggests a binding for each column."
        actions={
          <button
            className="button button--small"
            type="button"
            data-testid="pick-template"
            disabled={busy !== null}
            onClick={(): void => {
              void pickTemplate();
            }}
          >
            {analysis === null ? 'Pick a template' : 'Pick a different template'}
          </button>
        }
      >
        {analysis === null ? (
          <Callout tone="info">
            No template picked. The canonical MEL above needs no template; this one exists for
            sites that hand over on their own sheet.
          </Callout>
        ) : (
          <>
            <p className="muted">
              {analysis.sheetName} — {count(analysis.columns.length)} columns, headers on row{' '}
              {String(analysis.headerRow + 1)}.
            </p>
            <TableScroll>
              <table className="table table--compact" data-testid="template-mapping">
                <thead>
                  <tr>
                    <th>Template column</th>
                    <th>Filled with</th>
                    <th>Matched by</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.columns.map((column: WireTemplateColumn, index: number): JSX.Element => (
                    <tr key={`${column.header}-${String(column.index)}`}>
                      <td>{column.header === '' ? <span className="muted">(no header)</span> : column.header}</td>
                      <td>
                        <select
                          className="control control--select"
                          aria-label={`Field for ${column.header}`}
                          data-testid={`binding-${column.index}`}
                          value={bindings[index]?.field ?? 'blank'}
                          onChange={(event): void => {
                            setBindings((current) =>
                              current.map((binding, position) =>
                                position === index
                                  ? { ...binding, field: event.target.value }
                                  : binding,
                              ),
                            );
                          }}
                        >
                          {analysis.fieldChoices.map((field: string): JSX.Element => (
                            <option key={field} value={field}>
                              {field === 'blank' ? 'Leave blank' : field}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="muted">
                        {column.match === '' ? 'nothing recognised it' : column.match}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            <button
              className="button button--primary button--small"
              type="button"
              data-testid="export-template-mel"
              disabled={busy !== null || bindings.length === 0}
              onClick={(): void => {
                void runExport('template-mel', 'Site-MEL', async (path) =>
                  call(window.matchline.export.templateMel({ path, bindings: [...bindings] })),
                );
              }}
            >
              Export on this template
            </button>
          </>
        )}
      </Panel>

      <Panel
        title="EXTO upload sheet"
        description="The Rev21 commissioning register. Item masters, WBS codes and classifications come from what the model states, or failing that from whatever registry you trained on screen 7; the milestone column needs a P6 schedule."
        actions={
          <button
            className="button button--small"
            type="button"
            data-testid="export-exto"
            disabled={busy !== null}
            onClick={(): void => {
              void runExport('exto', 'EXTO', async (path) =>
                call(window.matchline.export.exto({ path })),
              );
            }}
          >
            Export
          </button>
        }
      >
        <h3 className="panel__subtitle">Which columns it comes out on</h3>
        {extoTemplate === null ? (
          <Callout tone="info">
            Matchline’s own Rev21 columns. If your site keeps its register on a sheet of its
            own, hand that workbook over once and the export will come out on it instead —
            same headers, same width, same header row.
          </Callout>
        ) : (
          <div data-testid="exto-template-summary">
            <p className="muted">
              Captured from <strong>{extoTemplate.capturedFrom.label}</strong> (sheet{' '}
              {extoTemplate.sheetName}): {count(extoTemplate.headers.length)} columns, headers on
              row {String(extoTemplate.headerRowIndex + 1)}.{' '}
              {count(extoTemplate.matched.length)} of them are columns Matchline fills. The other{' '}
              {count(extoTemplate.headers.length - extoTemplate.matched.length)} come out empty —
              Matchline writes into a column only when your own header text said what it is for.
            </p>
          </div>
        )}
        <div className="button-row">
          <button
            className="button button--small"
            type="button"
            data-testid="capture-exto-template"
            disabled={busy !== null}
            onClick={(): void => {
              void captureExtoTemplate();
            }}
          >
            {extoTemplate === null ? 'Use my registry’s layout' : 'Capture a different layout'}
          </button>
          {extoTemplate === null ? null : (
            <button
              className="button button--small"
              type="button"
              data-testid="clear-exto-template"
              disabled={busy !== null}
              onClick={(): void => {
                void clearExtoTemplate();
              }}
            >
              Back to Matchline’s columns
            </button>
          )}
        </div>
        <p className="muted">
          A cell Matchline cannot fill honestly is left blank. The note after the export says
          which ones those were.
        </p>
      </Panel>

      <Panel
        title="Predecessor matrix"
        description="Which systems have to start up before which, derived from the dependencies the boundary fold produced."
        actions={
          <button
            className="button button--small"
            type="button"
            data-testid="export-predecessors"
            disabled={busy !== null}
            onClick={(): void => {
              void runExport('predecessors', 'Predecessors', async (path) =>
                call(window.matchline.export.predecessors({ path })),
              );
            }}
          >
            Export
          </button>
        }
      >
        <p className="muted">
          A precedence cycle is reported in the file, never broken silently.
        </p>
      </Panel>

      <Panel
        title="Revision diff"
        description="What changed between this compile and an earlier one: added and removed equipment, changed descriptions and systems, moved parents."
        actions={
          <button
            className="button button--small"
            type="button"
            data-testid="export-revision-diff"
            disabled={busy !== null || baseline === null}
            onClick={(): void => {
              if (baseline === null) {
                return;
              }
              void runExport('revision-diff', 'Revision-Diff', async (path) =>
                call(
                  window.matchline.export.revisionDiff({ path, previousCompileId: baseline }),
                ),
              );
            }}
          >
            Export
          </button>
        }
      >
        {history.length < 2 ? (
          <Callout tone="info">
            Only {count(history.length)} compile so far. A diff needs an earlier one to compare
            against — compile again after the next model revision and this fills in.
          </Callout>
        ) : (
          <label className="inline-field inline-field--wide">
            <span>Compare against</span>
            <select
              className="control control--select"
              data-testid="diff-baseline"
              value={baseline === null ? '' : String(baseline)}
              onChange={(event): void => {
                const parsed = Number.parseInt(event.target.value, 10);
                setBaseline(Number.isNaN(parsed) ? null : parsed);
              }}
            >
              {history.map((entry: WireCompileHistoryEntry): JSX.Element => (
                <option key={entry.compileId} value={String(entry.compileId)} disabled={!entry.diffable}>
                  {`Compile ${String(entry.compileId)} · ${entry.finishedAt.slice(0, 16).replace('T', ' ')} · ${count(entry.assetCount)} assets${
                    entry.diffable ? '' : ' (no register stored)'
                  }`}
                </option>
              ))}
            </select>
          </label>
        )}
      </Panel>
    </div>
  );
}
