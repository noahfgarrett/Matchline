import { useCallback, useState, type JSX } from 'react';

import type {
  WireAssignmentMatch,
  WireDraftPatch,
  WireSourceAssignmentRule,
  WireSourceAssignmentScope,
} from '../../../shared/schemas';
import { call, count } from '../api';
import { Field } from '../components/Field';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';
import { usePreview } from '../usePreview';

import type { WizardContext } from './Wizard';

/**
 * Screen 6 — the source-assignment rules (P0-8, hard gate 6).
 *
 * Some facts are true of a whole document rather than of an object.
 * `Dragon-Mechanical.nwc` is the mechanical model; every object in
 * `B14-Coordination.nwd` is in building B14. The engine has read these rules out
 * of the profile since M4b and ranks them exactly where P0-8 puts them — an
 * object property that answers the same field always wins, because the model
 * saying so beats the project saying so about the model. What was missing was
 * the editor.
 *
 * ## Why a preview is not optional here
 *
 * A rule is one line of text that can silently assign a building to fifty
 * thousand objects, or to none. `Dragon-*.nwd` against a project of `.nwc`
 * files matches nothing and looks perfectly correct. So every rule shows what
 * it hits — which files, how many objects, and what `$1` expanded to — beside
 * the field that defines it, and a rule that hits nothing says so in the same
 * breath as listing the names it could have hit.
 */

const SCOPES: ReadonlyArray<readonly [WireSourceAssignmentScope, string, string]> = [
  [
    'source-model',
    'One model inside a file',
    'Matches a source model by its file name, exactly. A federated NWD holds several, and this names one of them.',
  ],
  [
    'logical-source',
    'One registered source',
    "Matches a source by the project's own id for it. Never a file name — two files can share one.",
  ],
  [
    'filename-pattern',
    'A file-name pattern',
    'Matches source-model file names with exactly one *. What the * covers becomes $1, which any value below can use.',
  ],
];

function blankRule(): WireSourceAssignmentRule {
  return {
    scope: 'source-model',
    match: '',
    assign: { building: '', nativeDiscipline: '', custom: [] },
  };
}

export function SourceAssignments({
  context,
}: {
  readonly context: WizardContext;
}): JSX.Element {
  const rules = context.draft.sourceAssignments;

  const write = useCallback(
    (next: readonly WireSourceAssignmentRule[]): void => {
      void context.update((): WireDraftPatch => ({ sourceAssignments: [...next] }));
    },
    [context],
  );

  const replace = (index: number, rule: WireSourceAssignmentRule): void => {
    write(rules.map((entry, position) => (position === index ? rule : entry)));
  };

  return (
    <Panel
      title="What a whole file says"
      description="Facts that are true of a document rather than of an object. A property on the object always wins — these fill in what no object states."
      actions={
        <button
          className="button button--small"
          type="button"
          data-testid="assignment-add"
          onClick={(): void => {
            write([...rules, blankRule()]);
          }}
        >
          Add a rule
        </button>
      }
    >
      {rules.length === 0 ? (
        <Callout tone="info">
          No rules. Every building and discipline comes from the objects themselves. Add one when a
          model carries the fact in its name rather than in its properties — a controls model whose
          objects never state a discipline, say.
        </Callout>
      ) : null}

      {rules.map((rule: WireSourceAssignmentRule, index: number): JSX.Element => (
        <RuleCard
          key={`rule-${String(index)}`}
          index={index}
          rule={rule}
          onChange={(next): void => {
            replace(index, next);
          }}
          onRemove={(): void => {
            write(rules.filter((_entry, position) => position !== index));
          }}
        />
      ))}
    </Panel>
  );
}

function RuleCard({
  index,
  rule,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly rule: WireSourceAssignmentRule;
  readonly onChange: (rule: WireSourceAssignmentRule) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const [customKey, setCustomKey] = useState<string>('');
  const scope = SCOPES.find(([value]) => value === rule.scope);

  return (
    <div className="editor-card" data-testid={`assignment-rule-${String(index)}`}>
      <div className="editor-card__head">
        <span className="chain__order">{index + 1}</span>
        <select
          className="control control--select"
          aria-label={`What rule ${String(index + 1)} matches`}
          data-testid={`assignment-scope-${String(index)}`}
          value={rule.scope}
          onChange={(event): void => {
            const next = SCOPES.find(([value]) => value === event.target.value)?.[0];
            if (next !== undefined) {
              // The match text is kept: a person switching from an exact file
              // name to a pattern is usually about to add a `*` to what they
              // already typed, and clearing it would make them type it twice.
              onChange({ ...rule, scope: next });
            }
          }}
        >
          {SCOPES.map(([value, label]): JSX.Element => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          className="button button--quiet button--small"
          type="button"
          data-testid={`assignment-remove-${String(index)}`}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>

      <p className="chain__what">{scope?.[2] ?? ''}</p>

      <Field
        label="Matches"
        what={
          rule.scope === 'filename-pattern'
            ? 'A file name with exactly one *. The * stands for any run of characters, including none, and what it covers becomes $1.'
            : rule.scope === 'logical-source'
              ? "The project's own id for a registered source, exactly."
              : 'The source model file name, exactly.'
        }
        example={
          rule.scope === 'filename-pattern'
            ? 'Dragon-*.nwc against Dragon-Mechanical.nwc captures Mechanical'
            : rule.scope === 'logical-source'
              ? 'model:dragon-controls.matchline-cache'
              : 'Dragon-Mechanical.nwc'
        }
        htmlFor={`assignment-match-${String(index)}`}
      >
        <input
          id={`assignment-match-${String(index)}`}
          className="control control--text"
          type="text"
          data-testid={`assignment-match-${String(index)}`}
          value={rule.match}
          onChange={(event): void => {
            onChange({ ...rule, match: event.target.value });
          }}
        />
      </Field>

      <Field
        label="Then those documents state"
        what="What every object in a matched document is taken to assert, unless the object itself says otherwise. Leave a box blank and the rule says nothing about that field."
        example="Discipline = $1 turns Dragon-Mechanical.nwc into Mechanical"
      >
        <div className="assign-grid">
          <label className="inline-field">
            <span>Building</span>
            <input
              className="control control--text"
              type="text"
              data-testid={`assignment-building-${String(index)}`}
              value={rule.assign.building}
              onChange={(event): void => {
                onChange({
                  ...rule,
                  assign: { ...rule.assign, building: event.target.value },
                });
              }}
            />
          </label>
          <label className="inline-field">
            <span>Discipline</span>
            <input
              className="control control--text"
              type="text"
              data-testid={`assignment-discipline-${String(index)}`}
              value={rule.assign.nativeDiscipline}
              onChange={(event): void => {
                onChange({
                  ...rule,
                  assign: { ...rule.assign, nativeDiscipline: event.target.value },
                });
              }}
            />
          </label>

          {rule.assign.custom.map((entry, position): JSX.Element => (
            <label className="inline-field" key={entry.key}>
              <span>{entry.key}</span>
              <input
                className="control control--text"
                type="text"
                data-testid={`assignment-custom-${String(index)}-${entry.key}`}
                value={entry.value}
                onChange={(event): void => {
                  onChange({
                    ...rule,
                    assign: {
                      ...rule.assign,
                      custom: rule.assign.custom.map((existing, existingPosition) =>
                        existingPosition === position
                          ? { key: existing.key, value: event.target.value }
                          : existing,
                      ),
                    },
                  });
                }}
              />
              <button
                className="button button--quiet button--small"
                type="button"
                aria-label={`Stop assigning ${entry.key}`}
                onClick={(): void => {
                  onChange({
                    ...rule,
                    assign: {
                      ...rule.assign,
                      custom: rule.assign.custom.filter(
                        (_existing, existingPosition) => existingPosition !== position,
                      ),
                    },
                  });
                }}
              >
                Remove
              </button>
            </label>
          ))}
        </div>

        <div className="button-row">
          <input
            className="control control--text"
            type="text"
            placeholder="Another field, e.g. turnover-package"
            aria-label={`New assigned field for rule ${String(index + 1)}`}
            data-testid={`assignment-custom-key-${String(index)}`}
            value={customKey}
            onChange={(event): void => {
              setCustomKey(event.target.value);
            }}
          />
          <button
            className="button button--small"
            type="button"
            data-testid={`assignment-custom-add-${String(index)}`}
            disabled={
              customKey.trim() === '' ||
              rule.assign.custom.some((entry) => entry.key === customKey.trim())
            }
            onClick={(): void => {
              onChange({
                ...rule,
                assign: {
                  ...rule.assign,
                  custom: [...rule.assign.custom, { key: customKey.trim(), value: '' }],
                },
              });
              setCustomKey('');
            }}
          >
            Assign another field
          </button>
        </div>
        <p className="chain__what">
          A field named here is a key a derived attribute can read back with its “value assigned to
          the whole file” source. Standard Building and Discipline do not need one — they are
          already fields.
        </p>
      </Field>

      <AssignmentPreview index={index} rule={rule} />
    </div>
  );
}

/** What the rule as typed would hit, recomputed as it is typed. */
function AssignmentPreview({
  index,
  rule,
}: {
  readonly index: number;
  readonly rule: WireSourceAssignmentRule;
}): JSX.Element {
  const preview = usePreview(
    JSON.stringify(rule),
    async () => (await call(window.matchline.assignment.preview({ rule }))).preview,
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
  if (data.problem !== '') {
    return <Callout tone="warning">{data.problem}</Callout>;
  }

  return (
    <div className="preview-block" data-testid={`assignment-preview-${String(index)}`}>
      <StatRow>
        <Stat label="Documents matched" value={count(data.matches.length)} />
        <Stat
          label="Objects affected"
          value={count(data.matchedObjectCount)}
          hint={`of ${count(data.universeObjectCount)} in the project`}
        />
      </StatRow>

      {data.matches.length === 0 ? (
        <Callout tone="warning">
          Nothing matches. The documents in this project are:{' '}
          {data.candidates.join(', ')}.
        </Callout>
      ) : (
        <>
          <TableScroll>
            <table className="table table--compact table--nowrap">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Document</th>
                  <th className="table__number">Objects</th>
                  {rule.scope === 'filename-pattern' ? <th>$1</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.matches.map((match: WireAssignmentMatch): JSX.Element => (
                  <tr key={`${match.sourceId} ${match.sourceModelFile}`}>
                    <td>{match.label}</td>
                    <td>
                      {match.sourceModelFile === '' ? (
                        <span className="muted">no source model file</span>
                      ) : (
                        match.sourceModelFile
                      )}
                    </td>
                    <td className="table__number">{count(match.objectCount)}</td>
                    {rule.scope === 'filename-pattern' ? (
                      <td className="muted">{match.capture}</td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>

          {data.assigned.length === 0 ? (
            <Callout tone="warning">
              The rule matches, but states nothing. Fill in at least one field above or it will do
              nothing at all.
            </Callout>
          ) : (
            <Callout tone="success">
              Those objects assert{' '}
              {data.assigned.map((value) => `${value.field} = ${value.value}`).join(', ')}.
            </Callout>
          )}
        </>
      )}
    </div>
  );
}
