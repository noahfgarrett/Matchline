import { useCallback, type JSX } from 'react';

import type {
  WireNormalizationStep,
  WirePropertyCatalogRow,
  WireResolvedSample,
  WireRungUsage,
  WireSegmentName,
  WireSystemComponent,
  WireSystemConflict,
  WireSystemResolver,
} from '../../../shared/schemas';
import { call, count, percent } from '../api';
import { Field } from '../components/Field';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';
import { PropertyPicker } from '../components/PropertyPicker';
import { usePreview } from '../usePreview';

import type { WizardContext } from './Wizard';

/**
 * Screen 5 — System Resolver (PRODUCT.md §5, §7).
 *
 * Two ordered chains: one for the System Key, one for the description. The
 * first rung that yields a value supplies the answer, and every other rung's
 * claim is kept — which is why the preview reports what each rung *would* have
 * said, not just the winner. A rung that never wins but always disagrees is the
 * thing you want to find before publishing, not after.
 *
 * The key and the label stay separate (§5.1): rewording a description must
 * never move equipment across a boundary.
 */

/**
 * Short enough to read inside the select. Each rung renders a full sentence
 * underneath it, so the option itself only has to name the source.
 */
const COMPONENT_KINDS: ReadonlyArray<readonly [WireSystemComponent['kind'], string]> = [
  ['model-field', 'Model property'],
  ['tag-segment', 'Tag segment'],
  ['mel-lookup', 'MEL lookup'],
  ['direct-column', 'Imported column'],
  ['composite', 'Composite template'],
  ['manual', 'Manual assignment'],
];

const SEGMENT_NAMES: readonly WireSegmentName[] = ['role', 'system', 'unit', 'instance'];

const NORMALIZATION_KINDS: ReadonlyArray<readonly [WireNormalizationStep['kind'], string]> = [
  ['trim', 'Remove surrounding spaces'],
  ['uppercase', 'Force to upper case'],
  ['stripPrefix', 'Remove a known prefix'],
  ['padStart', 'Pad on the left to a fixed width'],
  ['alias', 'Rewrite one exact value as another'],
];

export function Screen5Resolver({ context }: { readonly context: WizardContext }): JSX.Element {
  const resolver = context.draft.systemResolver;
  const hasMel = context.sources.some((source): boolean => source.role === 'mel');
  const hasAnatomy = context.draft.tagAnatomy.segments.length > 0;

  const setResolver = useCallback(
    (patch: Partial<WireSystemResolver>): void => {
      void context.update((current) => ({
        systemResolver: { ...current.systemResolver, ...patch },
      }));
    },
    [context],
  );

  const preview = usePreview(
    JSON.stringify([
      resolver,
      context.draft.tagAnatomy,
      context.draft.propertyMappings,
      context.draft.assetFilters,
      context.sources.length,
    ]),
    async () => (await call(window.matchline.resolver.preview())).preview,
  );

  return (
    <div className="screen screen--split" data-testid="screen-5">
      <div className="screen__column">
        <header className="screen__header">
          <h1 className="screen__title">5. System Resolver</h1>
          <p className="screen__lede">
            Say where a system comes from at this site. Matchline tries each source in order
            and uses the first one that answers, keeping the rest so you can see when they
            disagree.
          </p>
        </header>

        <Panel
          title="System Key"
          description="The machine key. Boundaries and joins use this, so it must be stable."
        >
          <ChainEditor
            testId="key-chain"
            chain={resolver.keyChain}
            properties={context.properties}
            hasMel={hasMel}
            hasAnatomy={hasAnatomy}
            emptyHint="Nothing set. A tag segment is the usual first choice when tags carry the system."
            onChange={(keyChain): void => {
              setResolver({ keyChain: [...keyChain] });
            }}
          />
        </Panel>

        <Panel
          title="System description"
          description="The words that go with the key. Changing these must never move equipment."
        >
          <ChainEditor
            testId="description-chain"
            chain={resolver.descriptionChain}
            properties={context.properties}
            hasMel={hasMel}
            hasAnatomy={hasAnatomy}
            emptyHint="Optional. A MEL lookup by system key is the usual source."
            onChange={(descriptionChain): void => {
              setResolver({ descriptionChain: [...descriptionChain] });
            }}
          />
        </Panel>

        <Panel
          title="Normalization"
          description="Applied in order to every resolved value. Nothing here happens silently."
        >
          <Field
            label="Steps"
            what="Reconciles the same system written different ways across sources. Leading zeros are never added or removed unless you say so here."
            example="Pad to 3 with 0 turns the spreadsheet's 1 into the tag's 001"
          >
            <NormalizationEditor
              steps={resolver.normalization}
              onChange={(normalization): void => {
                setResolver({ normalization: [...normalization] });
              }}
            />
          </Field>
        </Panel>

        <Panel title="Label and conflicts">
          <Field
            label="System label template"
            what="How the system reads in the hierarchy. Leave blank for the standard: the key, then the description if there is one."
            example="{System Key} {System Description} gives 001 Mechanical Dry Air Handling"
            htmlFor="label-template"
          >
            <input
              id="label-template"
              className="control control--text"
              type="text"
              data-testid="label-template"
              placeholder="{System Key} {System Description}"
              value={resolver.labelTemplate}
              onChange={(event): void => {
                setResolver({ labelTemplate: event.target.value });
              }}
            />
          </Field>

          <Field
            label="When sources disagree"
            what="Review keeps every claim and raises an item for a person. Precedence lets the order above decide silently."
            example="Model says 002, tag says 001 → review raises one item"
            htmlFor="conflict-policy"
          >
            <select
              id="conflict-policy"
              className="control control--select"
              data-testid="conflict-policy"
              value={resolver.conflictPolicy}
              onChange={(event): void => {
                setResolver({
                  conflictPolicy: event.target.value === 'precedence' ? 'precedence' : 'review',
                });
              }}
            >
              <option value="review">Raise a review item</option>
              <option value="precedence">Let the order above decide</option>
            </select>
          </Field>
        </Panel>
      </div>

      <div className="screen__column screen__column--sticky">
        <Panel title="What this resolves">
          {preview.status === 'failed' ? <Callout tone="error">{preview.error}</Callout> : null}

          {preview.data === null ? (
            <Callout tone="info">Working it out…</Callout>
          ) : preview.data.state === 'blocked' ? (
            <Callout tone="info">{preview.data.reason}</Callout>
          ) : (
            <div data-testid="resolver-preview">
              <StatRow>
                <Stat
                  label="Assets with a system"
                  value={percent(preview.data.coverage)}
                  hint={`${count(preview.data.resolvedCount)} of ${count(preview.data.subjectCount)}`}
                />
                <Stat label="Distinct systems" value={count(preview.data.distinctSystemCount)} />
                <Stat
                  label="With a description"
                  value={count(preview.data.describedCount)}
                  hint={
                    preview.data.melRowCount === 0
                      ? 'no MEL loaded'
                      : `${count(preview.data.melRowCount)} MEL rows`
                  }
                />
                <Stat label="Conflicts" value={count(preview.data.conflictCount)} />
              </StatRow>

              <RungUsageTable
                title="Which source answered for the key"
                rungs={preview.data.rungUsage.filter((rung) => rung.chain === 'keyChain')}
                testId="rung-usage"
              />
              <RungUsageTable
                title="Which source answered for the description"
                rungs={preview.data.rungUsage.filter((rung) => rung.chain === 'descriptionChain')}
                testId="rung-usage-description"
              />

              <h3 className="panel__subtitle">Example labels</h3>
              <TableScroll>
                <table className="table table--compact" data-testid="resolver-samples">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Key</th>
                      <th>Label</th>
                      <th>From</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.samples.map((sample: WireResolvedSample): JSX.Element => (
                      <tr key={sample.assetId}>
                        <td>{sample.canonicalTag}</td>
                        <td>{sample.systemKey}</td>
                        <td>{sample.systemLabel}</td>
                        <td className="muted">{sample.keySource}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>

              {preview.data.conflicts.length === 0 ? null : (
                <>
                  <h3 className="panel__subtitle">Disagreements</h3>
                  <TableScroll>
                    <table className="table table--compact" data-testid="resolver-conflicts">
                      <thead>
                        <tr>
                          <th>Tag</th>
                          <th>Competing answers</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.data.conflicts.map((conflict: WireSystemConflict): JSX.Element => (
                          <tr key={conflict.assetId}>
                            <td>{conflict.canonicalTag}</td>
                            <td>
                              {conflict.claims
                                .map((claim): string => `${claim.value} (${claim.source})`)
                                .join(' vs ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                </>
              )}

              {preview.data.unresolvedExamples.length === 0 ? (
                <Callout tone="success">Every asset resolved to a system.</Callout>
              ) : (
                <Callout tone="warning">
                  No system for {count(preview.data.subjectCount - preview.data.resolvedCount)}{' '}
                  assets, including {preview.data.unresolvedExamples.join(', ')}.
                </Callout>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** One chain's rung tally. Split by chain so the source column keeps its width. */
function RungUsageTable({
  title,
  rungs,
  testId,
}: {
  readonly title: string;
  readonly rungs: readonly WireRungUsage[];
  readonly testId: string;
}): JSX.Element | null {
  if (rungs.length === 0) {
    return null;
  }
  return (
    <>
      <h3 className="panel__subtitle">{title}</h3>
      <TableScroll>
        <table className="table table--compact" data-testid={testId}>
          <thead>
            <tr>
              <th>Source</th>
              <th className="table__number">Used</th>
              <th className="table__number">Had a value</th>
              <th className="table__number">Blank</th>
            </tr>
          </thead>
          <tbody>
            {rungs.map((rung: WireRungUsage): JSX.Element => (
              <tr key={`${rung.chain}-${String(rung.rungIndex)}`}>
                <td>{rung.label}</td>
                <td className="table__number">{count(rung.wonCount)}</td>
                <td className="table__number">{count(rung.claimCount)}</td>
                <td className="table__number">{count(rung.skippedCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}

/* -------------------------------------------------------------- chain editor */

function defaultComponent(kind: WireSystemComponent['kind']): WireSystemComponent {
  switch (kind) {
    case 'model-field':
      return { kind, property: { category: '', name: 'UPN' } };
    case 'tag-segment':
      return { kind, segment: 'system' };
    case 'mel-lookup':
      return { kind, joinBy: 'systemKey', returnField: 'systemDescription' };
    case 'direct-column':
      return { kind, property: { category: '', name: 'System' } };
    case 'composite':
      return { kind, template: '{Area}-{SystemCode}' };
    case 'manual':
      return { kind };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled component kind: ${String(exhaustive)}`);
    }
  }
}

function ChainEditor({
  testId,
  chain,
  properties,
  hasMel,
  hasAnatomy,
  emptyHint,
  onChange,
}: {
  readonly testId: string;
  readonly chain: readonly WireSystemComponent[];
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly hasMel: boolean;
  readonly hasAnatomy: boolean;
  readonly emptyHint: string;
  readonly onChange: (chain: readonly WireSystemComponent[]) => void;
}): JSX.Element {
  const replace = (index: number, component: WireSystemComponent): void => {
    onChange(chain.map((entry, position): WireSystemComponent => (position === index ? component : entry)));
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= chain.length) {
      return;
    }
    const next = [...chain];
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) {
      return;
    }
    next[index] = displaced;
    next[target] = moved;
    onChange(next);
  };

  return (
    <div className="chain" data-testid={testId}>
      {chain.length === 0 ? <Callout tone="info">{emptyHint}</Callout> : null}

      <ol className="chain__list">
        {chain.map((component: WireSystemComponent, index: number): JSX.Element => (
          <li className="chain__item" key={`${component.kind}-${String(index)}`}>
            <div className="chain__head">
              <span className="chain__order">{index + 1}</span>
              <select
                className="control control--select"
                aria-label={`Source ${String(index + 1)}`}
                value={component.kind}
                onChange={(event): void => {
                  const kind = COMPONENT_KINDS.find(
                    ([value]): boolean => value === event.target.value,
                  )?.[0];
                  if (kind !== undefined) {
                    replace(index, defaultComponent(kind));
                  }
                }}
              >
                {COMPONENT_KINDS.map(([kind, label]): JSX.Element => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                className="button button--quiet button--small"
                type="button"
                aria-label="Move up"
                disabled={index === 0}
                onClick={(): void => {
                  move(index, -1);
                }}
              >
                ↑
              </button>
              <button
                className="button button--quiet button--small"
                type="button"
                aria-label="Move down"
                disabled={index === chain.length - 1}
                onClick={(): void => {
                  move(index, 1);
                }}
              >
                ↓
              </button>
              <button
                className="button button--quiet button--small"
                type="button"
                onClick={(): void => {
                  onChange(chain.filter((_entry, position): boolean => position !== index));
                }}
              >
                Remove
              </button>
            </div>

            <ComponentBody
              component={component}
              properties={properties}
              onChange={(next): void => {
                replace(index, next);
              }}
            />

            {component.kind === 'mel-lookup' && !hasMel ? (
              <Callout tone="warning">
                No master equipment list has been added on screen 1, so this rung will never
                answer.
              </Callout>
            ) : null}
            {component.kind === 'tag-segment' && !hasAnatomy ? (
              <Callout tone="warning">
                No tag anatomy taught on screen 4 yet, so this rung will never answer.
              </Callout>
            ) : null}
          </li>
        ))}
      </ol>

      <button
        className="button button--small"
        type="button"
        data-testid={`${testId}-add`}
        onClick={(): void => {
          onChange([...chain, defaultComponent('tag-segment')]);
        }}
      >
        Add a source
      </button>
    </div>
  );
}

function ComponentBody({
  component,
  properties,
  onChange,
}: {
  readonly component: WireSystemComponent;
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly onChange: (component: WireSystemComponent) => void;
}): JSX.Element | null {
  switch (component.kind) {
    case 'model-field':
    case 'direct-column':
      return (
        <div className="chain__body">
          <p className="chain__what">
            {component.kind === 'model-field'
              ? 'Reads the value straight off the model object.'
              : 'Reads one column you have labelled as the system.'}
          </p>
          <PropertyPicker
            id={`component-${component.kind}`}
            properties={properties}
            value={component.property}
            noneLabel="Choose a property"
            onChange={(ref): void => {
              onChange({ ...component, property: ref ?? { category: '', name: 'UPN' } });
            }}
          />
        </div>
      );

    case 'tag-segment':
      return (
        <div className="chain__body">
          <p className="chain__what">
            Uses the part of the tag you taught on screen 4. MAH001-10-01 gives 001 from the
            system segment.
          </p>
          <select
            className="control control--select"
            aria-label="Tag segment"
            value={component.segment}
            onChange={(event): void => {
              const segment = SEGMENT_NAMES.find(
                (name: WireSegmentName): boolean => name === event.target.value,
              );
              if (segment !== undefined) {
                onChange({ ...component, segment });
              }
            }}
          >
            {SEGMENT_NAMES.map((segment: WireSegmentName): JSX.Element => (
              <option key={segment} value={segment}>
                {segment}
              </option>
            ))}
          </select>
        </div>
      );

    case 'mel-lookup':
      return (
        <div className="chain__body chain__body--row">
          <p className="chain__what">
            Joins into the master equipment list. Join by tag when the MEL lists equipment;
            join by system key to fetch the description for a key another rung already found.
          </p>
          <label className="inline-field">
            <span>Join by</span>
            <select
              className="control control--select"
              value={component.joinBy}
              onChange={(event): void => {
                onChange({
                  ...component,
                  joinBy: event.target.value === 'equipmentTag' ? 'equipmentTag' : 'systemKey',
                });
              }}
            >
              <option value="equipmentTag">Equipment tag</option>
              <option value="systemKey">System key</option>
            </select>
          </label>
          <label className="inline-field">
            <span>Return</span>
            <select
              className="control control--select"
              value={component.returnField}
              onChange={(event): void => {
                onChange({
                  ...component,
                  returnField:
                    event.target.value === 'systemKey' ? 'systemKey' : 'systemDescription',
                });
              }}
            >
              <option value="systemKey">System key</option>
              <option value="systemDescription">System description</option>
            </select>
          </label>
        </div>
      );

    case 'composite':
      return (
        <div className="chain__body">
          <p className="chain__what">
            Joins other values together. Placeholders name model properties or tag segments.
          </p>
          <input
            className="control control--text"
            type="text"
            aria-label="Composite template"
            value={component.template}
            onChange={(event): void => {
              onChange({ ...component, template: event.target.value });
            }}
          />
        </div>
      );

    case 'manual':
      return (
        <p className="chain__what">
          Only answers where somebody has assigned a system to that asset by hand. Always the
          final word when it does.
        </p>
      );

    default: {
      const exhaustive: never = component;
      throw new Error(`Unhandled component: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/* ------------------------------------------------------- normalization steps */

function defaultStep(kind: WireNormalizationStep['kind']): WireNormalizationStep {
  switch (kind) {
    case 'trim':
    case 'uppercase':
      return { kind };
    case 'stripPrefix':
      return { kind, prefix: 'UPN-' };
    case 'padStart':
      return { kind, length: 3, fill: '0' };
    case 'alias':
      return { kind, from: '1', to: '001' };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled normalization kind: ${String(exhaustive)}`);
    }
  }
}

function NormalizationEditor({
  steps,
  onChange,
}: {
  readonly steps: readonly WireNormalizationStep[];
  readonly onChange: (steps: readonly WireNormalizationStep[]) => void;
}): JSX.Element {
  const replace = (index: number, step: WireNormalizationStep): void => {
    onChange(steps.map((entry, position): WireNormalizationStep => (position === index ? step : entry)));
  };

  return (
    <div className="normalization" data-testid="normalization">
      <ol className="chain__list">
        {steps.map((step: WireNormalizationStep, index: number): JSX.Element => (
          <li className="chain__item" key={`${step.kind}-${String(index)}`}>
            <div className="chain__head">
              <span className="chain__order">{index + 1}</span>
              <select
                className="control control--select"
                aria-label={`Step ${String(index + 1)}`}
                value={step.kind}
                onChange={(event): void => {
                  const kind = NORMALIZATION_KINDS.find(
                    ([value]): boolean => value === event.target.value,
                  )?.[0];
                  if (kind !== undefined) {
                    replace(index, defaultStep(kind));
                  }
                }}
              >
                {NORMALIZATION_KINDS.map(([kind, label]): JSX.Element => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                className="button button--quiet button--small"
                type="button"
                onClick={(): void => {
                  onChange(steps.filter((_entry, position): boolean => position !== index));
                }}
              >
                Remove
              </button>
            </div>

            {step.kind === 'stripPrefix' ? (
              <label className="inline-field">
                <span>Prefix</span>
                <input
                  className="control control--text"
                  type="text"
                  value={step.prefix}
                  onChange={(event): void => {
                    replace(index, { ...step, prefix: event.target.value });
                  }}
                />
              </label>
            ) : null}

            {step.kind === 'padStart' ? (
              <div className="chain__body chain__body--row">
                <label className="inline-field">
                  <span>Width</span>
                  <input
                    className="control control--number"
                    type="number"
                    min={1}
                    value={step.length}
                    onChange={(event): void => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      replace(index, {
                        ...step,
                        length: Number.isNaN(parsed) || parsed < 1 ? 1 : parsed,
                      });
                    }}
                  />
                </label>
                <label className="inline-field">
                  <span>Fill with</span>
                  <input
                    className="control control--text control--tiny"
                    type="text"
                    maxLength={1}
                    value={step.fill}
                    onChange={(event): void => {
                      replace(index, {
                        ...step,
                        fill: event.target.value === '' ? '0' : event.target.value,
                      });
                    }}
                  />
                </label>
              </div>
            ) : null}

            {step.kind === 'alias' ? (
              <div className="chain__body chain__body--row">
                <label className="inline-field">
                  <span>Rewrite</span>
                  <input
                    className="control control--text"
                    type="text"
                    value={step.from}
                    onChange={(event): void => {
                      replace(index, { ...step, from: event.target.value });
                    }}
                  />
                </label>
                <label className="inline-field">
                  <span>As</span>
                  <input
                    className="control control--text"
                    type="text"
                    value={step.to}
                    onChange={(event): void => {
                      replace(index, { ...step, to: event.target.value });
                    }}
                  />
                </label>
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <button
        className="button button--small"
        type="button"
        data-testid="normalization-add"
        onClick={(): void => {
          onChange([...steps, defaultStep('trim')]);
        }}
      >
        Add a step
      </button>
    </div>
  );
}
