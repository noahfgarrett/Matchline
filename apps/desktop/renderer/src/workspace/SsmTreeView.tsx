import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type {
  WireOverrideRow,
  WireReparentPreview,
  WireTreeNode,
} from '../../../shared/schemas';
import { call, count, messageOf } from '../api';
import { Callout, Panel, TableScroll } from '../components/Panel';

/**
 * The SSM hierarchy, as a virtualized tree over paged children-of requests.
 *
 * ## Why a drag does not move the row
 *
 * Dropping one asset on another writes a `ManualRelationshipOverride` and
 * nothing else (PRODUCT.md §11.5: a drag "should create a persistent
 * relationship override, not mutate the output tree only"). The tree the user
 * is looking at is the last compile's output, and the override is one input to
 * the next one — so the row stays where it is until a recompile, and the app
 * asks for that recompile rather than drawing a second, weaker version of the
 * ladder on top of the real one.
 *
 * ## Why the whole tree is not fetched
 *
 * A site's register runs to thousands of assets. `tree:children` answers one
 * node's children at a time and the expanded set decides what is asked for, so
 * the renderer holds the rows it is drawing and nothing else (APP.md "IPC
 * contract").
 */

const ROW_HEIGHT = 40;
const CHILD_PAGE = 200;
const ROOT_KEY = '';

interface FlatRow {
  readonly node: WireTreeNode;
  readonly depth: number;
}

/** Marks a row as a drop target and names the droppable it belongs to. */
const DROP_ATTRIBUTE = 'data-drop-id';

/**
 * The row actually under the cursor, and nothing else.
 *
 * dnd-kit's own `pointerWithin` compares the pointer against rects it measured
 * when the drag started. That is wrong for this tree twice over: the rows are
 * absolutely positioned by a virtualizer inside a scrolling viewport, so a rect
 * can be stale by the time it is compared. Worse is the usual remedy —
 * `closestCenter` — which *always* returns something, so a drop into empty
 * space silently reparents equipment under whichever row happened to be
 * nearest. Reparenting the wrong asset because the drop missed is not a
 * cosmetic failure.
 *
 * Hit-testing the live DOM has neither problem: it answers "what is under the
 * cursor right now", and it answers nothing when the cursor is over a level row
 * or the gap below the tree — which correctly discards the drag.
 */
const collisionDetection: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates;
  if (pointer === null) {
    return [];
  }
  const element = document.elementFromPoint(pointer.x, pointer.y);
  const dropId = element?.closest(`[${DROP_ATTRIBUTE}]`)?.getAttribute(DROP_ATTRIBUTE);
  if (dropId === null || dropId === undefined) {
    return [];
  }
  const container = args.droppableContainers.find(
    (candidate): boolean => String(candidate.id) === dropId,
  );
  return container === undefined ? [] : [{ id: container.id }];
};

interface PendingMove {
  readonly childAssetId: string;
  readonly childTag: string;
  readonly parentAssetId: string | null;
  readonly parentTag: string;
  readonly preview: WireReparentPreview;
}

export function SsmTreeView({
  onRecompile,
  recompiling,
}: {
  readonly onRecompile: () => Promise<void>;
  readonly recompiling: boolean;
}): JSX.Element {
  const [children, setChildren] = useState<ReadonlyMap<string, readonly WireTreeNode[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([ROOT_KEY]));
  const [search, setSearch] = useState<string>('');
  const [hits, setHits] = useState<readonly WireTreeNode[]>([]);
  const [overrides, setOverrides] = useState<readonly WireOverrideRow[]>([]);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [note, setNote] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<boolean>(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadChildren = useCallback(async (nodeKey: string): Promise<void> => {
    try {
      const page = await call(
        window.matchline.tree.children({ nodeKey, offset: 0, limit: CHILD_PAGE }),
      );
      setChildren((current) => {
        const next = new Map(current);
        next.set(nodeKey, page.rows);
        return next;
      });
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  const refreshOverrides = useCallback(async (): Promise<void> => {
    try {
      const data = await call(window.matchline.override.list());
      setOverrides(data.overrides);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  useEffect((): void => {
    void loadChildren(ROOT_KEY);
    void refreshOverrides();
  }, [loadChildren, refreshOverrides]);

  useEffect((): (() => void) => {
    const query = search.trim();
    if (query === '') {
      setHits([]);
      return (): void => {
        // Nothing in flight.
      };
    }
    let cancelled = false;
    void call(window.matchline.tree.search({ query, limit: 50 })).then(
      (data): void => {
        if (!cancelled) {
          setHits(data.rows);
        }
      },
      (caught: unknown): void => {
        if (!cancelled) {
          setError(messageOf(caught));
        }
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [search]);

  const toggle = (nodeKey: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(nodeKey)) {
        next.delete(nodeKey);
      } else {
        next.add(nodeKey);
        if (!children.has(nodeKey)) {
          void loadChildren(nodeKey);
        }
      }
      return next;
    });
  };

  const rows: readonly FlatRow[] = useMemo((): readonly FlatRow[] => {
    const flat: FlatRow[] = [];
    const walk = (nodeKey: string, depth: number): void => {
      for (const node of children.get(nodeKey) ?? []) {
        flat.push({ node, depth });
        if (expanded.has(node.nodeKey)) {
          walk(node.nodeKey, depth + 1);
        }
      }
    };
    walk(ROOT_KEY, 0);
    return flat;
  }, [children, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: (): HTMLDivElement | null => scrollRef.current,
    estimateSize: (): number => ROW_HEIGHT,
    overscan: 12,
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const proposeMove = useCallback(
    async (childAssetId: string, childTag: string, parentAssetId: string | null, parentTag: string): Promise<void> => {
      setError(null);
      try {
        const data = await call(
          window.matchline.tree.reparentPreview({ childAssetId, parentAssetId }),
        );
        setPending({ childAssetId, childTag, parentAssetId, parentTag, preview: data.preview });
        setNote('');
      } catch (caught: unknown) {
        setError(messageOf(caught));
      }
    },
    [],
  );

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null) {
      return;
    }
    const child = active.data.current as { assetId?: string; tag?: string } | undefined;
    const parent = over.data.current as { assetId?: string | null; tag?: string } | undefined;
    if (child?.assetId === undefined || parent === undefined) {
      return;
    }
    const parentAssetId = parent.assetId ?? null;
    if (parentAssetId === child.assetId) {
      return;
    }
    void proposeMove(child.assetId, child.tag ?? child.assetId, parentAssetId, parent.tag ?? '');
  };

  const applyMove = async (recompileNow: boolean): Promise<void> => {
    if (pending === null) {
      return;
    }
    setError(null);
    try {
      const data = await call(
        window.matchline.override.set({
          childAssetId: pending.childAssetId,
          parentAssetId: pending.parentAssetId,
          note,
        }),
      );
      setOverrides(data.overrides);
      setPending(null);
      setDirty(true);
      if (recompileNow) {
        await onRecompile();
        setDirty(false);
        setChildren(new Map());
        setExpanded(new Set([ROOT_KEY]));
        await loadChildren(ROOT_KEY);
        await refreshOverrides();
      }
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  };

  const removeOverride = async (childAssetId: string): Promise<void> => {
    setError(null);
    try {
      const data = await call(window.matchline.override.remove({ childAssetId }));
      setOverrides(data.overrides);
      setDirty(true);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  };

  const recompileNow = async (): Promise<void> => {
    await onRecompile();
    setDirty(false);
    setChildren(new Map());
    setExpanded(new Set([ROOT_KEY]));
    await loadChildren(ROOT_KEY);
    await refreshOverrides();
  };

  return (
    <div className="workspace-pane" data-testid="ssm-tree">
      {error === null ? null : <Callout tone="error">{error}</Callout>}

      {dirty ? (
        <div className="callout callout--warning recompile-bar" role="status">
          <span>
            Manual corrections have changed. The tree below is still the last compile — apply
            the changes to see them.
          </span>
          <button
            className="button button--primary button--small"
            type="button"
            data-testid="recompile"
            disabled={recompiling}
            onClick={(): void => {
              void recompileNow();
            }}
          >
            {recompiling ? 'Recompiling…' : 'Apply changes — recompile now?'}
          </button>
        </div>
      ) : null}

      {pending === null ? null : (
        <Panel
          title={
            pending.parentAssetId === null
              ? `Make ${pending.childTag} a root`
              : `Move ${pending.childTag} under ${pending.parentTag}`
          }
          description="This writes a manual override. It outranks every rule, and it is kept across boundaries."
        >
          <Callout tone={pending.preview.allowed ? 'info' : 'error'}>
            {pending.preview.explanation}
          </Callout>
          <div className="toolbar">
            <input
              className="control control--text"
              type="text"
              placeholder="Why? (kept with the override)"
              aria-label="Override note"
              data-testid="override-note"
              value={note}
              onChange={(event): void => {
                setNote(event.target.value);
              }}
            />
            <div className="toolbar__group">
              <button
                className="button button--primary button--small"
                type="button"
                data-testid="override-apply-recompile"
                disabled={!pending.preview.allowed || recompiling}
                onClick={(): void => {
                  void applyMove(true);
                }}
              >
                Apply changes — recompile now?
              </button>
              <button
                className="button button--small"
                type="button"
                data-testid="override-apply"
                disabled={!pending.preview.allowed}
                onClick={(): void => {
                  void applyMove(false);
                }}
              >
                Save, recompile later
              </button>
              <button
                className="button button--quiet button--small"
                type="button"
                onClick={(): void => {
                  setPending(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Panel>
      )}

      <div className="toolbar">
        <input
          className="control control--text"
          type="search"
          placeholder="Find equipment by tag"
          aria-label="Find equipment by tag"
          data-testid="tree-search"
          value={search}
          onChange={(event): void => {
            setSearch(event.target.value);
          }}
        />
      </div>

      {hits.length === 0 ? null : (
        <Panel title={`${count(hits.length)} matching tags`}>
          <TableScroll>
            <table className="table table--compact" data-testid="tree-search-hits">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Description</th>
                  <th>Placement</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hits.map((hit: WireTreeNode): JSX.Element => (
                  <tr key={hit.nodeKey}>
                    <td>{hit.label}</td>
                    <td className="muted">{hit.detail}</td>
                    <td>
                      <span className="badge">{hit.parentStatus}</span>
                    </td>
                    <td>
                      <button
                        className="button button--quiet button--small"
                        type="button"
                        onClick={(): void => {
                          void proposeMove(hit.assetId, hit.label, null, '');
                        }}
                      >
                        Make a root
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Panel>
      )}

      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={onDragEnd}>
        <div className="tree" data-testid="tree">
          <div className="tree__viewport" ref={scrollRef}>
            <div
              className="tree__canvas"
              style={{ height: `${String(virtualizer.getTotalSize())}px` }}
            >
              {virtualizer.getVirtualItems().map((item): JSX.Element | null => {
                const row = rows[item.index];
                if (row === undefined) {
                  return null;
                }
                return (
                  <TreeRow
                    key={item.key}
                    row={row}
                    top={item.start}
                    height={item.size}
                    expanded={expanded.has(row.node.nodeKey)}
                    onToggle={(): void => {
                      toggle(row.node.nodeKey);
                    }}
                    onMakeRoot={(): void => {
                      void proposeMove(row.node.assetId, row.node.label, null, '');
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </DndContext>

      <Panel
        title="Manual corrections"
        description="Every override this project carries. Removing one and recompiling is the undo."
      >
        {overrides.length === 0 ? (
          <Callout tone="info">
            Nothing has been overridden. Drag one asset onto another in the tree above, or use
            “Make a root”, to state a parent by hand.
          </Callout>
        ) : (
          <TableScroll>
            <table className="table table--compact" data-testid="override-list">
              <thead>
                <tr>
                  <th>Equipment</th>
                  <th>Parent</th>
                  <th>Why</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overrides.map((override: WireOverrideRow): JSX.Element => (
                  <tr key={override.childAssetId}>
                    <td>{override.childTag === '' ? override.childAssetId : override.childTag}</td>
                    <td>
                      {override.parentAssetId === '' ? (
                        <span className="badge">root</span>
                      ) : override.parentTag === '' ? (
                        override.parentAssetId
                      ) : (
                        override.parentTag
                      )}
                    </td>
                    <td className="muted">{override.note}</td>
                    <td>
                      <button
                        className="button button--quiet button--small"
                        type="button"
                        data-testid={`override-remove-${override.childAssetId}`}
                        onClick={(): void => {
                          void removeOverride(override.childAssetId);
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}

function TreeRow({
  row,
  top,
  height,
  expanded,
  onToggle,
  onMakeRoot,
}: {
  readonly row: FlatRow;
  readonly top: number;
  readonly height: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onMakeRoot: () => void;
}): JSX.Element {
  const node = row.node;
  const isAsset = node.kind === 'asset';

  const dropId = `drop-${node.nodeKey}`;
  const draggable = useDraggable({
    id: `drag-${node.nodeKey}`,
    disabled: !isAsset,
    data: { assetId: node.assetId, tag: node.label },
  });
  const droppable = useDroppable({
    id: dropId,
    disabled: !isAsset,
    data: { assetId: node.assetId, tag: node.label },
  });

  return (
    <div
      ref={droppable.setNodeRef}
      className={`tree__row${droppable.isOver ? ' tree__row--over' : ''}${
        draggable.isDragging ? ' tree__row--dragging' : ''
      }`}
      style={{
        height: `${String(height)}px`,
        transform: `translateY(${String(top)}px)`,
        paddingLeft: `${String(row.depth * 18 + 8)}px`,
      }}
      data-testid={`tree-row-${node.nodeKey}`}
      {...(isAsset ? { [DROP_ATTRIBUTE]: dropId } : {})}
    >
      <button
        type="button"
        className="tree__twisty"
        aria-label={expanded ? 'Collapse' : 'Expand'}
        aria-expanded={expanded}
        disabled={node.childCount === 0}
        onClick={onToggle}
      >
        {node.childCount === 0 ? '·' : expanded ? '▾' : '▸'}
      </button>

      {isAsset ? (
        <span
          ref={draggable.setNodeRef}
          className="tree__grip"
          aria-label={`Drag ${node.label}`}
          {...draggable.attributes}
          {...draggable.listeners}
        >
          ⠿
        </span>
      ) : (
        <span className="tree__grip tree__grip--empty" aria-hidden="true" />
      )}

      <span className={`tree__label${isAsset ? '' : ' tree__label--level'}`}>{node.label}</span>
      <span className="tree__detail muted">{node.detail}</span>

      <span className="tree__badges">
        {node.childCount === 0 ? null : (
          <span className="badge">{count(node.childCount)} under</span>
        )}
        {node.dependencyCount === 0 ? null : (
          <span className="badge" title="Additive dependencies: they order work, they never nest">
            {count(node.dependencyCount)} deps
          </span>
        )}
        {node.demoted ? (
          <span className="badge badge--needs-attention" title="A boundary took this asset's selected parent away and made it a dependency">
            demoted
          </span>
        ) : null}
        {node.overridden ? (
          <span className="badge badge--suggestion" title="This parent was stated by hand">
            manual
          </span>
        ) : null}
        {node.reviewFlagCount === 0 ? null : (
          <span className="badge badge--file-missing">{count(node.reviewFlagCount)} to review</span>
        )}
      </span>

      {isAsset ? (
        <button
          type="button"
          className="button button--quiet button--small tree__action"
          data-testid={`make-root-${node.assetId}`}
          onClick={onMakeRoot}
        >
          Make a root
        </button>
      ) : null}
    </div>
  );
}
