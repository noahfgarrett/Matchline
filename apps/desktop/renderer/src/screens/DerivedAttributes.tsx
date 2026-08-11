import { useCallback, useState, type JSX } from 'react';

import type {
  WireAttributeResolver,
  WireDerivedAttribute,
  WireDerivedRungUsage,
  WireDerivedSample,
  WireDraftPatch,
  WirePropertyCatalogRow,
  WireSegmentName,
} from '../../../shared/schemas';
import { call, count, percent } from '../api';
import { Field } from '../components/Field';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';
import { PropertyRefChain } from '../components/PropertyChainEditor';
import { usePreview } from '../usePreview';

import type { WizardContext } from './Wizard';

/**
 * Screen 6 — the derived-attribute registry (P0-7, hard gate 7).
 *
 * A hierarchy level names the field it groups by as a plain string, and until
 * this editor existed the only strings that meant anything were the compiler's
 * built-ins. P0-7 lets a site define its own — "Area", "Turnover Package",
 * "Owner" — out of evidence it already has, and then group, label or bound on
 * them exactly like a built-in. The registry has travelled in the profile and
 * been honoured by the compiler since M4b; what was missing was any way to
 * write one down.
 *
 * Three rules govern a definition, they are the engine's, and the screen states
 * all three rather than hiding them:
 *
 * 1. **First source wins.** The chain is ordered; the first one that answers
 *    supplies the value. The preview reports which one actually did.
 * 2. **Missing stays missing.** A chain nothing answered leaves the attribute
 *    off the asset. There is no default, ever — which is why the preview leads
 *    with coverage rather than burying it.
 * 3. **Display never decides.** Renaming a field moves nothing; the attribute
 *    id is the identity, and it is the thing a level addresses.
 *
 * One definition is edited at a time. A registry-wide form with six open
 * editors would preview six things at once over the whole asset universe, and
 * the preview is the point.
 */

const RESOLVER_KINDS: ReadonlyArray<readonly [WireAttributeResolver['kind'], string]> = [
  ['model-property', 'A model property'],
  ['tag-segment', 'A segment of the tag'],
  ['source-assignment', 'A value assigned to the whole file'],
  ['system-field', 'Whatever the System Resolver settled on'],
  ['composite', 'Assembled from a template'],
  ['mel-lookup', 'Looked up in the master equipment list'],
  ['manual', 'Assigned by hand, per asset'],
];

const SEGMENT_NAMES: readonly WireSegmentName[] = ['role', 'system', 'unit', 'instance'];

/** `Turnover Package` -> `turnover-package`. The id a level addresses. */
function slugifyAttributeId(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A blank rung of the chosen kind. Never invents an address or a template. */
function defaultResolver(kind: WireAttributeResolver['kind']): WireAttributeResolver {
  switch (kind) {
    case 'model-property':
      return { kind, chain: [] };
    case 'tag-segment':
      return { kind, segment: 'unit' };
    case 'source-assignment':
      return { kind, key: '' };
    case 'system-field':
      return { kind, field: 'systemKey' };
    case 'composite':
      return { kind, template: '{segment:system}-{segment:unit}' };
    case 'mel-lookup':
      return { kind, joinBy: 'equipmentTag', returnField: '' };
    case 'manual':
      return { kind, assignments: [] };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled resolver kind: ${String(exhaustive)}`);
    }
  }
}

/** The registry, the editor and the live preview. */
export function DerivedAttributes({
  context,
}: {
  readonly context: WizardContext;
}): JSX.Element {
  const definitions = context.draft.derivedAttributes;
  const [editing, setEditing] = useState<WireDerivedAttribute | null>(null);
  /** The id being replaced, or `''` when the editor is creating a new field. */
  const [replacing, setReplacing] = useState<string>('');
  const [problem, setProblem] = useState<string>('');

  const write = useCallback(
    (next: readonly WireDerivedAttribute[]): void => {
      void context.update((): WireDraftPatch => ({ derivedAttributes: [...next] }));
    },
    [context],
  );

  const save = (): void => {
    if (editing === null) {
      return;
    }
    const attributeId = editing.attributeId.trim();
    if (editing.displayName.trim() === '') {
      setProblem('Give the field a name — it is what the Composer lists it under.');
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(attributeId)) {
      setProblem(
        'The id must be lower-case words joined by hyphens, like turnover-package. It is what a ' +
          'hierarchy level addresses, so it cannot contain spaces or capitals.',
      );
      return;
    }
    if (definitions.some((entry) => entry.attributeId === attributeId && entry.attributeId !== replacing)) {
      setProblem(`Another field already uses the id ${attributeId}.`);
      return;
    }
    if (editing.resolverChain.length === 0) {
      setProblem('Add at least one source, or this field will never have a value.');
      return;
    }

    const saved: WireDerivedAttribute = { ...editing, attributeId };
    write(
      replacing === ''
        ? [...definitions, saved]
        : definitions.map((entry) => (entry.attributeId === replacing ? saved : entry)),
    );
    setEditing(null);
    setReplacing('');
    setProblem('');
  };

  return (
    <Panel
      title="Fields this site defines"
      description="Attributes built out of evidence you already have. Once defined, a level can group, label or bound on one exactly like a built-in field."
      actions={
        editing === null ? (
          <button
            className="button button--small"
            type="button"
            data-testid="derived-add"
            onClick={(): void => {
              setEditing({ attributeId: '', displayName: '', resolverChain: [] });
              setReplacing('');
              setProblem('');
            }}
          >
            Define a field
          </button>
        ) : undefined
      }
    >
      {definitions.length === 0 && editing === null ? (
        <Callout tone="info">
          None defined. Levels group by the built-in fields — building, discipline, system and the
          rest. Define one when this site files equipment by something the built-ins do not carry,
          like an area or a turnover package.
        </Callout>
      ) : null}

      {definitions.length === 0 ? null : (
        <TableScroll>
          <table className="table table--compact" data-testid="derived-list">
            <thead>
              <tr>
                <th>Field</th>
                <th>Id a level uses</th>
                <th>Where the value comes from</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {definitions.map((definition: WireDerivedAttribute): JSX.Element => (
                <tr key={definition.attributeId} data-testid={`derived-row-${definition.attributeId}`}>
                  <td>{definition.displayName}</td>
                  <td className="muted">{definition.attributeId}</td>
                  <td className="muted">
                    {definition.resolverChain
                      .map((rung) => RESOLVER_KINDS.find(([kind]) => kind === rung.kind)?.[1] ?? rung.kind)
                      .join(', then ')}
                  </td>
                  <td className="table__number">
                    <button
                      className="button button--quiet button--small"
                      type="button"
                      data-testid={`derived-edit-${definition.attributeId}`}
                      onClick={(): void => {
                        setEditing({
                          ...definition,
                          resolverChain: [...definition.resolverChain],
                        });
                        setReplacing(definition.attributeId);
                        setProblem('');
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="button button--quiet button--small"
                      type="button"
                      data-testid={`derived-remove-${definition.attributeId}`}
                      onClick={(): void => {
                        write(
                          definitions.filter(
                            (entry) => entry.attributeId !== definition.attributeId,
                          ),
                        );
                        if (replacing === definition.attributeId) {
                          setEditing(null);
                          setReplacing('');
                        }
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

      {editing === null ? null : (
        <div className="editor-card" data-testid="derived-editor">
          <Field
            label="Field name"
            what="What a person reads in the Hierarchy Composer and in the register. Renaming it moves nothing."
            example="Turnover Package"
            htmlFor="derived-name"
          >
            <input
              id="derived-name"
              className="control control--text"
              type="text"
              data-testid="derived-name"
              value={editing.displayName}
              onChange={(event): void => {
                const displayName = event.target.value;
                setEditing({
                  ...editing,
                  displayName,
                  // The id follows the name until the id has been typed into
                  // directly: a person naming a field should not have to invent
                  // a second spelling of it, and one that HAS been chosen must
                  // never be silently rewritten — a level addresses it.
                  attributeId:
                    replacing === '' && editing.attributeId === slugifyAttributeId(editing.displayName)
                      ? slugifyAttributeId(displayName)
                      : editing.attributeId,
                });
              }}
            />
          </Field>

          <Field
            label="Id a level uses"
            what="The stable name a hierarchy level addresses this field by. Lower case, hyphenated. Changing it on a published profile changes what every level naming it groups by."
            example="turnover-package"
            htmlFor="derived-id"
          >
            <input
              id="derived-id"
              className="control control--text"
              type="text"
              data-testid="derived-id"
              value={editing.attributeId}
              onChange={(event): void => {
                setEditing({ ...editing, attributeId: event.target.value });
              }}
            />
          </Field>

          <Field
            label="Where the value comes from"
            what="Tried top to bottom. The first source that answers with a value supplies it, and the rest are not consulted. Nothing that answers nowhere gets a default."
            example="The model's Package property, and where that is blank, the unit segment of the tag"
          >
            <ResolverChainEditor
              chain={editing.resolverChain}
              properties={context.properties}
              assignmentKeys={assignmentKeysOf(context)}
              hasMel={context.sources.some((source) => source.role === 'mel')}
              hasAnatomy={context.draft.tagAnatomy.segments.length > 0}
              onChange={(resolverChain): void => {
                setEditing({ ...editing, resolverChain: [...resolverChain] });
              }}
            />
          </Field>

          {problem === '' ? null : <Callout tone="error">{problem}</Callout>}

          <DerivedPreview definition={editing} />

          <div className="button-row">
            <button
              className="button button--primary button--small"
              type="button"
              data-testid="derived-save"
              onClick={save}
            >
              {replacing === '' ? 'Add this field' : 'Save changes'}
            </button>
            <button
              className="button button--quiet button--small"
              type="button"
              data-testid="derived-cancel"
              onClick={(): void => {
                setEditing(null);
                setReplacing('');
                setProblem('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Every custom key the site's assignment rules actually set, for the datalist. */
function assignmentKeysOf(context: WizardContext): readonly string[] {
  const keys = new Set<string>();
  for (const rule of context.draft.sourceAssignments) {
    for (const entry of rule.assign.custom) {
      keys.add(entry.key);
    }
  }
  return [...keys].sort();
}

/* ------------------------------------------------------------ live preview */

/**
 * The definition being edited, run over the real assets.
 *
 * Keyed on the definition rather than on a save, because the question a person
 * is answering while they type is "does this find anything?" — and the honest
 * answer to a half-typed chain is a coverage of zero, shown, rather than a
 * blank panel.
 */
function DerivedPreview({
  definition,
}: {
  readonly definition: WireDerivedAttribute;
}): JSX.Element {
  const preview = usePreview(
    JSON.stringify(definition.resolverChain),
    async () => (await call(window.matchline.derived.preview({ definition }))).preview,
  );

  if (preview.status === 'failed') {
    return <Callout tone="error">{preview.error}</Callout>;
  }
  if (preview.data === null) {
    return <Callout tone="info">Working it out…</Callout>;
  }
  if (preview.data.state === 'blocked') {
    return <Callout tone="info">{preview.data.reason}</Callout>;
  }

  const data = preview.data;
  return (
    <div className="preview-block" data-testid="derived-preview">
      <StatRow>
        <Stat
          label="Assets with a value"
          value={percent(data.coverage)}
          hint={`${count(data.resolvedCount)} of ${count(data.assetCount)}`}
        />
        <Stat label="Distinct values" value={count(data.distinctValueCount)} />
        <Stat
          label="Assets with none"
          value={count(data.assetCount - data.resolvedCount)}
          hint="they simply have no value for this field"
        />
      </StatRow>

      <TableScroll>
        <table className="table table--compact" data-testid="derived-rung-usage">
          <thead>
            <tr>
              <th>Source</th>
              <th className="table__number">Answered</th>
              <th className="table__number">Could have</th>
            </tr>
          </thead>
          <tbody>
            {data.rungUsage.map((rung: WireDerivedRungUsage): JSX.Element => (
              <tr key={rung.rungIndex}>
                <td>{rung.label}</td>
                <td className="table__number">{count(rung.wonCount)}</td>
                <td className="table__number">{count(rung.claimCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      {data.samples.length === 0 ? null : (
        <TableScroll>
          <table className="table table--compact" data-testid="derived-samples">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Value</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {data.samples.map((sample: WireDerivedSample): JSX.Element => (
                <tr key={sample.assetId}>
                  <td>{sample.canonicalTag === '' ? <span className="muted">untagged</span> : sample.canonicalTag}</td>
                  <td>{sample.value}</td>
                  <td className="muted">{sample.from}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {data.unresolvedExamples.length === 0 ? (
        <Callout tone="success">Every asset has a value for this field.</Callout>
      ) : (
        <Callout tone="warning">
          No value for {count(data.assetCount - data.resolvedCount)} assets, including{' '}
          {data.unresolvedExamples.join(', ')}. They stay without one — Matchline never invents a
          value, and a level bounding on this field will not nest them across it.
        </Callout>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- chain editor */

function ResolverChainEditor({
  chain,
  properties,
  assignmentKeys,
  hasMel,
  hasAnatomy,
  onChange,
}: {
  readonly chain: readonly WireAttributeResolver[];
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly assignmentKeys: readonly string[];
  readonly hasMel: boolean;
  readonly hasAnatomy: boolean;
  readonly onChange: (chain: readonly WireAttributeResolver[]) => void;
}): JSX.Element {
  const replace = (index: number, resolver: WireAttributeResolver): void => {
    onChange(chain.map((entry, position) => (position === index ? resolver : entry)));
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    const moved = chain[index];
    const displaced = chain[target];
    if (moved === undefined || displaced === undefined) {
      return;
    }
    const next = [...chain];
    next[index] = displaced;
    next[target] = moved;
    onChange(next);
  };

  return (
    <div className="chain" data-testid="derived-chain">
      {chain.length === 0 ? (
        <Callout tone="info">
          Nothing yet. Add a source below — a model property is the usual first choice.
        </Callout>
      ) : null}

      <ol className="chain__list">
        {chain.map((resolver: WireAttributeResolver, index: number): JSX.Element => (
          <li className="chain__item" key={`${resolver.kind}-${String(index)}`}>
            <div className="chain__head">
              <span className="chain__order">{index + 1}</span>
              <select
                className="control control--select"
                aria-label={`Source ${String(index + 1)}`}
                data-testid={`derived-rung-kind-${String(index)}`}
                value={resolver.kind}
                onChange={(event): void => {
                  const kind = RESOLVER_KINDS.find(([value]) => value === event.target.value)?.[0];
                  if (kind !== undefined) {
                    replace(index, defaultResolver(kind));
                  }
                }}
              >
                {RESOLVER_KINDS.map(([kind, label]): JSX.Element => (
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
                data-testid={`derived-rung-remove-${String(index)}`}
                onClick={(): void => {
                  onChange(chain.filter((_entry, position) => position !== index));
                }}
              >
                Remove
              </button>
            </div>

            <ResolverBody
              index={index}
              resolver={resolver}
              properties={properties}
              assignmentKeys={assignmentKeys}
              onChange={(next): void => {
                replace(index, next);
              }}
            />

            {resolver.kind === 'mel-lookup' && !hasMel ? (
              <Callout tone="warning">
                No master equipment list has been added on screen 1, so this source will never
                answer.
              </Callout>
            ) : null}
            {(resolver.kind === 'tag-segment' || resolver.kind === 'composite') && !hasAnatomy ? (
              <Callout tone="warning">
                No tag anatomy has been taught on screen 4 yet, so this source will never answer.
              </Callout>
            ) : null}
          </li>
        ))}
      </ol>

      <button
        className="button button--small"
        type="button"
        data-testid="derived-chain-add"
        onClick={(): void => {
          onChange([...chain, defaultResolver('model-property')]);
        }}
      >
        Add a source
      </button>
    </div>
  );
}

/** The per-kind form. Each one asks for exactly what its rung needs. */
function ResolverBody({
  index,
  resolver,
  properties,
  assignmentKeys,
  onChange,
}: {
  readonly index: number;
  readonly resolver: WireAttributeResolver;
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly assignmentKeys: readonly string[];
  readonly onChange: (resolver: WireAttributeResolver) => void;
}): JSX.Element {
  switch (resolver.kind) {
    case 'model-property':
      return (
        <div className="chain__body">
          <p className="chain__what">
            Reads the value off the model object. More than one address is a fallback list: the
            first that is not blank wins.
          </p>
          <PropertyRefChain
            idPrefix={`derived-rung-${String(index)}`}
            label={`Source ${String(index + 1)}`}
            chain={resolver.chain}
            properties={properties}
            noneLabel="Choose a property"
            onChange={(chain): void => {
              onChange({ ...resolver, chain: [...chain] });
            }}
          />
        </div>
      );

    case 'tag-segment':
      return (
        <div className="chain__body chain__body--row">
          <p className="chain__what">
            Takes one of the segments the tag anatomy on screen 4 teaches.
          </p>
          <select
            className="control control--select"
            aria-label={`Segment for source ${String(index + 1)}`}
            data-testid={`derived-rung-segment-${String(index)}`}
            value={resolver.segment}
            onChange={(event): void => {
              onChange({ ...resolver, segment: event.target.value as WireSegmentName });
            }}
          >
            {SEGMENT_NAMES.map((segment): JSX.Element => (
              <option key={segment} value={segment}>
                {segment}
              </option>
            ))}
          </select>
        </div>
      );

    case 'source-assignment':
      return (
        <div className="chain__body">
          <p className="chain__what">
            Reads a value one of the source-assignment rules below sets on a whole file. Use the
            same key the rule assigns — they are matched exactly.
          </p>
          <input
            className="control control--text"
            type="text"
            placeholder="e.g. turnover-package"
            aria-label={`Assigned key for source ${String(index + 1)}`}
            data-testid={`derived-rung-key-${String(index)}`}
            list={`assignment-keys-${String(index)}`}
            value={resolver.key}
            onChange={(event): void => {
              onChange({ ...resolver, key: event.target.value });
            }}
          />
          <datalist id={`assignment-keys-${String(index)}`}>
            {assignmentKeys.map((key): JSX.Element => (
              <option key={key} value={key} />
            ))}
          </datalist>
          {assignmentKeys.length === 0 ? (
            <Callout tone="warning">
              No rule below assigns a custom key yet, so this source will never answer.
            </Callout>
          ) : null}
        </div>
      );

    case 'system-field':
      return (
        <div className="chain__body chain__body--row">
          <p className="chain__what">
            Takes whatever the System Resolver on screen 5 settled on for this asset.
          </p>
          <select
            className="control control--select"
            aria-label={`System field for source ${String(index + 1)}`}
            data-testid={`derived-rung-field-${String(index)}`}
            value={resolver.field}
            onChange={(event): void => {
              const field = event.target.value;
              onChange({
                ...resolver,
                field:
                  field === 'systemDescription'
                    ? 'systemDescription'
                    : field === 'systemLabel'
                      ? 'systemLabel'
                      : 'systemKey',
              });
            }}
          >
            <option value="systemKey">The system key</option>
            <option value="systemDescription">The system description</option>
            <option value="systemLabel">The system label</option>
          </select>
        </div>
      );

    case 'composite':
      return (
        <div className="chain__body">
          <p className="chain__what">
            Builds the value out of pieces. <code>{'{segment:role}'}</code>,{' '}
            <code>{'{segment:system}'}</code>, <code>{'{segment:unit}'}</code> and{' '}
            <code>{'{segment:instance}'}</code> take parts of the tag;{' '}
            <code>{'{prop:Category.Name}'}</code> takes a model property. Anything else is
            literal. If any placeholder is blank the whole template says nothing — a half-built
            value is worse than none.
          </p>
          <input
            className="control control--text"
            type="text"
            placeholder="{segment:system}-{segment:unit}"
            aria-label={`Template for source ${String(index + 1)}`}
            data-testid={`derived-rung-template-${String(index)}`}
            value={resolver.template}
            onChange={(event): void => {
              onChange({ ...resolver, template: event.target.value });
            }}
          />
        </div>
      );

    case 'mel-lookup':
      return (
        <div className="chain__body">
          <p className="chain__what">
            Joins the asset's tag to the master equipment list and takes one of its columns, named
            as the project mapped it on screen 1.
          </p>
          <input
            className="control control--text"
            type="text"
            placeholder="e.g. projectPhase"
            aria-label={`MEL column for source ${String(index + 1)}`}
            data-testid={`derived-rung-return-${String(index)}`}
            value={resolver.returnField}
            onChange={(event): void => {
              onChange({ ...resolver, returnField: event.target.value });
            }}
          />
        </div>
      );

    case 'manual':
      return (
        <div className="chain__body">
          <p className="chain__what">
            A table of values kept per asset. Matchline has no per-asset editor for this yet: the
            rows travel in the profile and the compiler honours them, so a profile that already
            carries some keeps them and they answer here — but nothing in this build can add one.
            Use a model property or a source assignment instead unless you are importing a profile
            that already has this table.
          </p>
          <p className="muted" data-testid={`derived-rung-manual-${String(index)}`}>
            {resolver.assignments.length === 0
              ? 'No hand-assigned rows.'
              : `${String(resolver.assignments.length)} hand-assigned rows, carried unchanged.`}
          </p>
        </div>
      );

    default: {
      const exhaustive: never = resolver;
      throw new Error(`Unhandled resolver: ${JSON.stringify(exhaustive)}`);
    }
  }
}
