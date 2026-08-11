import type { JSX } from 'react';

import {
  decodePropertyRef,
  encodePropertyRef,
  isPropertyInCatalog,
  missingPropertyLabel,
} from '../../../shared/property-ref';
import type { WirePropertyCatalogRow, WirePropertyRef } from '../../../shared/schemas';
import { percent } from '../api';

/**
 * Picks one extracted property, showing how much of the model actually carries
 * it.
 *
 * Coverage is on the option itself rather than in a tooltip because it is the
 * thing that decides whether a mapping is any good: `Identity Data > Mark` at
 * 12% and at 97% are different decisions, and a bare list of property names
 * hides that difference completely.
 *
 * ## The mapped-but-absent state (M4c bug, fixed here)
 *
 * A profile is a site's rule set and outlives any one model. A mapping whose
 * property is not in the *currently loaded* sources is therefore ordinary — a
 * source mid-re-extraction, a model swapped for a newer issue, a profile
 * imported before its models were added — and it used to render as **"Not
 * mapped"**, because a `<select>` whose `value` matches no `<option>` falls back
 * to the first one. Two things went wrong at once: the screen stated a decision
 * nobody had made, and the DOM's own selection had already moved to the empty
 * option, so the next interaction wrote that emptiness into the draft.
 *
 * The fix is one option. When `value` is set and the catalog does not carry it,
 * the picker renders an option FOR it, selected, labelled as mapped-and-absent.
 * The select's value always matches an option, so nothing is silently cleared,
 * and the label says what is actually true. Clearing the mapping stays possible
 * — it is the empty option, chosen deliberately — which is the difference
 * between a decision and an accident.
 *
 * Component behaviour worth keeping: this component never calls `onChange`
 * except from a real `change` event. It has no effect, no normalization pass and
 * no "repair the value" branch; a picker that corrects its own input is a picker
 * that can lose one.
 */

export function PropertyPicker({
  id,
  properties,
  value,
  noneLabel,
  onChange,
  testId,
}: {
  readonly id: string;
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly value: WirePropertyRef | null;
  /** Wording for the empty option, e.g. "Not mapped". */
  readonly noneLabel: string;
  readonly onChange: (ref: WirePropertyRef | null) => void;
  readonly testId?: string;
}): JSX.Element {
  const missing = value !== null && !isPropertyInCatalog(value, properties);

  return (
    <select
      id={id}
      className={`control control--select${missing ? ' control--absent' : ''}`}
      data-testid={testId}
      data-absent={missing ? 'true' : undefined}
      value={encodePropertyRef(value)}
      onChange={(event): void => {
        onChange(decodePropertyRef(event.target.value));
      }}
    >
      <option value="">{noneLabel}</option>

      {/* Rendered before the catalog so the mapping a person made sits at the
          top of the list rather than after five hundred properties it is not
          one of. */}
      {missing && value !== null ? (
        <option value={encodePropertyRef(value)}>{missingPropertyLabel(value)}</option>
      ) : null}

      {properties.map((row: WirePropertyCatalogRow): JSX.Element => {
        const encoded = encodePropertyRef({ category: row.category, name: row.name });
        return (
          <option key={encoded} value={encoded}>
            {`${row.category} > ${row.name} — ${percent(row.coverage)} of objects`}
          </option>
        );
      })}
    </select>
  );
}
