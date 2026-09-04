import type { JSX } from 'react';

import { propertyRefEquals } from '../../../shared/property-ref';
import type {
  WireMappedProperty,
  WirePropertyCatalogRow,
  WirePropertyChain,
  WirePropertyRef,
} from '../../../shared/schemas';
import { Callout } from './Panel';
import { PropertyPicker } from './PropertyPicker';

/**
 * Edits one mapped field as what it actually is: an ordered fallback chain with
 * optional per-source overrides (P0-8, hard gate 5).
 *
 * ## Why a chain and not a property
 *
 * Screen 3 used to pick one property per field, and a profile that carried more
 * kept the rest invisibly — the gate row said so in as many words. A site whose
 * building lives in `Dragon Data > Building` on the mechanical model and in
 * `Element > Level` on the architectural one is stating a *preference*, and the
 * order IS the statement: the first rung that answers with a non-blank value
 * wins and the rest are not consulted. So the editor is a list, and the list is
 * ordered, and reordering it is one button.
 *
 * ## Why an override replaces rather than extends
 *
 * `bySource` REPLACES the chain for the source it names. "On this file the
 * building is somewhere else" is the whole statement; appending the global chain
 * behind it would silently reinstate the address the site just overrode. The
 * wording under the disclosure says exactly that, because it is the one thing
 * about this control that is not obvious from looking at it.
 *
 * ## Adding is a choice, never a guess
 *
 * There is no "add an empty rung" button. A rung with no address is not a
 * decision half-made, it is a row that does nothing and reads as though the
 * field were configured. The add control is a picker: choosing a property is
 * what appends it, so every rung in the list is a property somebody named.
 *
 * ## Every property control here is a `PropertyPicker`
 *
 * The rungs always were, so they inherit its catalog-wide search — the one that
 * asks main rather than filtering the coverage-ranked page it was handed, which
 * is the only way to reach the low-coverage property a site actually tags with.
 * The "if that is blank, read" control was the exception: its own `<select>`
 * over the same page, and therefore the one place in a chain where the second
 * rung could not be the property the first one exists to fall back FROM. It is
 * a picker now too, so the search reaches every rung by the same route and
 * there is one debounced fetch in the tree, not four.
 */

export interface ChainSource {
  readonly sourceId: string;
  readonly displayName: string;
}

export function PropertyChainEditor({
  idPrefix,
  label,
  mapping,
  properties,
  sources,
  noneLabel,
  onChange,
}: {
  readonly idPrefix: string;
  /** Names the field in the aria labels, e.g. "Equipment tag". */
  readonly label: string;
  readonly mapping: WireMappedProperty;
  readonly properties: readonly WirePropertyCatalogRow[];
  /** Every ready model source, for the per-source overrides. */
  readonly sources: readonly ChainSource[];
  /** Wording for the empty option on the first rung, e.g. "Not mapped". */
  readonly noneLabel: string;
  readonly onChange: (mapping: WireMappedProperty) => void;
}): JSX.Element {
  const overrides = mapping.bySource;
  const overridden = new Set(overrides.map((entry) => entry.sourceId));
  const available = sources.filter((source) => !overridden.has(source.sourceId));

  return (
    <div className="chain chain--property" data-testid={`${idPrefix}-chain`}>
      <PropertyRefChain
        idPrefix={idPrefix}
        label={label}
        chain={mapping.chain}
        properties={properties}
        noneLabel={noneLabel}
        onChange={(chain): void => {
          onChange({ ...mapping, chain: [...chain] });
        }}
      />

      {sources.length < 2 && overrides.length === 0 ? null : (
        <details
          className="chain__overrides"
          data-testid={`${idPrefix}-overrides`}
          open={overrides.length > 0}
        >
          <summary>
            {overrides.length === 0
              ? 'One file reads it somewhere else'
              : `${String(overrides.length)} file${overrides.length === 1 ? '' : 's'} read it somewhere else`}
          </summary>

          <p className="chain__what">
            A file listed here uses its own addresses <em>instead of</em> the ones above, not as
            well as. That is the point of an override: the model in question really does keep the
            value in a different place.
          </p>

          {overrides.map((override): JSX.Element => {
            const source = sources.find((entry) => entry.sourceId === override.sourceId);
            return (
              <div
                className="chain__override"
                key={override.sourceId}
                data-testid={`${idPrefix}-override-${override.sourceId}`}
              >
                <div className="chain__override-head">
                  <span className="chain__override-name">
                    {source?.displayName ?? override.sourceId}
                  </span>
                  {source === undefined ? (
                    <span className="chain__override-absent">
                      not a source of this project right now
                    </span>
                  ) : null}
                  <button
                    className="button button--quiet button--small"
                    type="button"
                    data-testid={`${idPrefix}-override-remove-${override.sourceId}`}
                    onClick={(): void => {
                      onChange({
                        ...mapping,
                        bySource: overrides.filter(
                          (entry) => entry.sourceId !== override.sourceId,
                        ),
                      });
                    }}
                  >
                    Use the shared list
                  </button>
                </div>

                <PropertyRefChain
                  idPrefix={`${idPrefix}-${override.sourceId}`}
                  label={`${label} on ${source?.displayName ?? override.sourceId}`}
                  chain={override.chain}
                  properties={properties}
                  noneLabel="Choose a property"
                  onChange={(chain): void => {
                    onChange({
                      ...mapping,
                      bySource: overrides.map((entry) =>
                        entry.sourceId === override.sourceId
                          ? { sourceId: entry.sourceId, chain: [...chain] }
                          : entry,
                      ),
                    });
                  }}
                />
              </div>
            );
          })}

          {available.length === 0 ? (
            <Callout tone="info">Every model source has its own list already.</Callout>
          ) : (
            <label className="inline-field inline-field--wide">
              <span>Add an override for</span>
              <select
                className="control control--select"
                data-testid={`${idPrefix}-override-add`}
                value=""
                onChange={(event): void => {
                  if (event.target.value === '') {
                    return;
                  }
                  onChange({
                    ...mapping,
                    bySource: [...overrides, { sourceId: event.target.value, chain: [] }],
                  });
                }}
              >
                <option value="">Pick a model source…</option>
                {available.map((source): JSX.Element => (
                  <option key={source.sourceId} value={source.sourceId}>
                    {source.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </details>
      )}
    </div>
  );
}

/**
 * The ordered rungs of one chain — the global one, a source's own, or a derived
 * attribute's `model-property` rung, which is the same thing wearing a
 * different name (P0-7).
 */
export function PropertyRefChain({
  idPrefix,
  label,
  chain,
  properties,
  noneLabel,
  onChange,
}: {
  readonly idPrefix: string;
  readonly label: string;
  readonly chain: WirePropertyChain;
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly noneLabel: string;
  readonly onChange: (chain: WirePropertyChain) => void;
}): JSX.Element {
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

  const unused = properties.filter(
    (row): boolean =>
      !chain.some((ref): boolean => propertyRefEquals(ref, { category: row.category, name: row.name })),
  );

  return (
    <>
      <ol className="chain__list">
        {chain.map((ref: WirePropertyRef, index: number): JSX.Element => (
          <li className="chain__item chain__item--rung" key={`${ref.category} ${ref.name}`}>
            <div className="chain__head">
              <span className="chain__order">{index + 1}</span>
              <PropertyPicker
                id={`${idPrefix}-rung-${String(index)}`}
                testId={`${idPrefix}-rung-${String(index)}`}
                properties={properties}
                value={ref}
                noneLabel={noneLabel}
                onChange={(next): void => {
                  onChange(
                    next === null
                      ? chain.filter((_entry, position): boolean => position !== index)
                      : chain.map((entry, position) => (position === index ? next : entry)),
                  );
                }}
              />
              <span className="chain__rung-actions">
              <button
                className="button button--quiet button--small"
                type="button"
                aria-label={`Move ${label} address ${String(index + 1)} up`}
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
                aria-label={`Move ${label} address ${String(index + 1)} down`}
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
                aria-label={`Remove ${label} address ${String(index + 1)}`}
                data-testid={`${idPrefix}-remove-${String(index)}`}
                onClick={(): void => {
                  onChange(chain.filter((_entry, position): boolean => position !== index));
                }}
              >
                Remove
              </button>
              </span>
            </div>
            {index === 0 || chain.length < 2 ? null : (
              <p className="chain__what">Used only where the addresses above say nothing.</p>
            )}
          </li>
        ))}
      </ol>

      {chain.length === 0 ? (
        <PropertyPicker
          id={`${idPrefix}-first`}
          testId={`${idPrefix}-first`}
          properties={properties}
          value={null}
          noneLabel={noneLabel}
          onChange={(next): void => {
            if (next !== null) {
              onChange([next]);
            }
          }}
        />
      ) : unused.length === 0 ? null : (
        <label className="inline-field inline-field--wide chain__add" htmlFor={`${idPrefix}-add`}>
          <span>If that is blank, read</span>
          <PropertyPicker
            id={`${idPrefix}-add`}
            testId={`${idPrefix}-add`}
            properties={unused}
            value={null}
            noneLabel="Nothing — stop here"
            onChange={(next): void => {
              // The search reaches the whole catalog, which is exactly what the
              // filtered list could not offer — and also what it could not
              // exclude. A rung this chain already reads would state the same
              // fallback twice and say nothing new, so it is not appended.
              if (next === null || chain.some((entry): boolean => propertyRefEquals(entry, next))) {
                return;
              }
              onChange([...chain, next]);
            }}
          />
        </label>
      )}
    </>
  );
}
