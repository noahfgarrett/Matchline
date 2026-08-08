import type { JSX } from 'react';

import { decodePropertyRef, encodePropertyRef } from '../../../shared/property-ref';
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
 */

export function PropertyPicker({
  id,
  properties,
  value,
  noneLabel,
  onChange,
}: {
  readonly id: string;
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly value: WirePropertyRef | null;
  /** Wording for the empty option, e.g. "Not mapped". */
  readonly noneLabel: string;
  readonly onChange: (ref: WirePropertyRef | null) => void;
}): JSX.Element {
  return (
    <select
      id={id}
      className="control control--select"
      value={encodePropertyRef(value)}
      onChange={(event): void => {
        onChange(decodePropertyRef(event.target.value));
      }}
    >
      <option value="">{noneLabel}</option>
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
