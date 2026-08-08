import { useCallback, type JSX } from 'react';

import type {
  WireAssetFilters,
  WireClassCount,
  WireFilterStage,
  WirePropertyMappings,
  WirePropertyRef,
  WireSampleAsset,
} from '../../../shared/schemas';
import { call, count, percent } from '../api';
import { Field } from '../components/Field';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';
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
    (key: keyof WirePropertyMappings, ref: WirePropertyRef | null): void => {
      void context.update((current) => ({
        propertyMappings: { ...current.propertyMappings, [key]: ref },
      }));
    },
    [context],
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

  const preview = usePreview(
    JSON.stringify([mappings, filters, context.scan?.fileName ?? '']),
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

        <Panel title="Which property is which">
          <Field
            label="Equipment tag"
            what="The property Matchline reads the equipment tag from. This is the identity of every asset — nothing else can stand in for it."
            example="Dragon Data > Tag holding MAH001-10-01"
            htmlFor="map-tag"
          >
            <PropertyPicker
              id="map-tag"
              properties={properties}
              value={mappings.equipmentTag}
              noneLabel="Not chosen yet"
              onChange={(ref): void => {
                setMapping('equipmentTag', ref);
              }}
            />
          </Field>

          <Field
            label="Description"
            what="Free text shown next to the tag in the register and in the generated MEL."
            example="Primary dry air handling unit"
            htmlFor="map-description"
          >
            <PropertyPicker
              id="map-description"
              properties={properties}
              value={mappings.description}
              noneLabel="Not mapped"
              onChange={(ref): void => {
                setMapping('description', ref);
              }}
            />
          </Field>

          <Field
            label="Equipment type"
            what="What kind of thing this is. Used for grouping and for the role rules later on."
            example="Air Handler"
            htmlFor="map-type"
          >
            <PropertyPicker
              id="map-type"
              properties={properties}
              value={mappings.equipmentType}
              noneLabel="Not mapped"
              onChange={(ref): void => {
                setMapping('equipmentType', ref);
              }}
            />
          </Field>

          <Field
            label="Building"
            what="Which building the asset sits in. Becomes the top level of the hierarchy."
            example="B14"
            htmlFor="map-building"
          >
            <PropertyPicker
              id="map-building"
              properties={properties}
              value={mappings.building}
              noneLabel="Not mapped"
              onChange={(ref): void => {
                setMapping('building', ref);
              }}
            />
          </Field>

          <Field
            label="Discipline"
            what="The discipline as the model authors wrote it. Matchline maps it to an SSM discipline later; it never overwrites what the model said."
            example="Mechanical"
            htmlFor="map-discipline"
          >
            <PropertyPicker
              id="map-discipline"
              properties={properties}
              value={mappings.nativeDiscipline}
              noneLabel="Not mapped"
              onChange={(ref): void => {
                setMapping('nativeDiscipline', ref);
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
