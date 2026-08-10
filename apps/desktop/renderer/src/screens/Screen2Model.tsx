import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type {
  WireModelScan,
  WireModelUniverse,
  WirePropertyCatalogRow,
  WirePropertySort,
  WirePropertySourceCoverage,
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
 *
 * The catalog is aggregated over every model source in the project (P0-1), so
 * every row carries two facts: coverage across the site, and coverage per file.
 * The second is the one that turns "the tag is on 61% of objects" into "the
 * controls model is the one that does not carry it".
 */

/**
 * One catalog row, and the taller one a universe needs.
 *
 * The virtualizer positions rows absolutely at a fixed height, so this is the
 * height the content has to fit inside — not a suggestion. A multi-source row
 * carries a second line, and a row whose content outgrew its box shows the top
 * of the next row through the gap.
 */
const ROW_HEIGHT = 52;
const SOURCED_ROW_HEIGHT = 70;
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

/**
 * Which universe the loaded rows belong to.
 *
 * Row *indices* only mean something under the catalog they were fetched from,
 * and adding or replacing a model source produces a different catalog — so this
 * is part of the fetch generation, exactly as the sort and the search are.
 */
function universeKeyOf(universe: WireModelUniverse | null): string {
  return universe === null
    ? ''
    : universe.sources.map((source: WireModelScan): string => source.sourceId).join('|');
}

/**
 * `mechanical 98% · controls 61%` — the per-source coverage behind one overall
 * number (P0-1).
 *
 * Ordered by coverage descending so the file that is missing the property is
 * the one at the end, which is where a reader looking for a gap looks.
 */
function coverageDisclosure(bySource: readonly WirePropertySourceCoverage[]): string {
  return [...bySource]
    .sort(
      (left: WirePropertySourceCoverage, right: WirePropertySourceCoverage): number =>
        right.coverage - left.coverage,
    )
    .map(
      (source: WirePropertySourceCoverage): string => `${source.label} ${percent(source.coverage)}`,
    )
    .join(' · ');
}

export function Screen2Model({ context }: { readonly context: WizardContext }): JSX.Element {
  const [sortBy, setSortBy] = useState<WirePropertySort>('coverage');
  const [descending, setDescending] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [total, setTotal] = useState<number>(0);
  const [rows, setRows] = useState<ReadonlyMap<number, WirePropertyCatalogRow>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const universe = context.universe;

  /**
   * One string naming the current ordering. Row *indices* only mean anything
   * under the ordering they were fetched for, so this is both the cache key and
   * the guard on every in-flight response.
   */
  const queryKey = `${sortBy}|${String(descending)}|${search}|${universeKeyOf(universe)}`;
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

  const rowHeight = (universe?.sourceCount ?? 0) < 2 ? ROW_HEIGHT : SOURCED_ROW_HEIGHT;
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: (): HTMLDivElement | null => scrollRef.current,
    estimateSize: (): number => rowHeight,
    overscan: 10,
  });

  // The row height changes when a project goes from one model source to two,
  // and the virtualizer caches what it measured. Without this the list would
  // keep positioning rows at the old pitch and overlap them.
  useEffect((): void => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

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

  if (universe === null) {
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

      <Panel title="What the extractions contain">
        <StatRow>
          <Stat label="Model sources" value={count(universe.sourceCount)} />
          <Stat label="Objects" value={count(universe.objectCount)} />
          <Stat
            label="Distinct properties"
            value={count(universe.propertyNameCount)}
            hint={
              universe.sourceCount < 2 ? undefined : 'Across every source; shared names counted once'
            }
          />
          <Stat label="Extraction warnings" value={count(universe.warningCount)} />
        </StatRow>

        <TableScroll>
          <table className="table" data-testid="source-model-table">
            <thead>
              <tr>
                <th>Model source</th>
                <th>Source model</th>
                <th className="table__number">Objects</th>
              </tr>
            </thead>
            <tbody>
              {universe.sources.flatMap((source: WireModelScan): readonly JSX.Element[] =>
                source.sourceModels.map(
                  (model: WireSourceModelSummary, index: number): JSX.Element => (
                    <tr key={`${source.sourceId} ${String(model.sourceModelId)} ${model.fileName}`}>
                      {/* The file a person registered, stated once per group;
                          the rows under it are the models inside it. */}
                      <td>
                        {index === 0 ? (
                          <span title={`Navisworks ${source.navisworksVersion}`}>
                            {source.displayName}
                          </span>
                        ) : (
                          ''
                        )}
                      </td>
                      <td>{model.fileName}</td>
                      <td className="table__number">{count(model.objectCount)}</td>
                    </tr>
                  ),
                ),
              )}
              <tr className="table__total">
                <td>{count(universe.sourceCount)} sources</td>
                <td>
                  {count(
                    universe.sources.reduce(
                      (total: number, source: WireModelScan): number =>
                        total + source.sourceModels.length,
                      0,
                    ),
                  )}{' '}
                  source models
                </td>
                <td className="table__number">{count(universe.objectCount)}</td>
              </tr>
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

        <div
          className={`virtual-table${universe.sourceCount < 2 ? '' : ' virtual-table--sourced'}`}
          data-testid="property-catalog"
        >
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
                        {universe.sourceCount < 2 ? null : (
                          // A second line spanning the whole row: which file
                          // carries the property, and which one does not.
                          <span
                            className="virtual-table__sources"
                            title={coverageDisclosure(row.bySource)}
                          >
                            {coverageDisclosure(row.bySource)}
                          </span>
                        )}
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
