import { useEffect, useState, type JSX } from 'react';

import {
  decodePropertyRef,
  encodePropertyRef,
  isPropertyInCatalog,
  missingPropertyLabel,
} from '../../../shared/property-ref';
import type { WirePropertyCatalogRow, WirePropertyRef } from '../../../shared/schemas';
import { call, count, messageOf, percent } from '../api';

/**
 * Picks one extracted property, showing how much of the model actually carries
 * it.
 *
 * Coverage is on the option itself rather than in a tooltip because it is the
 * thing that decides whether a mapping is any good: `Identity Data > Mark` at
 * 12% and at 97% are different decisions, and a bare list of property names
 * hides that difference completely.
 *
 * ## Why the search box asks main rather than filtering `properties`
 *
 * `properties` is not the catalog. It is ONE page of it — the first five
 * hundred rows, ranked by coverage — and a federated Revit or Plant3D project
 * runs to one to five thousand distinct category/name pairs. Filtering that
 * array would only ever search the top of a list the site's own property is
 * routinely not in: the equipment tag frequently sits on 3–8% of objects, which
 * is far below the cut, so the property a person came here to map is not merely
 * hard to find, it is absent. Quick Setup could see it (it ranks the whole
 * catalog in main) and this control could not, which is the worst kind of
 * inconsistency — the same fact, two answers, no explanation on screen.
 *
 * So a non-empty query goes to `model:property-page`, which filters the whole
 * catalog on a substring of either half of the address before it sorts and
 * pages. An empty query changes nothing: the options are `properties`, exactly
 * the coverage-ranked page the caller handed over, and no request is made. That
 * keeps the common case — pick one of the obvious properties — as fast and as
 * offline as it has always been.
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
 * Searching gives that invariant a second way to break: a query the mapped
 * property does not match leaves it out of the options, and the DOM reselects
 * the first row again. The same option covers it, with different wording,
 * because the two states are different facts. "Not present in the current model
 * sources" is about the model; "not among these results" is about the search
 * the person is in the middle of typing, and only the first deserves the
 * warning border.
 *
 * Component behaviour worth keeping: this component never calls `onChange`
 * except from a real `change` event on the select. The search box writes local
 * state and nothing else — there is still no normalization pass and no "repair
 * the value" branch; a picker that corrects its own input is a picker that can
 * lose one.
 */

/** Long enough that typing an address does not fire a call per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * A `<select>` is a list somebody reads. Fifty rows of the best-covered matches
 * is already more than anyone scrolls; past that the honest answer is to say
 * how many were left out and let them narrow the query.
 */
const SEARCH_LIMIT = 50;

export function PropertyPicker({
  id,
  properties,
  value,
  noneLabel,
  onChange,
  testId,
}: {
  readonly id: string;
  /** The initial, coverage-ranked page. What the control shows unsearched. */
  readonly properties: readonly WirePropertyCatalogRow[];
  readonly value: WirePropertyRef | null;
  /** Wording for the empty option, e.g. "Not mapped". */
  readonly noneLabel: string;
  readonly onChange: (ref: WirePropertyRef | null) => void;
  readonly testId?: string;
}): JSX.Element {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<readonly WirePropertyCatalogRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const needle = query.trim();
  const isSearch = needle !== '';

  useEffect((): (() => void) => {
    if (needle === '') {
      setResults([]);
      setTotal(0);
      setIsSearching(false);
      setError(null);
      return (): void => {
        // Nothing in flight.
      };
    }

    // `cancelled` is the whole guard: a slow answer for `TA` must never land on
    // top of a fast answer for `TAG-`, and the two are told apart by nothing
    // except which effect run they belong to.
    let cancelled = false;
    setIsSearching(true);
    const timer = setTimeout((): void => {
      void call(
        window.matchline.model.propertyPage({
          offset: 0,
          limit: SEARCH_LIMIT,
          sortBy: 'coverage',
          descending: true,
          search: needle,
        }),
      ).then(
        (page): void => {
          if (cancelled) {
            return;
          }
          setResults(page.rows);
          setTotal(page.total);
          setError(null);
          setIsSearching(false);
        },
        (caught: unknown): void => {
          if (cancelled) {
            return;
          }
          // The options stay as they were. Blanking the list on a failed call
          // would take away the rows the person can still legitimately pick.
          setError(messageOf(caught));
          setIsSearching(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);

    return (): void => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needle]);

  const options = isSearch ? results : properties;
  // Absence is judged against the page the caller handed over, exactly as it
  // was before there was a search box — except that a hit in the results is
  // proof the catalog does carry the address after all.
  const listed = isPropertyInCatalog(value, options);
  const absent = value !== null && !listed && !isPropertyInCatalog(value, properties);
  const needsOwnOption = value !== null && !listed;

  return (
    <div className="property-picker">
      <input
        className="control control--text"
        type="search"
        aria-label="Search every property in the model sources"
        data-testid={testId === undefined ? undefined : `${testId}-search`}
        placeholder="Search every property…"
        value={query}
        onChange={(event): void => {
          setQuery(event.target.value);
        }}
      />

      <select
        id={id}
        className={`control control--select${absent ? ' control--absent' : ''}`}
        data-testid={testId}
        data-absent={absent ? 'true' : undefined}
        value={encodePropertyRef(value)}
        onChange={(event): void => {
          onChange(decodePropertyRef(event.target.value));
        }}
      >
        <option value="">{noneLabel}</option>

        {/* Rendered before the catalog so the mapping a person made sits at the
            top of the list rather than after five hundred properties it is not
            one of. */}
        {needsOwnOption && value !== null ? (
          <option value={encodePropertyRef(value)}>
            {absent
              ? missingPropertyLabel(value)
              : `Mapped: ${value.category} > ${value.name} — not among these results`}
          </option>
        ) : null}

        {options.map((row: WirePropertyCatalogRow): JSX.Element => {
          const encoded = encodePropertyRef({ category: row.category, name: row.name });
          return (
            <option key={encoded} value={encoded}>
              {`${row.category} > ${row.name} — ${percent(row.coverage)} of objects`}
            </option>
          );
        })}
      </select>

      {isSearch && isSearching ? (
        <p className="property-picker__note muted">Searching every property…</p>
      ) : null}

      {isSearch && !isSearching && error === null ? (
        <p className="property-picker__note muted">
          {`${count(results.length)} of ${count(total)} matching properties`}
          {total > results.length
            ? ' — only the best-covered are listed, so narrow the search to reach the rest.'
            : ''}
        </p>
      ) : null}

      {error === null ? null : <p className="callout callout--error">{error}</p>}
    </div>
  );
}
