import { useCallback, useState, type JSX } from 'react';

import type {
  WireAssetFilters,
  WireClassCount,
  WireDraftPatch,
  WireFilterStage,
  WireMappedProperty,
  WirePropertyCatalogRow,
  WirePropertyMappings,
  WireSampleAsset,
  WireSelectionSetSummary,
  WireSourceImpact,
  WireTagPatternPreview,
} from '../../../shared/schemas';
import { call, count, percent } from '../api';
import { Field } from '../components/Field';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';
import { PropertyChainEditor, type ChainSource } from '../components/PropertyChainEditor';
import { PropertyPicker } from '../components/PropertyPicker';
import { usePreview } from '../usePreview';

import type { WizardContext } from './Wizard';

/**
 * Screen 3 — Asset definition (PRODUCT.md §6.6, §7).
 *
 * The whole screen is one question: of the objects in the model, which ones are
 * commissionable equipment? Every control below narrows that, and the inclusion
 * impact on the right recomputes over the real cache each time — §6.6's "it must
 * show the inclusion impact before saving", made continuous.
 */

export function Screen3Assets({ context }: { readonly context: WizardContext }): JSX.Element {
  const { draft, properties, classes } = context;
  const mappings = draft.propertyMappings;
  const filters = draft.assetFilters;

  // Every write reads the draft main currently holds, not the one this render
  // captured: two picks in a row must not undo each other (see WizardContext).
  const setMapping = useCallback(
    (key: keyof WirePropertyMappings, mapping: WireMappedProperty): void => {
      void context.update((current) => ({
        propertyMappings: { ...current.propertyMappings, [key]: mapping },
      }));
    },
    [context],
  );

  /** The model sources a per-source override can name. Never file names (P0-1). */
  const chainSources: readonly ChainSource[] = (context.universe?.sources ?? []).map(
    (source): ChainSource => ({
      sourceId: source.sourceId,
      displayName: source.displayName,
    }),
  );

  const setFilters = useCallback(
    (patch: Partial<WireAssetFilters>): void => {
      void context.update((current) => ({
        assetFilters: { ...current.assetFilters, ...patch },
      }));
    },
    [context],
  );

  const toggleClass = useCallback(
    (list: 'includedClasses' | 'excludedClasses' | 'separatelyCommissionableClasses', className: string): void => {
      void context.update((current) => {
        const currentList = current.assetFilters[list];
        const next = currentList.includes(className)
          ? currentList.filter((entry: string): boolean => entry !== className)
          : [...currentList, className].sort();
        return { assetFilters: { ...current.assetFilters, [list]: next } };
      });
    },
    [context],
  );

  const toggleSelectionSet = useCallback(
    (name: string): void => {
      void context.update((current) => {
        const chosen = current.assetFilters.selectionSetNames;
        const next = chosen.includes(name)
          ? chosen.filter((entry: string): boolean => entry !== name)
          : [...chosen, name].sort();
        return { assetFilters: { ...current.assetFilters, selectionSetNames: next } };
      });
    },
    [context],
  );

  const addTagPattern = useCallback(
    (pattern: string): void => {
      void context.update((current) => {
        const patterns = current.assetFilters.acceptedTagPatterns;
        // A pattern already on the list is not added twice: the engine ORs them,
        // so a duplicate changes nothing except the count beside it.
        return patterns.includes(pattern)
          ? {}
          : {
              assetFilters: {
                ...current.assetFilters,
                acceptedTagPatterns: [...patterns, pattern],
              },
            };
      });
    },
    [context],
  );

  const removeTagPattern = useCallback(
    (pattern: string): void => {
      void context.update((current) => ({
        assetFilters: {
          ...current.assetFilters,
          acceptedTagPatterns: current.assetFilters.acceptedTagPatterns.filter(
            (entry: string): boolean => entry !== pattern,
          ),
        },
      }));
    },
    [context],
  );

  // Only the universe: the sets a model carries are a fact about the extraction,
  // not about anything on this screen.
  const selectionSets = usePreview(
    JSON.stringify(context.universe?.sources.map((source) => source.sourceId) ?? []),
    async () => (await call(window.matchline.model.selectionSets())).sets,
  );

  const tagPatterns = usePreview(
    JSON.stringify([mappings, filters, context.universe?.sources.length ?? 0]),
    async () => (await call(window.matchline.asset.tagPatterns())).preview,
  );

  // The universe is part of the key: adding or replacing a model source
  // changes the impact even when nothing on this screen was touched.
  const preview = usePreview(
    JSON.stringify([
      mappings,
      filters,
      context.universe?.sources.map((source) => source.sourceId) ?? [],
    ]),
    async () => (await call(window.matchline.asset.preview())).preview,
  );

  return (
    <div className="screen screen--split" data-testid="screen-3">
      <div className="screen__column">
        <header className="screen__header">
          <h1 className="screen__title">3. Asset definition</h1>
          <p className="screen__lede">
            Tell Matchline which model objects are commissionable equipment, and which
            property carries each field. Every change re-runs against the whole model — the
            numbers on the right are the real answer, not an estimate.
          </p>
        </header>

        <Panel
          title="Which property is which"
          description="Each field is a list, tried top to bottom. One address is the ordinary case; add a second when a different model keeps the same fact somewhere else."
        >
          <MappingField
            label="Equipment tag"
            what="The property Matchline reads the equipment tag from. This is the identity of every asset — nothing else can stand in for it. If the first address is blank on an object, the next one is tried."
            example="Dragon Data > Tag holding MAH001-10-01, falling back to Item > Name"
            field="equipmentTag"
            noneLabel="Not chosen yet"
            mappings={mappings}
            properties={properties}
            sources={chainSources}
            onChange={setMapping}
          />

          <MappingField
            label="Description"
            what="Free text shown next to the tag in the register and in the generated MEL."
            example="Primary dry air handling unit"
            field="description"
            noneLabel="Not mapped"
            mappings={mappings}
            properties={properties}
            sources={chainSources}
            onChange={setMapping}
          />

          <MappingField
            label="Equipment type"
            what="What kind of thing this is. Used for grouping and for the role rules later on."
            example="Air Handler"
            field="equipmentType"
            noneLabel="Not mapped"
            mappings={mappings}
            properties={properties}
            sources={chainSources}
            onChange={setMapping}
          />

          <MappingField
            label="Building"
            what="Which building the asset sits in. Becomes the top level of the hierarchy."
            example="B14"
            field="building"
            noneLabel="Not mapped"
            mappings={mappings}
            properties={properties}
            sources={chainSources}
            onChange={setMapping}
          />

          <MappingField
            label="Discipline"
            what="The discipline as the model authors wrote it. Matchline maps it to an SSM discipline later; it never overwrites what the model said."
            example="Mechanical"
            field="nativeDiscipline"
            noneLabel="Not mapped"
            mappings={mappings}
            properties={properties}
            sources={chainSources}
            onChange={setMapping}
          />
        </Panel>

        <Panel
          title="Register fields the model already knows"
          description="Leave these unmapped and Matchline learns them from a prior registry. Map one and the model wins: a value the model states is a fact, and a learned value is an inference."
        >
          <MappingField
            label="WBS"
            what="The work-breakdown code. Unmapped, Matchline learns one code per system from a prior registry and fills it in above the 0.9 confidence gate."
            example="1811"
            field="wbs"
            noneLabel="Not mapped — learn it"
            mappings={mappings}
            properties={properties}
            sources={chainSources}
            onChange={setMapping}
          />

          <MappingField
            label="Item Master Unique Identifier"
            what="The item-master name. Unmapped, Matchline learns it from a prior registry by discipline, classification and system."
            example="VF_MECH_AHU"
            field="itemMaster"
            noneLabel="Not mapped — learn it"
            mappings={mappings}
            properties={properties}
            sources={chainSources}
            onChange={setMapping}
          />

          <MappingField
            label="Equipment Classification"
            what="The register's classification column. Unmapped, Matchline falls back to the equipment type above, then to what it learned from descriptions."
            example="AHU"
            field="equipmentClassification"
            noneLabel="Not mapped — learn it"
            mappings={mappings}
            properties={properties}
            sources={chainSources}
            onChange={setMapping}
          />
        </Panel>

        <Panel
          title="The number that follows a piece of equipment"
          description="Optional, and worth mapping when the site keeps one. It is what lets Matchline recognise the same equipment after somebody corrects its tag, moves it in the model, or issues it in a different document."
        >
          <Field
            label="Site-wide asset number"
            what="A site-wide asset number that follows equipment between documents — the number a person maintains, not one the authoring tool generated. Matchline trusts it above everything the model says about identity."
            example="Dragon Data > Asset Number holding REG-000123, still REG-000123 after the tag is corrected"
            htmlFor="map-stable-id"
          >
            <PropertyPicker
              id="map-stable-id"
              properties={properties}
              value={context.draft.stableIdProperty}
              noneLabel="Not mapped — recognise equipment by the model's own ids"
              onChange={(ref): void => {
                void context.update((): WireDraftPatch => ({ stableIdProperty: ref }));
              }}
            />
          </Field>
        </Panel>

        <Panel title="Which objects count">
          <Field
            label="Require an equipment tag"
            what="When on, an object with no tag is not an asset. Turn it off only if this site commissions untagged equipment."
            example="18 untagged objects leave the catalog"
            htmlFor="require-tag"
          >
            <label className="toggle">
              <input
                id="require-tag"
                type="checkbox"
                data-testid="require-tag"
                checked={filters.requireTagProperty}
                onChange={(event): void => {
                  setFilters({ requireTagProperty: event.target.checked });
                }}
              />
              <span>{filters.requireTagProperty ? 'Required' : 'Not required'}</span>
            </label>
          </Field>

          <Field
            label="Collapse components into their parent"
            what="When on, a matched asset absorbs the sub-objects underneath it, so one physical unit is one asset rather than forty."
            example="A skid's valves and sensors fold into the skid"
            htmlFor="collapse"
          >
            <label className="toggle">
              <input
                id="collapse"
                type="checkbox"
                data-testid="collapse-components"
                checked={filters.collapseComponents}
                onChange={(event): void => {
                  setFilters({ collapseComponents: event.target.checked });
                }}
              />
              <span>{filters.collapseComponents ? 'Collapsing' : 'Every object stays separate'}</span>
            </label>
          </Field>

          <ClassLists
            classes={classes}
            filters={filters}
            onToggle={toggleClass}
          />

          <SelectionSetFilter
            sets={selectionSets.data ?? []}
            loading={selectionSets.data === null}
            chosen={filters.selectionSetNames}
            onToggle={toggleSelectionSet}
          />

          <TagPatternFilter
            patterns={filters.acceptedTagPatterns}
            preview={tagPatterns.data}
            onAdd={addTagPattern}
            onRemove={removeTagPattern}
          />
        </Panel>
      </div>

      <div className="screen__column screen__column--sticky">
        <Panel
          title="Inclusion impact"
          description="Objects leaving at each stage, in the order the filters run."
        >
          {preview.status === 'failed' ? <Callout tone="error">{preview.error}</Callout> : null}

          {preview.data === null ? (
            <Callout tone="info">Working it out…</Callout>
          ) : preview.data.state === 'blocked' ? (
            <Callout tone="info">{preview.data.reason}</Callout>
          ) : (
            <div data-testid="asset-impact">
              <StatRow>
                <Stat label="Objects in model" value={count(preview.data.totalObjects)} />
                <Stat
                  label="Assets"
                  value={count(preview.data.finalAssetCount)}
                  hint={
                    preview.data.totalObjects === 0
                      ? undefined
                      : `${percent(preview.data.finalAssetCount / preview.data.totalObjects)} of objects`
                  }
                />
                <Stat label="Duplicate tags" value={count(preview.data.duplicateTagCount)} />
                <Stat label="Folded in" value={count(preview.data.collapsedCount)} />
              </StatRow>

              <TableScroll>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Filter stage</th>
                      <th className="table__number">In</th>
                      <th className="table__number">Removed</th>
                      <th className="table__number">Left</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.stages.map((stage: WireFilterStage): JSX.Element => (
                      <tr key={stage.stage}>
                        <td>{stage.label}</td>
                        <td className="table__number">{count(stage.inCount)}</td>
                        <td className="table__number">{count(stage.droppedCount)}</td>
                        <td className="table__number">{count(stage.outCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>

              {preview.data.bySource.length < 2 ? null : (
                <>
                  <h3 className="panel__subtitle">Per model source</h3>
                  <TableScroll>
                    <table className="table table--compact" data-testid="impact-by-source">
                      <thead>
                        <tr>
                          <th>Source</th>
                          <th className="table__number">Objects</th>
                          <th className="table__number">No tag</th>
                          <th className="table__number">Folded in</th>
                          <th className="table__number">Assets</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.data.bySource.map((source: WireSourceImpact): JSX.Element => (
                          <tr key={source.sourceId}>
                            <td>{source.label}</td>
                            <td className="table__number">{count(source.totalObjects)}</td>
                            <td className="table__number">{count(source.untaggedDroppedCount)}</td>
                            <td className="table__number">{count(source.collapsedCount)}</td>
                            <td className="table__number">{count(source.finalAssetCount)}</td>
                          </tr>
                        ))}
                        <tr className="table__total">
                          <td>{count(preview.data.bySource.length)} sources</td>
                          <td className="table__number">{count(preview.data.totalObjects)}</td>
                          <td className="table__number">
                            {count(preview.data.untaggedDroppedCount)}
                          </td>
                          <td className="table__number">{count(preview.data.collapsedCount)}</td>
                          <td className="table__number">{count(preview.data.finalAssetCount)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </TableScroll>
                </>
              )}

              <h3 className="panel__subtitle">First assets</h3>
              <TableScroll>
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Description</th>
                      <th>Building</th>
                      <th className="table__number">Objects</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.samples.map((asset: WireSampleAsset): JSX.Element => (
                      <tr key={asset.assetId}>
                        <td>{asset.canonicalTag === '' ? <span className="muted">untagged</span> : asset.canonicalTag}</td>
                        <td>{asset.description}</td>
                        <td>{asset.building}</td>
                        <td className="table__number">{asset.objectCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * One mapped field, with its chain and its per-source overrides.
 *
 * The `Field` wrapper still enforces APP.md's what-and-example rule; what the
 * chain editor adds underneath it is the ordering, which is the part of the
 * decision the single picker could not express.
 */
function MappingField({
  label,
  what,
  example,
  field,
  noneLabel,
  mappings,
  properties,
  sources,
  onChange,
}: {
  readonly label: string;
  readonly what: string;
  readonly example: string;
  readonly field: keyof WirePropertyMappings;
  readonly noneLabel: string;
  readonly mappings: WirePropertyMappings;
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly sources: readonly ChainSource[];
  readonly onChange: (field: keyof WirePropertyMappings, mapping: WireMappedProperty) => void;
}): JSX.Element {
  return (
    <Field label={label} what={what} example={example}>
      <PropertyChainEditor
        idPrefix={`map-${field}`}
        label={label}
        mapping={mappings[field]}
        properties={properties}
        sources={sources}
        noneLabel={noneLabel}
        onChange={(mapping): void => {
          onChange(field, mapping);
        }}
      />
    </Field>
  );
}

/**
 * The selection-set filter (PRODUCT.md §6.6), chosen from what the models have.
 *
 * Every set the open extractions carry is offered, and the one fact that
 * decides whether it can be used at all is on its face: a saved search whose
 * membership the extraction could not resolve is not an empty set, it is a set
 * nobody ran, and naming it blocks publication on screen 9. Marking it here is
 * what stops that refusal being the first the person hears of it — the blocker
 * text says to take the name off "the filter on screen 3", and this is it.
 *
 * A name on the filter that no open model carries is still listed, so it can be
 * removed: a project part-way through adding its models has filters naming sets
 * that do not exist yet, and hiding them would make them unremovable.
 */
function SelectionSetFilter({
  sets,
  loading,
  chosen,
  onToggle,
}: {
  readonly sets: readonly WireSelectionSetSummary[];
  readonly loading: boolean;
  readonly chosen: readonly string[];
  readonly onToggle: (name: string) => void;
}): JSX.Element {
  const known = new Set(sets.map((set: WireSelectionSetSummary): string => set.name));
  const orphans = chosen.filter((name: string): boolean => !known.has(name));

  return (
    <Field
      label="Selection sets"
      what="Keep only the objects inside the Navisworks selection sets you name. Leave every set off to accept the whole model. A set whose membership the extraction could not resolve cannot be used — publishing a profile that names one is refused."
      example="Commissionable Equipment (24 objects)"
    >
      {loading ? (
        <Callout tone="info">Reading the selection sets…</Callout>
      ) : sets.length === 0 && orphans.length === 0 ? (
        <Callout tone="info">
          The models in this project recorded no selection sets, so there is nothing to
          filter by here.
        </Callout>
      ) : (
        <div className="chip-row" data-testid="selection-set-filter">
          {sets.map((set: WireSelectionSetSummary): JSX.Element => (
            <button
              key={set.name}
              className={`chip${chosen.includes(set.name) ? ' chip--active' : ''}`}
              type="button"
              aria-pressed={chosen.includes(set.name)}
              data-testid={`selection-set-${set.name}`}
              onClick={(): void => {
                onToggle(set.name);
              }}
            >
              <span className="chip__label">
                {set.name}
                {set.membershipResolved ? null : (
                  <> <span className="badge badge--file-missing">unresolved</span></>
                )}
              </span>
              <span className="chip__hint">
                {set.membershipResolved
                  ? `${set.kind} · ${count(set.memberCount)} objects · ${set.sourceNames.join(', ')}`
                  : `${set.kind} · never run in ${set.unresolvedIn.join(', ')} · cannot be filtered on`}
              </span>
            </button>
          ))}

          {orphans.map((name: string): JSX.Element => (
            <button
              key={name}
              className="chip chip--active"
              type="button"
              aria-pressed
              data-testid={`selection-set-${name}`}
              onClick={(): void => {
                onToggle(name);
              }}
            >
              <span className="chip__label">{name}</span>
              <span className="chip__hint">
                not in any model added so far · click to take it off the filter
              </span>
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

/**
 * The accepted-tag-pattern filter, with what each pattern actually keeps.
 *
 * Glob-lite and nothing more, because that is what the engine runs
 * (`@matchline/asset-catalog`'s `isTagAccepted`): `*` stands for any run of
 * characters and every other character is literal. Offering a regular
 * expression box here would be offering something the compile cannot honour.
 *
 * The count beside each pattern is measured over the tags that actually reach
 * this stage — after the class, set and tag-presence filters — so a pattern
 * that keeps nothing says so before it is saved rather than after a compile
 * comes back empty.
 */
function TagPatternFilter({
  patterns,
  preview,
  onAdd,
  onRemove,
}: {
  readonly patterns: readonly string[];
  readonly preview: WireTagPatternPreview | null;
  readonly onAdd: (pattern: string) => void;
  readonly onRemove: (pattern: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const counts = new Map(
    preview !== null && preview.state === 'ready'
      ? preview.patterns.map((entry) => [entry.pattern, entry.matchCount] as const)
      : [],
  );

  const submit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      return;
    }
    onAdd(trimmed);
    setDraft('');
  };

  return (
    <Field
      label="Accepted tag patterns"
      what="Keep only equipment whose tag matches one of these. `*` stands for any run of characters; everything else is literal. Leave the list empty to accept every tag shape."
      example="MAH* keeps MAH001-10-01 and MAH002-10-01"
      htmlFor="tag-pattern-input"
    >
      {patterns.length === 0 ? (
        <Callout tone="info">
          No patterns, so every tag shape is accepted.
          {preview !== null && preview.state === 'ready'
            ? ` All ${count(preview.totalTags)} tagged assets stay.`
            : ''}
        </Callout>
      ) : (
        <TableScroll>
          <table className="table table--compact" data-testid="tag-pattern-table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th className="table__number">Tags kept</th>
                <th className="table__number"> </th>
              </tr>
            </thead>
            <tbody>
              {patterns.map((pattern: string): JSX.Element => {
                const matched = counts.get(pattern);
                return (
                  <tr key={pattern}>
                    <td>
                      <code>{pattern}</code>
                      {matched === 0 ? (
                        <> <span className="badge badge--file-missing">matches nothing</span></>
                      ) : null}
                    </td>
                    <td className="table__number">
                      {matched === undefined ? '—' : count(matched)}
                    </td>
                    <td className="table__number">
                      <button
                        className="button button--quiet button--small"
                        type="button"
                        aria-label={`Remove pattern ${pattern}`}
                        onClick={(): void => {
                          onRemove(pattern);
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}

      {preview !== null && preview.state === 'ready' && patterns.length > 0 ? (
        <p className="field__example">
          {count(preview.acceptedCount)} of {count(preview.totalTags)} tagged assets match at
          least one pattern.
        </p>
      ) : null}

      <div className="button-row">
        <input
          id="tag-pattern-input"
          className="control control--text"
          type="text"
          value={draft}
          placeholder="MAH*"
          data-testid="tag-pattern-input"
          onChange={(event): void => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event): void => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="button button--small"
          type="button"
          data-testid="tag-pattern-add"
          disabled={draft.trim() === ''}
          onClick={submit}
        >
          Add pattern
        </button>
      </div>
    </Field>
  );
}

/** Class include/exclude/separately-commissionable, driven off the real counts. */
function ClassLists({
  classes,
  filters,
  onToggle,
}: {
  readonly classes: readonly WireClassCount[];
  readonly filters: WireAssetFilters;
  readonly onToggle: (
    list: 'includedClasses' | 'excludedClasses' | 'separatelyCommissionableClasses',
    className: string,
  ) => void;
}): JSX.Element {
  if (classes.length === 0) {
    return (
      <Callout tone="info">
        No Navisworks class names in this extraction, so there is nothing to include or
        exclude by class.
      </Callout>
    );
  }

  return (
    <div className="class-lists">
      <Field
        label="Classes"
        what="Include leaves only those classes in the running; exclude drops them even if they were included. Leave both empty to accept every class."
        example="Include Equipment, exclude Pipe Fitting"
      >
        <TableScroll>
          <table className="table table--compact" data-testid="class-table">
            <thead>
              <tr>
                <th>Class</th>
                <th className="table__number">Objects</th>
                <th className="table__number">Include</th>
                <th className="table__number">Exclude</th>
                {filters.collapseComponents ? (
                  <th className="table__number">Stays separate</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {classes.map((entry: WireClassCount): JSX.Element => (
                <tr key={entry.className}>
                  <td>{entry.className}</td>
                  <td className="table__number">{count(entry.objectCount)}</td>
                  <td className="table__number">
                    <input
                      type="checkbox"
                      aria-label={`Include ${entry.className}`}
                      checked={filters.includedClasses.includes(entry.className)}
                      onChange={(): void => {
                        onToggle('includedClasses', entry.className);
                      }}
                    />
                  </td>
                  <td className="table__number">
                    <input
                      type="checkbox"
                      aria-label={`Exclude ${entry.className}`}
                      checked={filters.excludedClasses.includes(entry.className)}
                      onChange={(): void => {
                        onToggle('excludedClasses', entry.className);
                      }}
                    />
                  </td>
                  {filters.collapseComponents ? (
                    <td className="table__number">
                      <input
                        type="checkbox"
                        aria-label={`Keep ${entry.className} separately commissionable`}
                        checked={filters.separatelyCommissionableClasses.includes(entry.className)}
                        onChange={(): void => {
                          onToggle('separatelyCommissionableClasses', entry.className);
                        }}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Field>
    </div>
  );
}
