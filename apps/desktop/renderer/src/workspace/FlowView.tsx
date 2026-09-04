import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type { WireFlowNode, WireFlowRoot } from '../../../shared/schemas';
import { call, count, messageOf } from '../api';
import { Callout, Panel } from '../components/Panel';

/**
 * Electrical Flow (PRODUCT.md §10).
 *
 * Source-to-load from one root at a time, virtualized over a paged walk. Two
 * things this view must not do, and does not:
 *
 * - **It does not apply SSM boundaries.** A feed that crosses a system,
 *   building or discipline is drawn as a feed, because this is the one view
 *   where the physical chain stays whole (DECISIONS.md #1).
 * - **It does not descend into instruments.** A PMD relation is a badge on the
 *   node it terminates at, not another rung of the tree.
 */

const ROW_HEIGHT = 44;
const PAGE_SIZE = 200;

const STATUS_LABELS: Readonly<Record<string, string>> = {
  'model-confirmed': 'in the model',
  'flow-only': 'one-line only',
  'pmd-only': 'PMD only',
};

const STATUS_BADGE: Readonly<Record<string, string>> = {
  'model-confirmed': 'badge--ready',
  'flow-only': 'badge--needs-attention',
  'pmd-only': 'badge--needs-attention',
};

export function FlowView(): JSX.Element {
  const [roots, setRoots] = useState<readonly WireFlowRoot[]>([]);
  const [rootTotal, setRootTotal] = useState<number>(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [nodes, setNodes] = useState<readonly WireFlowNode[]>([]);
  const [nodeTotal, setNodeTotal] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * `flow:roots` is paged like the walk below it, and for the same reason: a
   * site with a few hundred incoming feeds and every ring segment that heads
   * its own list can pass the cap. Keeping only the first page and printing the
   * true total beside it would claim more sources than the chip row shows, so
   * the count is honest only if the rest can actually be asked for.
   */
  const loadRoots = useCallback(async (offset: number): Promise<void> => {
    try {
      const page = await call(window.matchline.flow.roots({ offset, limit: PAGE_SIZE }));
      setRootTotal(page.total);
      setRoots((current) => (offset === 0 ? page.rows : [...current, ...page.rows]));
      if (offset === 0) {
        setSelected(page.rows[0]?.nodeId ?? null);
      }
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  useEffect((): void => {
    void loadRoots(0);
  }, [loadRoots]);

  const loadWalk = useCallback(async (rootNodeId: string, offset: number): Promise<void> => {
    try {
      const page = await call(
        window.matchline.flow.walk({ rootNodeId, offset, limit: PAGE_SIZE }),
      );
      setNodeTotal(page.total);
      setNodes((current) => (offset === 0 ? page.rows : [...current, ...page.rows]));
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  useEffect((): void => {
    setNodes([]);
    setNodeTotal(0);
    if (selected !== null) {
      void loadWalk(selected, 0);
    }
  }, [selected, loadWalk]);

  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: (): HTMLDivElement | null => scrollRef.current,
    estimateSize: (): number => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="workspace-pane" data-testid="flow-view">
      {error === null ? null : <Callout tone="error">{error}</Callout>}

      <Panel
        title="Sources"
        description={`${count(rootTotal)} starting points. A node inside a ring feed, or one nothing feeds, heads its own list rather than disappearing.`}
      >
        {roots.length === 0 ? (
          <Callout tone="info">
            No connectivity yet. Add an EasyPower export, a cable schedule or a PMD on screen 1
            and compile again.
          </Callout>
        ) : (
          <>
            <div className="chip-row" data-testid="flow-roots">
              {roots.map((root: WireFlowRoot): JSX.Element => (
                <button
                  key={root.nodeId}
                  type="button"
                  className={`chip${selected === root.nodeId ? ' chip--active' : ''}`}
                  data-testid={`flow-root-${root.nodeId}`}
                  onClick={(): void => {
                    setSelected(root.nodeId);
                  }}
                >
                  <span className="chip__label">{root.tag}</span>
                  <span className="chip__hint">{count(root.reachableCount)} downstream</span>
                </button>
              ))}
            </div>
            {roots.length < rootTotal ? (
              <button
                className="button button--small"
                type="button"
                data-testid="flow-roots-more"
                onClick={(): void => {
                  void loadRoots(roots.length);
                }}
              >
                Show {count(Math.min(PAGE_SIZE, rootTotal - roots.length))} more
              </button>
            ) : null}
          </>
        )}
      </Panel>

      {selected === null ? null : (
        <Panel
          title="Source to load"
          description="Each node appears once. A load fed from two directions is one node with two feeds, not two subtrees."
        >
          <div className="tree" data-testid="flow-tree">
            <div className="tree__viewport" ref={scrollRef}>
              <div
                className="tree__canvas"
                style={{ height: `${String(virtualizer.getTotalSize())}px` }}
              >
                {virtualizer.getVirtualItems().map((item): JSX.Element | null => {
                  const node = nodes[item.index];
                  if (node === undefined) {
                    return null;
                  }
                  return (
                    <div
                      key={item.key}
                      className="tree__row"
                      style={{
                        height: `${String(item.size)}px`,
                        transform: `translateY(${String(item.start)}px)`,
                        paddingLeft: `${String(node.depth * 18 + 8)}px`,
                      }}
                      data-testid={`flow-node-${node.nodeId}`}
                    >
                      <span className="tree__label">{node.tag}</span>
                      <span className="tree__detail muted">
                        {node.viaCable === '' ? '' : `via ${node.viaCable} · `}
                        {node.description === '' ? node.systemLabel : node.description}
                        {node.building === '' ? '' : ` · ${node.building}`}
                      </span>
                      <span className="tree__badges">
                        <span className={`badge ${STATUS_BADGE[node.matchStatus] ?? ''}`}>
                          {STATUS_LABELS[node.matchStatus] ?? node.matchStatus}
                        </span>
                        {node.multiFed ? (
                          <span
                            className="badge badge--suggestion"
                            title="Two or more incoming feeds: an alternate or parallel supply"
                          >
                            {count(node.fedByCount)} feeds in
                          </span>
                        ) : null}
                        {node.pmdInstruments.length === 0 ? null : (
                          <span
                            className="badge"
                            title={node.pmdInstruments.join(', ')}
                          >
                            {count(node.pmdInstruments.length)} instruments
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {nodes.length < nodeTotal ? (
            <button
              className="button button--small"
              type="button"
              onClick={(): void => {
                void loadWalk(selected, nodes.length);
              }}
            >
              Show {count(Math.min(PAGE_SIZE, nodeTotal - nodes.length))} more
            </button>
          ) : (
            <p className="muted">
              {count(nodeTotal)} nodes reached from this source.
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
