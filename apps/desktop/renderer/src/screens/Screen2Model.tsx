import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type {
  WirePropertyCatalogRow,
  WirePropertySort,
  WireSourceModelSummary,
  WireSuggestedRole,
} from '../../../shared/schemas';
import { call, count, messageOf, percent } from '../api';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';

import type { WizardContext } from './Wizard';

/**
 * Screen 2 — Model scan and Property Catalog (PRODUCT.md §6.5, §7).
 *
 * The catalog can run to thousands of `(category, name)` pairs, so it stays in
 * the main process and this list asks for the rows it is about to paint
 * (APP.md "IPC contract"). Chunks already fetched are kept; changing the sort or
 * the search starts a new generation and drops them, because a row's position
 * is only meaningful under the ordering it was fetched for.
 */

const ROW_HEIGHT = 52;
const CHUNK_SIZE = 100;

const ROLE_LABELS: Readonly<Record<WireSuggestedRole, string>> = {
  'equipment-tag': 'Equipment Tag',
  building: 'Building',
  description: 'Description',
};

const SORT_LABELS: ReadonlyArray<readonly [WirePropertySort, string]> = [
  ['coverage', 'Coverage'],
  ['distinct', 'Distinct values'],
  ['name', 'Property name'],
];

export function Screen2Model({ context }: { readonly context: WizardContext }): JSX.Element {
  const [sortBy, setSortBy] = useState<WirePropertySort>('coverage');
  const [descending, setDescending] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [total, setTotal] = useState<number>(0);
  const [rows, setRows] = useState<ReadonlyMap<number, WirePropertyCatalogRow>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasModel = context.scan !== null;

  /**
   * One string naming the current ordering. Row *indices* only mean anything
   * under the ordering they were fetched for, so this is both the cache key and
   * the guard on every in-flight response.
   */
  const queryKey = `${sortBy}|${String(descending)}|${search}|${context.scan?.fileName ?? ''}`;
  const loaded = useRef<{ key: string; chunks: Set<number> }>({
    key: '',
    chunks: new Set<number>(),
  });

  const loadChunk = useCallback(
    async (chunk: number, key: string): Promise<void> => {
      try {
        const page = await call(
          window.matchline.model.propertyPage({
            offset: chunk * CHUNK_SIZE,
            limit: CHUNK_SIZE,
            sortBy,
            descending,
            search,
          }),
        );
        // Arrived after the ordering changed: these rows no longer live at
        // those indices, so they are dropped rather than painted.
        if (loaded.current.key !== key) {
          return;
        }
        setTotal(page.total);
        setRows((current: ReadonlyMap<number, WirePropertyCatalogRow>) => {
          const next = new Map(current);
          page.rows.forEach((row: WirePropertyCatalogRow, index: number): void => {
            next.set(chunk * CHUNK_SIZE + index, row);
          });
          return next;
        });
      } catch (caught: unknown) {
        setError(messageOf(caught));
      }
    },
    [descending, search, sortBy],
  );

  useEffect((): void => {
    loaded.current = { key: queryKey, chunks: new Set<number>([0]) };
    setRows(new Map());
    setTotal(0);
    void loadChunk(0, queryKey);
  }, [queryKey, loadChunk]);

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: (): HTMLDivElement | null => scrollRef.current,
    estimateSize: (): number => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const firstIndex = virtualItems[0]?.index ?? 0;
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? 0;

  useEffect((): void => {
    if (loaded.current.key !== queryKey) {
      return;
    }
    const firstChunk = Math.floor(firstIndex / CHUNK_SIZE);
    const lastChunk = Math.floor(lastIndex / CHUNK_SIZE);
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      if (!loaded.current.chunks.has(chunk)) {
        loaded.current.chunks.add(chunk);
        void loadChunk(chunk, queryKey);
      }
    }
  }, [firstIndex, lastIndex, queryKey, loadChunk]);

  if (!hasModel) {
    return (
      <div className="screen" data-testid="screen-2">
        <header className="screen__header">
          <h1 className="screen__title">2. Model scan</h1>
        </header>
        <Callout tone="info">
          No model yet. Add a `.matchline-cache` extraction on screen 1 and this screen fills
          in on its own.
        </Callout>
      </div>
    );
  }

  const scan = context.scan;

  return (
    <div className="screen" data-testid="screen-2">
      <header className="screen__header">
        <h1 className="screen__title">2. Model scan and Property Catalog</h1>
        <p className="screen__lede">
          Everything the extraction found, ranked by how much of the model actually carries
          it. Coverage is the number that matters: a property on 4% of objects cannot be your
          equipment tag no matter how promising its name is.
        </p>
      </header>

      <Panel title="What the extraction contains">
        <StatRow>
          <Stat label="Objects" value={count(scan?.objectCount ?? 0)} />
          <Stat label="Distinct properties" value={count(scan?.propertyNameCount ?? 0)} />
          <Stat label="Source models" value={count(scan?.sourceModels.length ?? 0)} />
          <Stat
            label="Extraction warnings"
            value={count(scan?.warningCount ?? 0)}
            hint={scan?.navisworksVersion === '' ? undefined : `Navisworks ${scan?.navisworksVersion ?? ''}`}
          />
        </StatRow>

        <TableScroll>
          <table className="table" data-testid="source-model-table">
            <thead>
              <tr>
                <th>Source model</th>
                <th className="table__number">Objects</th>
              </tr>
            </thead>
            <tbody>
              {(scan?.sourceModels ?? []).map((model: WireSourceModelSummary): JSX.Element => (
                <tr key={`${String(model.sourceModelId)} ${model.fileName}`}>
                  <td>{model.fileName}</td>
                  <td className="table__number">{count(model.objectCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>

      <Panel
        title="Property Catalog"
        description={`${count(total)} properties. Suggestions are name matches only — check the coverage and the examples before you trust one.`}
      >
        <div className="toolbar">
          <input
            className="control control--text"
            type="search"
            placeholder="Filter by property or category"
            aria-label="Filter properties"
            data-testid="property-search"
            value={search}
            onChange={(event): void => {
              setSearch(event.target.value);
            }}
          />
          <div className="toolbar__group">
            {SORT_LABELS.map(([key, label]): JSX.Element => (
              <button
                key={key}
                type="button"
                className={`button button--small${sortBy === key ? ' button--active' : ''}`}
                data-testid={`sort-${key}`}
                onClick={(): void => {
                  if (sortBy === key) {
                    setDescending((value: boolean): boolean => !value);
                  } else {
                    setSortBy(key);
                    setDescending(key !== 'name');
                  }
                }}
              >
                {label}
                {sortBy === key ? (descending ? ' ↓' : ' ↑') : ''}
              </button>
            ))}
          </div>
        </div>

        {error === null ? null : <Callout tone="error">{error}</Callout>}

        <div className="virtual-table" data-testid="property-catalog">
          <div className="virtual-table__head">
            <span className="virtual-table__cell virtual-table__cell--wide">Property</span>
            <span className="virtual-table__cell virtual-table__cell--number">Coverage</span>
            <span className="virtual-table__cell virtual-table__cell--number">Distinct</span>
            <span className="virtual-table__cell virtual-table__cell--examples">Examples</span>
            <span className="virtual-table__cell virtual-table__cell--role">Suggestion</span>
          </div>

          <div className="virtual-table__viewport" ref={scrollRef}>
            <div
              className="virtual-table__canvas"
              style={{ height: `${String(virtualizer.getTotalSize())}px` }}
            >
              {virtualItems.map((item): JSX.Element => {
                const row = rows.get(item.index);
                return (
                  <div
                    key={item.key}
                    className="virtual-table__row"
                    style={{
                      height: `${String(item.size)}px`,
                      transform: `translateY(${String(item.start)}px)`,
                    }}
                  >
                    {row === undefined ? (
                      <span className="virtual-table__cell virtual-table__cell--wide muted">
                        Loading…
                      </span>
                    ) : (
                      <>
                        <span className="virtual-table__cell virtual-table__cell--wide">
                          <span className="property__category">{row.category}</span>
                          <span className="property__name">{row.name}</span>
                        </span>
                        <span className="virtual-table__cell virtual-table__cell--number">
                          {percent(row.coverage)}
                          <span className="muted"> · {count(row.objectCount)}</span>
                        </span>
                        <span className="virtual-table__cell virtual-table__cell--number">
                          {count(row.distinctValueCount)}
                        </span>
                        <span className="virtual-table__cell virtual-table__cell--examples">
                          {row.examples.length === 0 ? (
                            <span className="muted">no values</span>
                          ) : (
                            row.examples.join(' · ')
                          )}
                        </span>
                        <span className="virtual-table__cell virtual-table__cell--role">
                          {row.suggestedRole === null ? (
                            ''
                          ) : (
                            <span className="badge badge--suggestion">
                              {ROLE_LABELS[row.suggestedRole]}?
                            </span>
                          )}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <Callout tone="info">
          Nothing here is mapped yet. Screen 3 is where you say which of these properties is
          the equipment tag, the description, and so on.
        </Callout>
      </Panel>
    </div>
  );
}
