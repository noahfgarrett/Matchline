import { useCallback, type JSX } from 'react';

import type {
  WireAnatomyExample,
  WireAnatomyMiss,
  WireSegmentExtractor,
  WireSegmentName,
  WireTagAnatomy,
} from '../../../shared/schemas';
import { call, count, percent } from '../api';
import { Field } from '../components/Field';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';
import { usePreview } from '../usePreview';

import type { WizardContext } from './Wizard';

/**
 * Screen 4 — Tag anatomy (PRODUCT.md §5.4, §7).
 *
 * Anatomy is taught, never guessed. Nothing on this screen is a regular
 * expression: an extractor addresses structure — which token, the letters at
 * its front, the digits at its back — so a site can describe its convention
 * without anyone writing a pattern that later nobody can read.
 *
 * Every extractor row shows what it currently produces on a real tag from this
 * model. That is the whole point of the screen: you are not configuring a rule,
 * you are watching it run.
 */

const SEGMENTS: ReadonlyArray<{
  readonly name: WireSegmentName;
  readonly label: string;
  readonly what: string;
  readonly example: string;
}> = [
  {
    name: 'role',
    label: 'Role',
    what: 'What kind of thing the tag says this is. Drives equipment classification and the relationship rules.',
    example: 'MAH001-10-01 → MAH',
  },
  {
    name: 'system',
    label: 'System',
    what: 'The part of the tag that names the system. Screen 5 can use this directly as the System Key.',
    example: 'MAH001-10-01 → 001',
  },
  {
    name: 'unit',
    label: 'Unit',
    what: 'The unit or area portion. Used with instance to group a tag family together.',
    example: 'MAH001-10-01 → 10',
  },
  {
    name: 'instance',
    label: 'Instance',
    what: 'Which one of several identical items this is.',
    example: 'MAH001-10-01 → 01',
  },
];

const EXTRACTOR_KINDS: ReadonlyArray<readonly [string, string]> = [
  ['', 'Not used'],
  ['alphaPrefix', 'Letters at the start of a token'],
  ['digitSuffix', 'Digits at the end of a token'],
  ['token', 'The whole token'],
  ['tokenRange', 'Several tokens joined back up'],
  ['charRange', 'A slice of characters inside a token'],
];

/** Comma-separated text is how a short list is easiest to type and to read. */
function toList(text: string): string[] {
  return text
    .split(',')
    .map((entry: string): string => entry.trim())
    .filter((entry: string): boolean => entry.length > 0);
}

export function Screen4Anatomy({ context }: { readonly context: WizardContext }): JSX.Element {
  const anatomy = context.draft.tagAnatomy;

  const setAnatomy = useCallback(
    (patch: Partial<WireTagAnatomy>): void => {
      void context.update((current) => ({ tagAnatomy: { ...current.tagAnatomy, ...patch } }));
    },
    [context],
  );

  const setExtractor = useCallback(
    (segment: WireSegmentName, extractor: WireSegmentExtractor | null): void => {
      void context.update((current) => {
        const others = current.tagAnatomy.segments.filter(
          (row): boolean => row.segment !== segment,
        );
        const next = extractor === null ? others : [...others, { segment, extractor }];
        // Keep the profile's segment order stable regardless of edit order.
        const order = SEGMENTS.map((entry): WireSegmentName => entry.name);
        next.sort((left, right) => order.indexOf(left.segment) - order.indexOf(right.segment));
        return { tagAnatomy: { ...current.tagAnatomy, segments: next } };
      });
    },
    [context],
  );

  const preview = usePreview(
    JSON.stringify([anatomy, context.draft.propertyMappings, context.draft.assetFilters]),
    async () => (await call(window.matchline.anatomy.preview())).preview,
  );

  const sample = preview.data !== null && preview.data.state === 'ready' ? preview.data.sample : null;

  return (
    <div className="screen screen--split" data-testid="screen-4">
      <div className="screen__column">
        <header className="screen__header">
          <h1 className="screen__title">4. Tag anatomy</h1>
          <p className="screen__lede">
            Teach Matchline how this site writes its tags. Split the tag into tokens, then say
            which part means what. Everything below runs against every tag in your asset
            catalog as you type.
          </p>
        </header>

        <Panel title="Splitting the tag">
          <Field
            label="Separators"
            what="The characters the tag is split on, longest match first. Everything between two separators is one token."
            example="A single hyphen turns MAH001-10-01 into MAH001, 10, 01"
            htmlFor="separators"
          >
            <input
              id="separators"
              className="control control--text"
              type="text"
              data-testid="separators"
              placeholder="-"
              value={anatomy.separators.join(', ')}
              onChange={(event): void => {
                setAnatomy({ separators: toList(event.target.value) });
              }}
            />
          </Field>

          <Field
            label="Ignored suffixes"
            what="Stripped off the end before splitting, so a variant spelling does not become its own asset. Case-sensitive, longest match wins."
            example="-SPARE removed from MAH001-10-01-SPARE"
            htmlFor="ignored-suffixes"
          >
            <input
              id="ignored-suffixes"
              className="control control--text"
              type="text"
              data-testid="ignored-suffixes"
              placeholder="-SPARE, -TEMP"
              value={anatomy.ignoredSuffixes.join(', ')}
              onChange={(event): void => {
                setAnatomy({ ignoredSuffixes: toList(event.target.value) });
              }}
            />
          </Field>
        </Panel>

        <Panel
          title="What each part means"
          description={
            sample === null
              ? 'Results appear here once a segment matches.'
              : `Results shown for ${sample.tag}.`
          }
        >
          {SEGMENTS.map((segment): JSX.Element => (
            <SegmentRow
              key={segment.name}
              label={segment.label}
              what={segment.what}
              example={segment.example}
              segment={segment.name}
              extractor={
                anatomy.segments.find((row): boolean => row.segment === segment.name)?.extractor ??
                null
              }
              result={
                sample?.segments.find((row): boolean => row.segment === segment.name)?.value ?? null
              }
              onChange={setExtractor}
            />
          ))}
        </Panel>

        <Panel title="Family keys">
          <Field
            label="Family key template"
            what="Builds the key that ties a tag family together. Use {role}, {system}, {unit}, {instance}, {token:N} or {tokens:N-M}."
            example="{system}-{token:1}-{token:2} gives 001-10-01"
            htmlFor="family-key"
          >
            <input
              id="family-key"
              className="control control--text"
              type="text"
              data-testid="family-key"
              placeholder="{system}-{token:1}-{token:2}"
              value={anatomy.familyKeyTemplate}
              onChange={(event): void => {
                setAnatomy({ familyKeyTemplate: event.target.value });
              }}
            />
          </Field>

          <Field
            label="Local family template"
            what="An optional narrower key, for grouping within one system rather than across the site."
            example="{token:1}-{token:2} gives 10-01"
            htmlFor="local-family"
          >
            <input
              id="local-family"
              className="control control--text"
              type="text"
              data-testid="local-family"
              placeholder="{token:1}-{token:2}"
              value={anatomy.localFamilyTemplate}
              onChange={(event): void => {
                setAnatomy({ localFamilyTemplate: event.target.value });
              }}
            />
          </Field>
        </Panel>
      </div>

      <div className="screen__column screen__column--sticky">
        <Panel title="Across every tag in this model">
          {preview.status === 'failed' ? <Callout tone="error">{preview.error}</Callout> : null}

          {preview.data === null ? (
            <Callout tone="info">Working it out…</Callout>
          ) : preview.data.state === 'blocked' ? (
            <Callout tone="info">{preview.data.reason}</Callout>
          ) : (
            <div data-testid="anatomy-preview">
              <StatRow>
                <Stat
                  label="Tags matched"
                  value={percent(preview.data.coverage)}
                  hint={`${count(preview.data.matchedCount)} of ${count(preview.data.total)}`}
                />
                {preview.data.segmentStats.map((stat): JSX.Element => (
                  <Stat
                    key={stat.segment}
                    label={`Distinct ${stat.segment}`}
                    value={count(stat.distinctValueCount)}
                  />
                ))}
              </StatRow>

              <h3 className="panel__subtitle">Worked examples</h3>
              <TableScroll>
                <table className="table table--compact" data-testid="anatomy-examples">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      {preview.data.examples[0]?.segments.map((row): JSX.Element => (
                        <th key={row.segment}>{row.segment}</th>
                      )) ?? null}
                      <th>Family key</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.examples.map((entry: WireAnatomyExample): JSX.Element => (
                      <tr key={entry.tag}>
                        <td>{entry.tag}</td>
                        {entry.segments.map((row): JSX.Element => (
                          <td key={row.segment}>
                            {row.value === null ? <span className="muted">—</span> : row.value}
                          </td>
                        ))}
                        <td>{entry.familyKey === '' ? <span className="muted">—</span> : entry.familyKey}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>

              <h3 className="panel__subtitle">
                Tags this does not cover ({count(preview.data.total - preview.data.matchedCount)})
              </h3>
              {preview.data.misses.length === 0 ? (
                <Callout tone="success">Every tag in the catalog decomposes cleanly.</Callout>
              ) : (
                <TableScroll>
                  <table className="table table--compact" data-testid="anatomy-misses">
                    <thead>
                      <tr>
                        <th>Tag</th>
                        <th>Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.data.misses.map((miss: WireAnatomyMiss): JSX.Element => (
                        <tr key={miss.tag}>
                          <td>{miss.tag === '' ? <span className="muted">(blank)</span> : miss.tag}</td>
                          <td>{miss.explanation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** One segment: pick how it is cut out, and watch it run on a real tag. */
function SegmentRow({
  label,
  what,
  example,
  segment,
  extractor,
  result,
  onChange,
}: {
  readonly label: string;
  readonly what: string;
  readonly example: string;
  readonly segment: WireSegmentName;
  readonly extractor: WireSegmentExtractor | null;
  readonly result: string | null;
  readonly onChange: (segment: WireSegmentName, extractor: WireSegmentExtractor | null) => void;
}): JSX.Element {
  const kind = extractor?.kind ?? '';

  const changeKind = (nextKind: string): void => {
    switch (nextKind) {
      case 'alphaPrefix':
      case 'digitSuffix':
      case 'token':
        onChange(segment, { kind: nextKind, token: 0 });
        return;
      case 'tokenRange':
        onChange(segment, { kind: 'tokenRange', from: 0, to: 1 });
        return;
      case 'charRange':
        onChange(segment, { kind: 'charRange', token: 0, from: 0, to: 3 });
        return;
      default:
        onChange(segment, null);
    }
  };

  return (
    <Field label={label} what={what} example={example} htmlFor={`segment-${segment}`}>
      <div className="segment-row">
        <select
          id={`segment-${segment}`}
          className="control control--select"
          data-testid={`segment-kind-${segment}`}
          value={kind}
          onChange={(event): void => {
            changeKind(event.target.value);
          }}
        >
          {EXTRACTOR_KINDS.map(([value, text]): JSX.Element => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>

        {extractor === null ? null : (
          <div className="segment-row__numbers">
            {extractor.kind === 'tokenRange' ? (
              <>
                <NumberInput
                  label="from token"
                  value={extractor.from}
                  onChange={(value): void => {
                    onChange(segment, { ...extractor, from: value });
                  }}
                />
                <NumberInput
                  label="to token"
                  value={extractor.to}
                  onChange={(value): void => {
                    onChange(segment, { ...extractor, to: value });
                  }}
                />
              </>
            ) : (
              <NumberInput
                label="token"
                value={extractor.token}
                onChange={(value): void => {
                  onChange(segment, { ...extractor, token: value });
                }}
              />
            )}

            {extractor.kind === 'charRange' ? (
              <>
                <NumberInput
                  label="first character"
                  value={extractor.from}
                  onChange={(value): void => {
                    onChange(segment, { ...extractor, from: value });
                  }}
                />
                <NumberInput
                  label="up to character"
                  value={extractor.to}
                  onChange={(value): void => {
                    onChange(segment, { ...extractor, to: value });
                  }}
                />
              </>
            ) : null}
          </div>
        )}

        <span className="segment-row__result" data-testid={`segment-result-${segment}`}>
          {extractor === null ? (
            <span className="muted">not used</span>
          ) : result === null ? (
            <span className="muted">no match</span>
          ) : (
            <code>{result}</code>
          )}
        </span>
      </div>
    </Field>
  );
}

function NumberInput({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className="number-input">
      <span className="number-input__label">{label}</span>
      <input
        className="control control--number"
        type="number"
        min={0}
        value={value}
        onChange={(event): void => {
          const parsed = Number.parseInt(event.target.value, 10);
          onChange(Number.isNaN(parsed) || parsed < 0 ? 0 : parsed);
        }}
      />
    </label>
  );
}
