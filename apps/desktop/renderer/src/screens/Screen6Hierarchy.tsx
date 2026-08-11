import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';

import type {
  WireDraftPatch,
  WireAttributeChoice,
  WireHierarchyLevel,
  WireMissingValuePolicy,
} from '../../../shared/schemas';
import { call, count, messageOf } from '../api';
import { Field } from '../components/Field';
import { Callout, Panel, TableScroll } from '../components/Panel';
import { SortableList } from '../components/Sortable';

import { DerivedAttributes } from './DerivedAttributes';
import { SourceAssignments } from './SourceAssignments';
import type { WizardContext } from './Wizard';

/**
 * Screen 6 — Hierarchy Composer (PRODUCT.md §2.4, §7, §11).
 *
 * Two decisions live on every level and they are not the same decision:
 *
 * - **What it groups by.** Cosmetic in the sense that changing it reshuffles
 *   the register and nothing else.
 * - **Whether it is a boundary.** Structural: equipment can never nest across a
 *   difference at a boundary level, and a cross-boundary parent is demoted to a
 *   dependency rather than kept (DECISIONS.md #1 — no feed-chain exception).
 *
 * The toggle is worded as the consequence rather than as the term, because
 * "boundary" is our word and "equipment can't nest across this" is the thing a
 * commissioning engineer is actually deciding.
 */

const MISSING_VALUE_LABELS: ReadonlyArray<readonly [WireMissingValuePolicy, string]> = [
  ['unassigned-group', 'Collect them under one visible (unassigned) group'],
  ['review', 'Refuse to place them and raise a review item'],
  ['provisional-root', 'Root them, and mark the decision as provisional'],
];

/** `Building` -> `building`. Level ids are stable and never shown to the user. */
function levelIdFor(attributeKey: string, taken: ReadonlySet<string>): string {
  const base = attributeKey
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const root = base === '' ? 'level' : base;
  if (!taken.has(root)) {
    return root;
  }
  let suffix = 2;
  while (taken.has(`${root}-${String(suffix)}`)) {
    suffix += 1;
  }
  return `${root}-${String(suffix)}`;
}

export function Screen6Hierarchy({ context }: { readonly context: WizardContext }): JSX.Element {
  const [attributes, setAttributes] = useState<readonly WireAttributeChoice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const levels = context.draft.hierarchy.levels;

  useEffect((): (() => void) => {
    let cancelled = false;
    void call(window.matchline.hierarchy.attributes()).then(
      (data): void => {
        if (!cancelled) {
          setAttributes(data.attributes);
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
  }, []);

  const setLevels = useCallback(
    (next: readonly WireHierarchyLevel[]): void => {
      void context.update((): WireDraftPatch => ({ hierarchy: { levels: [...next] } }));
    },
    [context],
  );

  const replace = useCallback(
    (index: number, level: WireHierarchyLevel): void => {
      setLevels(levels.map((entry, position) => (position === index ? level : entry)));
    },
    [levels, setLevels],
  );

  const used = new Set(levels.map((level) => level.attributeKey));
  const unused = attributes.filter((choice) => !used.has(choice.attributeKey));

  const addLevel = (choice: WireAttributeChoice): void => {
    const taken = new Set(levels.map((level) => level.levelId));
    setLevels([
      ...levels,
      {
        levelId: levelIdFor(choice.attributeKey, taken),
        displayName: choice.label,
        attributeKey: choice.attributeKey,
        // A new level is not a boundary until somebody says so: adding a
        // grouping should never silently break existing nesting.
        boundary: false,
        missingValuePolicy: 'unassigned-group',
        sort: choice.attributeKey === 'systemKey' ? 'key' : 'label',
      },
    ]);
  };

  const boundaryCount = levels.filter((level) => level.boundary).length;

  return (
    /* Two layouts on one screen, deliberately. The level stack is a narrow list
       beside a wide summary, which is what the split grid is for; the two
       registry editors are wide forms whose previews are tables of file names
       and counts, and squeezing them into half the width is what made the
       first pass unreadable. So the split is a block inside the screen rather
       than the screen itself. */
    <div className="screen screen--stacked" data-testid="screen-6">
      <header className="screen__header">
        <h1 className="screen__title">6. Hierarchy Composer</h1>
        <p className="screen__lede">
          The level stack the commissioning register is grouped by, outermost first. Drag to
          reorder. The boundary toggle on each level is the structural one — everything else
          here changes how the register reads, not what nests under what. Below the stack are
          the two things a level can group by that this site defines for itself: fields built
          out of your own evidence, and facts that are true of a whole model file.
        </p>
      </header>

      {error === null ? null : <Callout tone="error">{error}</Callout>}

      <div className="screen__split">
        <div className="screen__column">
        <Panel
          title="Levels"
          description="Outermost at the top. Equipment is filed by these values in order."
        >
          {levels.length === 0 ? (
            <Callout tone="warning">
              No levels. Every asset would sit in one flat list, and no boundary would stop
              anything nesting under anything. Add Building, SSM Discipline and System below
              for the standard commissioning stack.
            </Callout>
          ) : null}

          <SortableList
            items={levels}
            keyOf={(level: WireHierarchyLevel): string => level.levelId}
            ariaLabel="Hierarchy levels"
            testId="hierarchy-levels"
            onReorder={setLevels}
            renderItem={(level: WireHierarchyLevel, index: number, handle: ReactNode): ReactNode => (
              <LevelCard
                level={level}
                index={index}
                handle={handle}
                attributes={attributes}
                onChange={(next): void => {
                  replace(index, next);
                }}
                onRemove={(): void => {
                  setLevels(levels.filter((_entry, position) => position !== index));
                }}
              />
            )}
          />
        </Panel>

        <Panel
          title="Add a level"
          description="Every field the compiler can group by. A field with one distinct value makes a level with one group."
        >
          {unused.length === 0 ? (
            <Callout tone="info">Every available field is already a level.</Callout>
          ) : (
            <div className="chip-row" data-testid="attribute-choices">
              {unused.map((choice: WireAttributeChoice): JSX.Element => (
                <button
                  key={choice.attributeKey}
                  type="button"
                  className="chip"
                  data-testid={`add-level-${choice.attributeKey}`}
                  title={choice.what}
                  onClick={(): void => {
                    addLevel(choice);
                  }}
                >
                  <span className="chip__label">{choice.label}</span>
                  <span className="chip__hint">
                    {choice.distinctValueCount === null
                      ? choice.example
                      : `${count(choice.distinctValueCount)} values`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        </div>

      <div className="screen__column screen__column--sticky">
        <Panel title="What this stack does">
          <Field
            label="Grouping"
            what="Equipment is filed by each level's value in turn, outermost first."
            example={
              levels.length === 0
                ? 'No levels yet'
                : levels.map((level) => level.displayName).join(' / ')
            }
          >
            <p className="muted">
              {levels.length === 0
                ? 'Nothing is grouped.'
                : `${count(levels.length)} levels, ${count(boundaryCount)} of them structural.`}
            </p>
          </Field>

          <Field
            label="Boundaries"
            what="A difference at a boundary level breaks the structural parent. The relationship stays real — it becomes a dependency, and the physical chain stays whole in Electrical Flow."
            example="Panel in System 603 feeds a RIO in System 650 → the RIO is filed under 650 with the panel listed as a dependency"
          >
            {boundaryCount === 0 ? (
              <Callout tone="warning">
                No boundaries. Anything may nest under anything — a panel in one building could
                become the structural parent of equipment in another.
              </Callout>
            ) : (
              <TableScroll>
                <table className="table table--compact" data-testid="boundary-summary">
                  <thead>
                    <tr>
                      <th>Level</th>
                      <th>Grouped by</th>
                      <th>If not stated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {levels
                      .filter((level) => level.boundary)
                      .map((level: WireHierarchyLevel): JSX.Element => (
                        <tr key={level.levelId}>
                          <td>{level.displayName}</td>
                          <td className="muted">{level.attributeKey}</td>
                          <td className="muted">
                            {MISSING_VALUE_LABELS.find(
                              ([policy]) => policy === level.missingValuePolicy,
                            )?.[1] ?? level.missingValuePolicy}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Field>

          <Callout tone="info">
            The default stack is Building / SSM Discipline / System, with Building and System
            structural and SSM Discipline a grouping only. A startup family is a unit, its panel,
            its drive and its instrument — making discipline structural would cut that one family
            into four roots. Change it only when this site really does hand over differently.
          </Callout>
        </Panel>
      </div>
      </div>

      {/* The two registry sections a level can address. They live on this screen
          rather than one of their own because the only reason to define either
          is to group, label or bound by it, and that decision is directly
          above. */}
      <DerivedAttributes context={context} />
      <SourceAssignments context={context} />
    </div>
  );
}

function LevelCard({
  level,
  index,
  handle,
  attributes,
  onChange,
  onRemove,
}: {
  readonly level: WireHierarchyLevel;
  readonly index: number;
  readonly handle: ReactNode;
  readonly attributes: readonly WireAttributeChoice[];
  readonly onChange: (level: WireHierarchyLevel) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const choice = attributes.find((entry) => entry.attributeKey === level.attributeKey);

  return (
    <div className="level-card" data-testid={`level-${level.levelId}`}>
      <div className="level-card__head">
        {handle}
        <span className="chain__order">{index + 1}</span>
        <input
          className="control control--text"
          type="text"
          aria-label={`Level ${String(index + 1)} name`}
          data-testid={`level-name-${level.levelId}`}
          value={level.displayName}
          onChange={(event): void => {
            onChange({
              ...level,
              displayName: event.target.value === '' ? level.attributeKey : event.target.value,
            });
          }}
        />
        <button
          className="button button--quiet button--small"
          type="button"
          data-testid={`level-remove-${level.levelId}`}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>

      <div className="level-card__body">
        <label className="inline-field">
          <span>Grouped by</span>
          <select
            className="control control--select"
            data-testid={`level-attribute-${level.levelId}`}
            value={level.attributeKey}
            onChange={(event): void => {
              // The display and boundary attributes were chosen for the key
              // this level used to group by (P0-6) — "System Label beside
              // System Key". Carrying them onto a different key would label a
              // Building group with a system's words, so changing what the
              // level groups by drops them and the level collapses back to one
              // attribute doing all three jobs.
              onChange({
                levelId: level.levelId,
                displayName: level.displayName,
                attributeKey: event.target.value,
                boundary: level.boundary,
                missingValuePolicy: level.missingValuePolicy,
                sort: level.sort,
              });
            }}
          >
            {attributes.map((entry: WireAttributeChoice): JSX.Element => (
              <option key={entry.attributeKey} value={entry.attributeKey}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="inline-field">
          <span>Sibling order</span>
          <select
            className="control control--select"
            data-testid={`level-sort-${level.levelId}`}
            value={level.sort}
            onChange={(event): void => {
              onChange({ ...level, sort: event.target.value === 'key' ? 'key' : 'label' });
            }}
          >
            <option value="label">By the words</option>
            <option value="key">By the raw key</option>
          </select>
        </label>
      </div>

      <label className="toggle" data-testid={`level-boundary-${level.levelId}`}>
        <input
          type="checkbox"
          checked={level.boundary}
          onChange={(event): void => {
            onChange({ ...level, boundary: event.target.checked });
          }}
        />
        <span>
          Equipment can’t structurally nest across different values of this
          <span className="toggle__what">
            {level.boundary
              ? 'On. A parent on the other side of this level is removed from the chain and listed as a dependency instead.'
              : 'Off. Equipment may nest across this level freely.'}
          </span>
        </span>
      </label>

      {/* P0-6: three questions, three fields. Collapsed by default, because a
          level whose words and comparison are its key is the ordinary case and
          two extra selects on every card would make it look like a decision
          everybody has to make. */}
      <details
        className="level-card__advanced"
        data-testid={`level-advanced-${level.levelId}`}
        open={level.displayAttributeKey !== undefined || level.boundaryAttributeKey !== undefined}
      >
        <summary>
          Label and comparison
          {level.displayAttributeKey === undefined && level.boundaryAttributeKey === undefined
            ? ' — both follow the grouping key'
            : ' — set separately'}
        </summary>

        <label className="inline-field inline-field--wide">
          <span>Labelled by</span>
          <select
            className="control control--select"
            data-testid={`level-display-${level.levelId}`}
            value={level.displayAttributeKey ?? ''}
            onChange={(event): void => {
              const { displayAttributeKey: _dropped, ...rest } = level;
              onChange(
                event.target.value === ''
                  ? rest
                  : { ...rest, displayAttributeKey: event.target.value },
              );
            }}
          >
            <option value="">The grouping key itself</option>
            {attributes.map((entry: WireAttributeChoice): JSX.Element => (
              <option key={entry.attributeKey} value={entry.attributeKey}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <p className="level-card__what">
          Only words. Re-typing a description or a system’s name never moves equipment — the
          grouping key above is what decides where something is filed.
        </p>

        <label className="inline-field inline-field--wide">
          <span>Boundary compares</span>
          <select
            className="control control--select"
            data-testid={`level-boundary-attribute-${level.levelId}`}
            disabled={!level.boundary}
            value={level.boundaryAttributeKey ?? ''}
            onChange={(event): void => {
              const { boundaryAttributeKey: _dropped, ...rest } = level;
              onChange(
                event.target.value === ''
                  ? rest
                  : { ...rest, boundaryAttributeKey: event.target.value },
              );
            }}
          >
            <option value="">The grouping key itself</option>
            {attributes.map((entry: WireAttributeChoice): JSX.Element => (
              <option key={entry.attributeKey} value={entry.attributeKey}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <p className="level-card__what">
          {level.boundary
            ? 'What the boundary check reads on both sides of a proposed parent. Leave it on the grouping key unless this site’s structural rule really is a different field.'
            : 'This level is not a boundary, so nothing is compared here.'}
        </p>
      </details>

      <label className="inline-field inline-field--wide">
        <span>When an asset has no value here</span>
        <select
          className="control control--select"
          data-testid={`level-missing-${level.levelId}`}
          value={level.missingValuePolicy}
          onChange={(event): void => {
            const policy = MISSING_VALUE_LABELS.find(
              ([value]) => value === event.target.value,
            )?.[0];
            if (policy !== undefined) {
              onChange({ ...level, missingValuePolicy: policy });
            }
          }}
        >
          {MISSING_VALUE_LABELS.map(([policy, label]): JSX.Element => (
            <option key={policy} value={policy}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <p className="level-card__what">
        {choice === undefined
          ? 'This field is not one the compiler populates, so this level will group nothing.'
          : `${choice.what} Example: ${choice.example}.`}
      </p>
    </div>
  );
}
