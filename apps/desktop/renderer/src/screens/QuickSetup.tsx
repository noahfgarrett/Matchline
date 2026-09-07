import { useCallback, useEffect, useState, type JSX } from 'react';

import type {
  WireAnatomyExample,
  WireAssignmentSuggestion,
  WireClassSuggestion,
  WireDerivedAttribute,
  WireDraftPatch,
  WireDraftProfile,
  WireFieldSuggestion,
  WireHierarchyLevel,
  WireHierarchyNote,
  WireHierarchyProjectionLevel,
  WirePropertySuggestion,
  WireQuickSetupSuggestions,
  WireResolverTemplate,
  WireRolePairSuggestion,
  WireSuggestionTarget,
} from '../../../shared/schemas';
import { starterProfile } from '../../../shared/starter-profile';
import { call, count, messageOf, percent } from '../api';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';
import { usePreview } from '../usePreview';

import type { WizardContext } from './Wizard';

/**
 * The Quick Setup path (RELEASE-1.0-PLAN "One-hour UX").
 *
 * One screen per decision, each with a strong data-driven proposal, the
 * evidence behind it, its impact in counts, and one button that accepts it.
 *
 * ## The rule this whole screen exists to obey
 *
 * > never silently published; one-click accept with preview + impact counts
 *
 * Nothing on any step writes to the draft until a person presses Accept. The
 * suggestions arrive from `setup:suggest`, which computes and returns; the
 * checkboxes are local state; Accept is the only thing that calls
 * `profile:update`. A strong suggestion starts ticked and a merely possible one
 * does not — that is the whole of what confidence changes, and neither ever
 * skips the button.
 *
 * ## It writes to the same draft the Advanced screens edit
 *
 * There is no "quick profile" and no second store. Accepting the tag suggestion
 * writes `propertyMappings.equipmentTag`, and screen 3 shows it a moment later
 * with the chain editor open on it. Switching to Advanced at any point keeps
 * everything accepted so far, because there was only ever one draft.
 */

interface QuickStep {
  readonly id: string;
  readonly title: string;
  readonly lede: string;
}

const STEPS: readonly QuickStep[] = [
  {
    id: 'fields',
    title: 'Which property is which',
    lede: 'Matchline read your model and ranked the properties for each field. Untick anything you disagree with — nothing is written until you accept.',
  },
  {
    id: 'anatomy',
    title: 'How your tags decompose',
    lede: 'Inferred from the tags in your model by trying each shape against all of them and keeping the one that split the most.',
  },
  {
    id: 'resolver',
    title: 'Where systems come from',
    lede: 'Six standard arrangements. Pick one and Matchline runs it against your real assets before you accept it.',
  },
  {
    id: 'classes',
    title: 'What counts as equipment',
    lede: 'Which Navisworks classes are commissionable equipment, judged by which ones actually carry equipment tags.',
  },
  {
    id: 'sources',
    title: 'Which building each file is for',
    lede: 'A federation usually says which building a model is for in its file name and nowhere else. These rules read it off, and they only fill a gap — anything an object states itself still wins.',
  },
  {
    id: 'roles',
    title: 'What hangs off what',
    lede: 'Pairings your own model already draws: tagged equipment published inside other tagged equipment. Accepting one teaches the rule, not the individual parents.',
  },
  {
    id: 'hierarchy',
    title: 'How the register is grouped',
    lede: 'The standard commissioning stack, what it would do to your assets, and the one thing about it you have to read before publishing.',
  },
];

export function QuickSetup({
  context,
  onFinished,
  onSwitchToAdvanced,
}: {
  readonly context: WizardContext;
  /** Leaves Quick Setup for the numbered screens, at a chosen screen. */
  readonly onFinished: (screen: number) => void;
  readonly onSwitchToAdvanced: () => void;
}): JSX.Element {
  const [suggestions, setSuggestions] = useState<WireQuickSetupSuggestions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [accepted, setAccepted] = useState<readonly string[]>([]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const data = await call(window.matchline.setup.suggest());
      setSuggestions(data.suggestions);
      setError(null);
    } catch (caught: unknown) {
      setError(messageOf(caught));
    }
  }, []);

  useEffect((): void => {
    void reload();
  }, [reload]);

  const step = STEPS[stepIndex];
  const markAccepted = useCallback(
    (id: string): void => {
      setAccepted((current) => (current.includes(id) ? current : [...current, id]));
    },
    [],
  );

  if (step === undefined) {
    return <p className="callout callout--info">That step does not exist.</p>;
  }

  return (
    <div className="screen screen--split" data-testid="quick-setup">
      <div className="screen__column">
        <header className="screen__header">
          <h1 className="screen__title">Quick Setup — {step.title}</h1>
          <p className="screen__lede">{step.lede}</p>
        </header>

        <ol className="quick-steps" data-testid="quick-steps">
          {STEPS.map((entry: QuickStep, index: number): JSX.Element => (
            <li key={entry.id}>
              <button
                type="button"
                className={`quick-step${index === stepIndex ? ' quick-step--current' : ''}${
                  accepted.includes(entry.id) ? ' quick-step--done' : ''
                }`}
                data-testid={`quick-step-${entry.id}`}
                aria-current={index === stepIndex ? 'step' : undefined}
                onClick={(): void => {
                  setStepIndex(index);
                }}
              >
                <span className="quick-step__number">
                  {accepted.includes(entry.id) ? '✓' : index + 1}
                </span>
                <span className="quick-step__title">{entry.title}</span>
              </button>
            </li>
          ))}
        </ol>

        {error === null ? null : <Callout tone="error">{error}</Callout>}

        {suggestions === null ? (
          <Callout tone="info">Reading your model…</Callout>
        ) : !suggestions.ready ? (
          <Callout tone="warning">{suggestions.blockedReason}</Callout>
        ) : (
          <StepBody
            step={step}
            suggestions={suggestions}
            context={context}
            onAccepted={(): void => {
              markAccepted(step.id);
              // The next step's proposals depend on what was just accepted —
              // the anatomy is inferred from tags the tag mapping produces, and
              // the resolver templates depend on the anatomy — so they are
              // recomputed rather than reused from the first read.
              void reload();
            }}
          />
        )}

        <div className="button-row">
          <button
            className="button button--quiet"
            type="button"
            data-testid="quick-back"
            disabled={stepIndex === 0}
            onClick={(): void => {
              setStepIndex(stepIndex - 1);
            }}
          >
            Back
          </button>
          {stepIndex === STEPS.length - 1 ? (
            <button
              className="button button--primary"
              type="button"
              data-testid="quick-finish"
              onClick={(): void => {
                onFinished(8);
              }}
            >
              Go to Preview and QA
            </button>
          ) : (
            <button
              className="button button--primary"
              type="button"
              data-testid="quick-next"
              onClick={(): void => {
                setStepIndex(stepIndex + 1);
              }}
            >
              Next
            </button>
          )}
          <button
            className="button button--quiet"
            type="button"
            data-testid="quick-to-advanced"
            onClick={onSwitchToAdvanced}
          >
            Switch to the full setup
          </button>
        </div>
      </div>

      <div className="screen__column screen__column--sticky">
        <SoFar context={context} accepted={accepted} />
      </div>
    </div>
  );
}

function StepBody({
  step,
  suggestions,
  context,
  onAccepted,
}: {
  readonly step: QuickStep;
  readonly suggestions: WireQuickSetupSuggestions;
  readonly context: WizardContext;
  readonly onAccepted: () => void;
}): JSX.Element {
  switch (step.id) {
    case 'fields':
      return <FieldsStep suggestions={suggestions} context={context} onAccepted={onAccepted} />;
    case 'anatomy':
      return <AnatomyStep suggestions={suggestions} context={context} onAccepted={onAccepted} />;
    case 'resolver':
      return <ResolverStep suggestions={suggestions} context={context} onAccepted={onAccepted} />;
    case 'classes':
      return <ClassesStep suggestions={suggestions} context={context} onAccepted={onAccepted} />;
    case 'sources':
      return <SourcesStep suggestions={suggestions} context={context} onAccepted={onAccepted} />;
    case 'roles':
      return <RolesStep suggestions={suggestions} context={context} onAccepted={onAccepted} />;
    case 'hierarchy':
      return <HierarchyStep suggestions={suggestions} context={context} onAccepted={onAccepted} />;
    default:
      return <Callout tone="info">That step does not exist.</Callout>;
  }
}

/* ------------------------------------------------------------ step 1: fields */

/** A stable string for one target, for the tick-state map. */
function targetKey(target: WireSuggestionTarget): string {
  switch (target.kind) {
    case 'mapped-field':
      return `mapped:${target.field}`;
    case 'parent-tag':
      return 'parent-tag';
    case 'stable-id':
      return 'stable-id';
    case 'derived-attribute':
      return `derived:${target.attributeId}`;
    default: {
      const exhaustive: never = target;
      throw new Error(`Unhandled target: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * One patch that applies every ticked suggestion at once.
 *
 * Built from the draft as it stands, because the updater runs against whatever
 * main currently holds — the same rule every other screen's writes follow.
 */
function patchForFields(
  draft: WireDraftProfile,
  chosen: ReadonlyMap<string, { readonly field: WireFieldSuggestion; readonly candidate: WirePropertySuggestion }>,
): WireDraftPatch {
  const mappings = { ...draft.propertyMappings };
  const derived: WireDerivedAttribute[] = [...draft.derivedAttributes];
  let parentTagProperty = draft.parentTagProperty;
  let stableIdProperty = draft.stableIdProperty;

  for (const { field, candidate } of chosen.values()) {
    const target = field.target;
    switch (target.kind) {
      case 'mapped-field':
        // The accepted property becomes the FIRST rung, and any chain the draft
        // already carried is kept behind it: Quick Setup proposes a starting
        // point, and silently discarding an address somebody already wrote down
        // would be the opposite of that.
        mappings[target.field] = {
          chain: [
            candidate.property,
            ...mappings[target.field].chain.filter(
              (ref) =>
                ref.category !== candidate.property.category ||
                ref.name !== candidate.property.name,
            ),
          ],
          bySource: mappings[target.field].bySource,
        };
        break;
      case 'parent-tag':
        parentTagProperty = candidate.property;
        break;
      case 'stable-id':
        stableIdProperty = candidate.property;
        break;
      case 'derived-attribute': {
        const definition: WireDerivedAttribute = {
          attributeId: target.attributeId,
          displayName: field.label,
          resolverChain: [{ kind: 'model-property', chain: [candidate.property] }],
        };
        const existing = derived.findIndex(
          (entry) => entry.attributeId === target.attributeId,
        );
        if (existing === -1) {
          derived.push(definition);
        } else {
          derived[existing] = definition;
        }
        break;
      }
      default: {
        const exhaustive: never = target;
        throw new Error(`Unhandled target: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return {
    // The starter rule set, merged on the first thing anybody accepts. It is
    // three decisions a fast setup is entitled to make on a site's behalf
    // (identity normalization, the full ladder) and nothing about what this
    // site calls things — `starterProfile` states why, and a project that never
    // enters Quick Setup never sees it.
    ...starterProfile(),
    propertyMappings: mappings,
    derivedAttributes: derived,
    parentTagProperty,
    stableIdProperty,
  };
}

function FieldsStep({
  suggestions,
  context,
  onAccepted,
}: {
  readonly suggestions: WireQuickSetupSuggestions;
  readonly context: WizardContext;
  readonly onAccepted: () => void;
}): JSX.Element {
  /** Ticked targets -> the candidate index chosen for each. */
  const [choices, setChoices] = useState<ReadonlyMap<string, number>>(
    () =>
      new Map(
        suggestions.fields
          .filter((field) => field.confidence === 'strong' && field.candidates.length > 0)
          .map((field) => [targetKey(field.target), 0] as const),
      ),
  );

  const chosen = new Map<
    string,
    { readonly field: WireFieldSuggestion; readonly candidate: WirePropertySuggestion }
  >();
  for (const field of suggestions.fields) {
    const index = choices.get(targetKey(field.target));
    const candidate = index === undefined ? undefined : field.candidates[index];
    if (candidate !== undefined) {
      chosen.set(targetKey(field.target), { field, candidate });
    }
  }

  // The impact of THIS step is the tag: every other mapping decorates an asset,
  // and the tag is what decides whether there is one.
  const tagImpact =
    chosen.get(
      targetKey({ kind: 'mapped-field', field: 'equipmentTag' }),
    )?.candidate ?? null;

  return (
    <>
      {suggestions.fields.length === 0 ? (
        <Callout tone="warning">
          Nothing in this model looks like an equipment tag, a description or a building. Use the
          full setup — screen 3 lists every property with its coverage.
        </Callout>
      ) : null}

      {suggestions.fields.map((field: WireFieldSuggestion): JSX.Element => {
        const key = targetKey(field.target);
        const chosenIndex = choices.get(key);
        return (
          <Panel
            key={key}
            title={field.label}
            description={field.what}
            actions={
              <span
                className={`badge badge--${field.confidence}`}
                data-testid={`quick-confidence-${key}`}
              >
                {field.confidence === 'strong' ? 'Clear winner' : 'Your call'}
              </span>
            }
          >
            {field.candidates.length === 0 ? (
              <Callout tone="info">
                No property in this model looks like it. Leave it — {field.example} is what it
                would hold, and you can map it later on the full screens.
              </Callout>
            ) : (
              <div className="candidate-list" data-testid={`quick-candidates-${key}`}>
                <label className="candidate">
                  <input
                    type="radio"
                    name={`quick-${key}`}
                    checked={chosenIndex === undefined}
                    onChange={(): void => {
                      const next = new Map(choices);
                      next.delete(key);
                      setChoices(next);
                    }}
                  />
                  <span className="candidate__body">
                    <span className="candidate__name">Leave this one to me</span>
                    <span className="candidate__why">
                      Nothing is written for this field. You can set it on the full screens.
                    </span>
                  </span>
                </label>

                {field.candidates.map(
                  (candidate: WirePropertySuggestion, index: number): JSX.Element => (
                    <label
                      className={`candidate${chosenIndex === index ? ' candidate--chosen' : ''}`}
                      key={`${candidate.property.category} ${candidate.property.name}`}
                    >
                      <input
                        type="radio"
                        name={`quick-${key}`}
                        data-testid={`quick-pick-${key}-${String(index)}`}
                        checked={chosenIndex === index}
                        onChange={(): void => {
                          const next = new Map(choices);
                          next.set(key, index);
                          setChoices(next);
                        }}
                      />
                      <span className="candidate__body">
                        <span className="candidate__name">
                          {candidate.property.category} &gt; {candidate.property.name}
                        </span>
                        <span className="candidate__why">{candidate.reasons.join(' · ')}</span>
                        {candidate.examples.length === 0 ? null : (
                          <span className="candidate__examples">
                            e.g. {candidate.examples.join(', ')}
                          </span>
                        )}
                      </span>
                    </label>
                  ),
                )}
              </div>
            )}
          </Panel>
        );
      })}

      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          data-testid="quick-accept-fields"
          disabled={chosen.size === 0}
          onClick={(): void => {
            void context
              .update((draft) => patchForFields(draft, chosen))
              .then(onAccepted, onAccepted);
          }}
        >
          Accept {count(chosen.size)} {chosen.size === 1 ? 'mapping' : 'mappings'}
          {tagImpact === null
            ? ''
            : ` — ${count(tagImpact.objectCount)} of ${count(suggestions.objectCount)} objects carry that tag`}
        </button>
      </div>
    </>
  );
}

/* ----------------------------------------------------------- step 2: anatomy */

function AnatomyStep({
  suggestions,
  context,
  onAccepted,
}: {
  readonly suggestions: WireQuickSetupSuggestions;
  readonly context: WizardContext;
  readonly onAccepted: () => void;
}): JSX.Element {
  const anatomy = suggestions.anatomy;
  if (anatomy === null) {
    return (
      <Callout tone="warning">
        Matchline could not infer a tag shape. Either no equipment tag property has been accepted
        yet, or these tags are one undivided token with nothing to split on. Screen 4 of the full
        setup teaches one by hand.
      </Callout>
    );
  }

  return (
    <>
      <Panel title="The shape Matchline inferred" description={anatomy.rationale}>
        <StatRow>
          <Stat
            label="Tags it splits"
            value={percent(anatomy.coverage)}
            hint={`${count(anatomy.matchedCount)} of ${count(anatomy.totalCount)}`}
          />
          <Stat label="Separators" value={anatomy.anatomy.separators.join(' ')} />
          <Stat label="Segments taught" value={count(anatomy.anatomy.segments.length)} />
        </StatRow>

        <TableScroll>
          <table className="table table--compact" data-testid="quick-anatomy-examples">
            <thead>
              <tr>
                <th>Tag</th>
                {anatomy.anatomy.segments.map((row): JSX.Element => (
                  <th key={row.segment}>{row.segment}</th>
                ))}
                <th>Family key</th>
              </tr>
            </thead>
            <tbody>
              {anatomy.examples.map((example: WireAnatomyExample): JSX.Element => (
                <tr key={example.tag}>
                  <td>{example.tag}</td>
                  {example.segments.map((segment): JSX.Element => (
                    <td key={segment.segment}>
                      {segment.value ?? <span className="muted">—</span>}
                    </td>
                  ))}
                  <td className="muted">{example.familyKey}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>

        <TableScroll>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>Segment</th>
                <th className="table__number">Distinct values</th>
              </tr>
            </thead>
            <tbody>
              {anatomy.segmentStats.map((stat): JSX.Element => (
                <tr key={stat.segment}>
                  <td>{stat.segment}</td>
                  <td className="table__number">{count(stat.distinctValueCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>

        {anatomy.coverage < 0.9 ? (
          <Callout tone="warning">
            {percent(1 - anatomy.coverage)} of tags do not fit this shape. Accepting is still
            reasonable — screen 4 shows every tag that missed and why — but a site with two tag
            conventions usually needs a hand-taught anatomy.
          </Callout>
        ) : null}
      </Panel>

      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          data-testid="quick-accept-anatomy"
          onClick={(): void => {
            void context
              .update((): WireDraftPatch => ({ tagAnatomy: anatomy.anatomy }))
              .then(onAccepted, onAccepted);
          }}
        >
          Accept this tag shape — it splits {count(anatomy.matchedCount)} of{' '}
          {count(anatomy.totalCount)} tags
        </button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------- step 3: resolver */

function ResolverStep({
  suggestions,
  context,
  onAccepted,
}: {
  readonly suggestions: WireQuickSetupSuggestions;
  readonly context: WizardContext;
  readonly onAccepted: () => void;
}): JSX.Element {
  const templates = suggestions.resolverTemplates;
  const [selected, setSelected] = useState<string>(
    () => templates.find((template) => template.available)?.templateId ?? '',
  );
  const chosen = templates.find((template) => template.templateId === selected) ?? null;

  const preview = usePreview(
    JSON.stringify(chosen?.resolver ?? null),
    async () =>
      chosen === null
        ? null
        : (await call(window.matchline.setup.resolverPreview({ resolver: chosen.resolver })))
            .preview,
  );

  return (
    <>
      <Panel title="Pick an arrangement" description="Greyed ones need something this project does not have yet.">
        <div className="candidate-list" data-testid="quick-templates">
          {templates.map((template: WireResolverTemplate): JSX.Element => (
            <label
              className={`candidate${selected === template.templateId ? ' candidate--chosen' : ''}${
                template.available ? '' : ' candidate--unavailable'
              }`}
              key={template.templateId}
            >
              <input
                type="radio"
                name="quick-resolver"
                data-testid={`quick-template-${template.templateId}`}
                checked={selected === template.templateId}
                disabled={!template.available}
                onChange={(): void => {
                  setSelected(template.templateId);
                }}
              />
              <span className="candidate__body">
                <span className="candidate__name">{template.label}</span>
                <span className="candidate__why">{template.what}</span>
                <span className="candidate__examples">e.g. {template.example}</span>
                {template.impact === '' ? null : (
                  <span className="candidate__why" data-testid={`quick-template-impact-${template.templateId}`}>
                    {template.impact}
                  </span>
                )}
                {template.available ? null : (
                  <span className="candidate__blocked">{template.unavailableReason}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      </Panel>

      <Panel title="What it would resolve" description="Run against this project's real assets. Nothing is saved.">
        {preview.status === 'failed' ? <Callout tone="error">{preview.error}</Callout> : null}
        {preview.data === null || preview.data === undefined ? (
          <Callout tone="info">Working it out…</Callout>
        ) : preview.data.state === 'blocked' ? (
          <Callout tone="info">{preview.data.reason}</Callout>
        ) : (
          <div data-testid="quick-resolver-preview">
            <StatRow>
              <Stat
                label="Assets with a system"
                value={percent(preview.data.coverage)}
                hint={`${count(preview.data.resolvedCount)} of ${count(preview.data.subjectCount)}`}
              />
              <Stat label="Distinct systems" value={count(preview.data.distinctSystemCount)} />
              <Stat label="With a description" value={count(preview.data.describedCount)} />
              <Stat label="Disagreements" value={count(preview.data.conflictCount)} />
            </StatRow>

            <TableScroll>
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>Tag</th>
                    <th>Key</th>
                    <th>Label</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.data.samples.map((sample): JSX.Element => (
                    <tr key={sample.assetId}>
                      <td>{sample.canonicalTag}</td>
                      <td>{sample.systemKey}</td>
                      <td>{sample.systemLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
        )}
      </Panel>

      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          data-testid="quick-accept-resolver"
          disabled={chosen === null}
          onClick={(): void => {
            if (chosen === null) {
              return;
            }
            void context
              .update((): WireDraftPatch => ({ systemResolver: chosen.resolver }))
              .then(onAccepted, onAccepted);
          }}
        >
          Accept this arrangement
          {preview.data === null || preview.data === undefined || preview.data.state !== 'ready'
            ? ''
            : ` — ${count(preview.data.resolvedCount)} of ${count(
                preview.data.subjectCount,
              )} assets get a system, in ${count(preview.data.distinctSystemCount)} systems`}
        </button>
      </div>
    </>
  );
}

/* ----------------------------------------------------------- step 4: classes */

function ClassesStep({
  suggestions,
  context,
  onAccepted,
}: {
  readonly suggestions: WireQuickSetupSuggestions;
  readonly context: WizardContext;
  readonly onAccepted: () => void;
}): JSX.Element {
  const [accepting, setAccepting] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        suggestions.classes
          .filter((entry) => entry.proposal !== 'leave')
          .map((entry) => entry.className),
      ),
  );

  const included = suggestions.classes.filter(
    (entry) => entry.proposal === 'include' && accepting.has(entry.className),
  );
  const excluded = suggestions.classes.filter(
    (entry) => entry.proposal === 'exclude' && accepting.has(entry.className),
  );
  const removedObjects = excluded.reduce((total, entry) => total + entry.objectCount, 0);
  const keptObjects = included.reduce((total, entry) => total + entry.objectCount, 0);

  return (
    <>
      <Panel
        title="Classes, and how many of each carry a tag"
        description="A class whose objects all carry equipment tags is equipment. One whose objects never do is geometry."
      >
        {suggestions.classes.length === 0 ? (
          <Callout tone="info">
            This extraction records no Navisworks class names, so there is nothing to include or
            exclude by class.
          </Callout>
        ) : (
          <TableScroll>
            <table className="table table--compact" data-testid="quick-classes">
              <thead>
                <tr>
                  <th>Accept</th>
                  <th>Class</th>
                  <th className="table__number">Objects</th>
                  <th className="table__number">Tagged</th>
                  <th>Proposal</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.classes.map((entry: WireClassSuggestion): JSX.Element => (
                  <tr key={entry.className}>
                    <td className="table__number">
                      <input
                        type="checkbox"
                        aria-label={`Accept the proposal for ${entry.className}`}
                        data-testid={`quick-class-${entry.className}`}
                        disabled={entry.proposal === 'leave'}
                        checked={accepting.has(entry.className)}
                        onChange={(): void => {
                          const next = new Set(accepting);
                          if (next.has(entry.className)) {
                            next.delete(entry.className);
                          } else {
                            next.add(entry.className);
                          }
                          setAccepting(next);
                        }}
                      />
                    </td>
                    <td>{entry.className}</td>
                    <td className="table__number">{count(entry.objectCount)}</td>
                    <td className="table__number">{count(entry.taggedCount)}</td>
                    <td className="muted">
                      {entry.proposal === 'include'
                        ? 'Equipment'
                        : entry.proposal === 'exclude'
                          ? 'Not equipment'
                          : 'Leave it to you'}
                      {' — '}
                      {entry.why}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <Callout tone="info">
          Accepting this puts {count(included.length)} classes on the include list ({count(keptObjects)}{' '}
          objects) and {count(excluded.length)} on the exclude list ({count(removedObjects)} objects
          leave the running).
        </Callout>
      </Panel>

      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          data-testid="quick-accept-classes"
          disabled={included.length === 0 && excluded.length === 0}
          onClick={(): void => {
            void context
              .update(
                (draft): WireDraftPatch => ({
                  assetFilters: {
                    ...draft.assetFilters,
                    includedClasses: [...included.map((entry) => entry.className)].sort(),
                    excludedClasses: [...excluded.map((entry) => entry.className)].sort(),
                  },
                }),
              )
              .then(onAccepted, onAccepted);
          }}
        >
          Accept these class lists — {count(keptObjects)} objects stay,{' '}
          {count(removedObjects)} leave
        </button>
      </div>
    </>
  );
}

/* --------------------------------------------------- step 5: source assignments */

function SourcesStep({
  suggestions,
  context,
  onAccepted,
}: {
  readonly suggestions: WireQuickSetupSuggestions;
  readonly context: WizardContext;
  readonly onAccepted: () => void;
}): JSX.Element {
  const [accepting, setAccepting] = useState<ReadonlySet<string>>(
    () => new Set(suggestions.sourceAssignments.map((entry) => entry.rule.match)),
  );
  const chosen = suggestions.sourceAssignments.filter((entry) =>
    accepting.has(entry.rule.match),
  );
  const objects = chosen.reduce((total, entry) => total + entry.matchedObjectCount, 0);

  if (suggestions.sourceAssignments.length === 0) {
    return (
      <Callout tone="info">
        Nothing to propose here. Either these file names carry no building code, or the rules are
        already in your profile. Screen 6 of the full setup writes them by hand — and if an object
        property already states the building, you do not need a rule at all.
      </Callout>
    );
  }

  return (
    <>
      <Panel
        title="Rules read off the file names"
        description="A rule only fills a gap. Anything an object states for itself still wins, every time."
      >
        <TableScroll>
          <table className="table table--compact" data-testid="quick-assignments">
            <thead>
              <tr>
                <th>Accept</th>
                <th>Pattern</th>
                <th>Assigns</th>
                <th className="table__number">Files</th>
                <th className="table__number">Objects</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.sourceAssignments.map((entry: WireAssignmentSuggestion): JSX.Element => (
                <tr key={entry.rule.match}>
                  <td className="table__number">
                    <input
                      type="checkbox"
                      aria-label={`Accept the rule for ${entry.rule.match}`}
                      data-testid={`quick-assignment-${entry.rule.match}`}
                      checked={accepting.has(entry.rule.match)}
                      onChange={(): void => {
                        const next = new Set(accepting);
                        if (next.has(entry.rule.match)) {
                          next.delete(entry.rule.match);
                        } else {
                          next.add(entry.rule.match);
                        }
                        setAccepting(next);
                      }}
                    />
                  </td>
                  <td>{entry.rule.match}</td>
                  <td>
                    Building = {entry.rule.assign.building}
                    <span className="candidate__why"> {entry.why}</span>
                  </td>
                  <td className="table__number">{count(entry.matchedFileCount)}</td>
                  <td className="table__number">{count(entry.matchedObjectCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>

      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          data-testid="quick-accept-sources"
          disabled={chosen.length === 0}
          onClick={(): void => {
            void context
              .update(
                (draft): WireDraftPatch => ({
                  sourceAssignments: [
                    ...draft.sourceAssignments,
                    ...chosen.map((entry) => entry.rule),
                  ],
                }),
              )
              .then(onAccepted, onAccepted);
          }}
        >
          Accept {count(chosen.length)} {chosen.length === 1 ? 'rule' : 'rules'} —{' '}
          {count(objects)} of {count(suggestions.objectCount)} objects get a building
        </button>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- step 6: roles */

function RolesStep({
  suggestions,
  context,
  onAccepted,
}: {
  readonly suggestions: WireQuickSetupSuggestions;
  readonly context: WizardContext;
  readonly onAccepted: () => void;
}): JSX.Element {
  const pairKey = (pair: WireRolePairSuggestion): string =>
    `${pair.parentRole} ${pair.childRole}`;
  const [accepting, setAccepting] = useState<ReadonlySet<string>>(
    () => new Set(suggestions.rolePairs.map(pairKey)),
  );
  const chosen = suggestions.rolePairs.filter((pair) => accepting.has(pairKey(pair)));
  const nestings = chosen.reduce((total, pair) => total + pair.count, 0);

  if (suggestions.rolePairs.length === 0) {
    return (
      <Callout tone="info">
        Nothing to propose here. Either no tag shape has been accepted yet — the roles come from
        it — or this model never publishes tagged equipment inside other tagged equipment, which is
        ordinary. Screen 7 of the full setup teaches pairings by hand.
      </Callout>
    );
  }

  return (
    <>
      <Panel
        title="Pairings your model already draws"
        description="Counted off the model tree. Accepting one teaches the RULE — that this kind of thing hangs off that kind of thing — and the ladder still decides each individual parent."
      >
        <TableScroll>
          <table className="table table--compact" data-testid="quick-role-pairs">
            <thead>
              <tr>
                <th>Accept</th>
                <th>Parent role</th>
                <th>Child role</th>
                <th className="table__number">Times drawn</th>
                <th>For example</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.rolePairs.map((pair: WireRolePairSuggestion): JSX.Element => (
                <tr key={pairKey(pair)}>
                  <td className="table__number">
                    <input
                      type="checkbox"
                      aria-label={`Accept ${pair.parentRole} to ${pair.childRole}`}
                      data-testid={`quick-role-${pair.parentRole}-${pair.childRole}`}
                      checked={accepting.has(pairKey(pair))}
                      onChange={(): void => {
                        const next = new Set(accepting);
                        if (next.has(pairKey(pair))) {
                          next.delete(pairKey(pair));
                        } else {
                          next.add(pairKey(pair));
                        }
                        setAccepting(next);
                      }}
                    />
                  </td>
                  <td>{pair.parentRole}</td>
                  <td>{pair.childRole}</td>
                  <td className="table__number">{count(pair.count)}</td>
                  <td className="muted">{pair.examples.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>

      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          data-testid="quick-accept-roles"
          disabled={chosen.length === 0}
          onClick={(): void => {
            void context
              .update(
                (draft): WireDraftPatch =>
                  starterProfile([
                    ...draft.roleGraph.rules,
                    ...chosen.map((pair) => ({
                      parentRole: pair.parentRole,
                      childRole: pair.childRole,
                    })),
                  ]),
              )
              .then(onAccepted, onAccepted);
          }}
        >
          Accept {count(chosen.length)} {chosen.length === 1 ? 'pairing' : 'pairings'} —{' '}
          {count(nestings)} nestings this model already draws
        </button>
      </div>
    </>
  );
}

/* --------------------------------------------------------- step 7: hierarchy */

function HierarchyStep({
  suggestions,
  context,
  onAccepted,
}: {
  readonly suggestions: WireQuickSetupSuggestions;
  readonly context: WizardContext;
  readonly onAccepted: () => void;
}): JSX.Element {
  const [confirmed, setConfirmed] = useState<boolean>(false);
  const levels = suggestions.hierarchy.levels;
  const boundaries = levels.filter((level) => level.boundary);
  const projection = suggestions.hierarchyProjection;
  const projected =
    projection.state === 'ready'
      ? new Map(projection.levels.map((level) => [level.levelId, level] as const))
      : new Map<string, WireHierarchyProjectionLevel>();

  /** The sentence the Accept button carries — the whole point of this step. */
  const impact = ((): string => {
    if (projection.state !== 'ready') {
      return '';
    }
    const parts = projection.levels
      .filter((level) => level.boundary)
      .map(
        (level) =>
          `${count(level.distinctValueCount)} ${level.displayName.toLowerCase()} groups` +
          (level.assetsWithoutValue === 0
            ? ''
            : `, ${count(level.assetsWithoutValue)} without one`),
      );
    return ` — ${count(projection.assetCount)} assets in ${
      parts.length === 0 ? 'no structural levels' : parts.join('; ')
    }`;
  })();

  return (
    <>
      <Panel
        title="The standard commissioning stack"
        description="Building, then SSM Discipline, then System — and what each one would do to the assets you have right now."
      >
        <TableScroll>
          <table className="table table--compact" data-testid="quick-hierarchy">
            <thead>
              <tr>
                <th>Level</th>
                <th>Grouped by</th>
                <th>Structural?</th>
                <th className="table__number">Groups</th>
                <th className="table__number">Assets with no value</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((level: WireHierarchyLevel): JSX.Element => {
                const measured = projected.get(level.levelId);
                return (
                  <tr key={level.levelId}>
                    <td>{level.displayName}</td>
                    <td className="muted">{level.attributeKey}</td>
                    <td>
                      {level.boundary
                        ? 'Yes — equipment cannot nest across it'
                        : 'No — a grouping only'}
                    </td>
                    <td className="table__number">
                      {measured === undefined ? (
                        <span className="muted">—</span>
                      ) : (
                        count(measured.distinctValueCount)
                      )}
                    </td>
                    <td className="table__number">
                      {measured === undefined ? (
                        <span className="muted">—</span>
                      ) : (
                        count(measured.assetsWithoutValue)
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>

        {projection.state === 'blocked' ? (
          <Callout tone="info">{projection.reason}</Callout>
        ) : null}

        {/* Why a boundary flag is on or off, in this project's own numbers. The
            audit's B3 is precisely this sentence never being written: a stack
            whose top level nobody can state compiles into a flat list of roots,
            and nothing said so until after the publish. */}
        {suggestions.hierarchyNotes.map((note: WireHierarchyNote): JSX.Element => (
          <Callout key={note.levelId} tone={note.kept ? 'info' : 'warning'}>
            {note.note}
          </Callout>
        ))}

        {/* The P0-5 confirmation, inline. Screen 9 asks it again before a
            revision is saved; asking it here as well is deliberate, because
            Quick Setup's whole promise is that a person who takes the fast path
            still reads the one thing that changes what nests under what. */}
        <Callout tone="warning">
          Building and System are structural: a parent on the other side of either is removed from
          the chain and listed as a dependency instead. SSM Discipline is deliberately not — a
          startup family is a mechanical unit, its controls panel, its drive and its instrument,
          and making discipline structural would cut that one family into four roots.
        </Callout>

        <label className="toggle" data-testid="quick-hierarchy-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event): void => {
              setConfirmed(event.target.checked);
            }}
          />
          <span>
            I have read what {count(boundaries.length)} structural levels do to parentage
            <span className="toggle__what">
              A cross-boundary parent stays real — it becomes a dependency, and the physical chain
              stays whole in Electrical Flow.
            </span>
          </span>
        </label>
      </Panel>

      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          data-testid="quick-accept-hierarchy"
          disabled={!confirmed}
          onClick={(): void => {
            void context
              .update((): WireDraftPatch => ({ hierarchy: suggestions.hierarchy }))
              .then(onAccepted, onAccepted);
          }}
        >
          Accept this stack{impact}
        </button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------- the right column */

/** What the draft actually holds now, recomputed after every acceptance. */
function SoFar({
  context,
  accepted,
}: {
  readonly context: WizardContext;
  readonly accepted: readonly string[];
}): JSX.Element {
  const draft = context.draft;
  const preview = usePreview(
    JSON.stringify([draft.propertyMappings, draft.assetFilters, accepted]),
    async () => (await call(window.matchline.asset.preview())).preview,
  );

  return (
    <Panel title="What you have so far" description="Read back out of the draft, not out of the suggestions.">
      <TableScroll>
        <table className="table table--compact" data-testid="quick-so-far">
          <tbody>
            <tr>
              <td>Equipment tag</td>
              <td>
                {draft.propertyMappings.equipmentTag.chain[0] === undefined ? (
                  <span className="muted">not chosen</span>
                ) : (
                  `${draft.propertyMappings.equipmentTag.chain[0].category} > ${draft.propertyMappings.equipmentTag.chain[0].name}`
                )}
              </td>
            </tr>
            <tr>
              <td>Tag anatomy</td>
              <td>
                {draft.tagAnatomy.segments.length === 0 ? (
                  <span className="muted">not taught</span>
                ) : (
                  `${count(draft.tagAnatomy.segments.length)} segments`
                )}
              </td>
            </tr>
            <tr>
              <td>System Resolver</td>
              <td>
                {draft.systemResolver.keyChain.length === 0 ? (
                  <span className="muted">not configured</span>
                ) : (
                  `${count(draft.systemResolver.keyChain.length)} key sources`
                )}
              </td>
            </tr>
            <tr>
              <td>Fields of your own</td>
              <td>
                {draft.derivedAttributes.length === 0 ? (
                  <span className="muted">none</span>
                ) : (
                  draft.derivedAttributes.map((entry) => entry.displayName).join(', ')
                )}
              </td>
            </tr>
            <tr>
              <td>Levels</td>
              <td>{draft.hierarchy.levels.map((level) => level.displayName).join(' / ')}</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>

      {preview.data === null ? (
        <Callout tone="info">Working it out…</Callout>
      ) : preview.data.state === 'blocked' ? (
        <Callout tone="info">{preview.data.reason}</Callout>
      ) : (
        <StatRow>
          <Stat label="Objects in model" value={count(preview.data.totalObjects)} />
          <Stat label="Assets" value={count(preview.data.finalAssetCount)} />
          <Stat label="Duplicate tags" value={count(preview.data.duplicateTagCount)} />
        </StatRow>
      )}

      <Callout tone="info">
        Everything accepted here lands in the same profile the numbered screens edit. Switching to
        the full setup keeps all of it.
      </Callout>
    </Panel>
  );
}
