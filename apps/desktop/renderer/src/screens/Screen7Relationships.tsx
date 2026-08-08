import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';

import type {
  WireDisciplineRewrite,
  WireLadderSource,
  WireLearnedGrade,
  WireLearnedRuleKind,
  WireLearnedSummary,
  WireRoleRule,
} from '../../../shared/schemas';
import { call, count, messageOf, percent } from '../api';
import { Field } from '../components/Field';
import { Callout, Panel, Stat, StatRow, TableScroll } from '../components/Panel';
import { PropertyPicker } from '../components/PropertyPicker';
import { SortableList } from '../components/Sortable';

import type { WizardContext } from './Wizard';

/**
 * Screen 7 — Relationship rules (PRODUCT.md §7, §11.1, §11.2, §11.4).
 *
 * Everything on this screen feeds one question: when two assets could be
 * parent and child, which evidence decides it? The ladder is the order that
 * evidence is trusted in; the role graph is what makes family evidence
 * possible at all; the projection decides which discipline the register files
 * things under; and learned rules are the site's own history, admitted only
 * after it has proven itself.
 */

const LADDER_RUNGS: ReadonlyArray<
  readonly [WireLadderSource, string, string]
> = [
  ['manual', 'Somebody said so', 'A parent a person set by hand. Always wins, and it is kept even across a boundary.'],
  ['explicit-model', 'The model says so', 'A model property naming the parent outright. Needs the property mapped below.'],
  ['profile-lookup', 'An accepted lookup table', 'Parent/child pairs this site wrote down and accepted.'],
  ['flow-family', 'Connected and same family', 'The two are electrically connected and share a tag family, with compatible roles.'],
  ['family-role', 'Same family', 'Same tag family and compatible roles, with no connectivity evidence.'],
  ['learned-description', 'Learned from descriptions', 'Trained below. Only classes that graded at 85% precision or better reach this rung.'],
  ['prior-ssm', 'A previous SSM did it', 'What the last accepted register did. Evidence, not a rule.'],
  ['model-tree', 'The model tree', 'The extraction cache’s own parent/child nesting. The weakest evidence there is.'],
];

const ALL_RUNGS: readonly WireLadderSource[] = LADDER_RUNGS.map(([kind]) => kind);

export function Screen7Relationships({
  context,
}: {
  readonly context: WizardContext;
}): JSX.Element {
  const [roles, setRoles] = useState<readonly string[]>([]);
  const [disciplines, setDisciplines] = useState<readonly string[]>([]);
  const [learned, setLearned] = useState<readonly WireLearnedSummary[]>([]);
  const [training, setTraining] = useState<WireLearnedRuleKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const config = context.config;

  const refreshLearned = useCallback(async (): Promise<void> => {
    const data = await call(window.matchline.learned.list());
    setLearned(data.summaries);
  }, []);

  useEffect((): (() => void) => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const [roleData, disciplineData] = await Promise.all([
          call(window.matchline.config.roles()),
          call(window.matchline.config.disciplines()),
        ]);
        if (cancelled) {
          return;
        }
        setRoles(roleData.roles);
        setDisciplines(disciplineData.disciplines);
        await refreshLearned();
      } catch (caught: unknown) {
        if (!cancelled) {
          setError(messageOf(caught));
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [refreshLearned]);

  const trainFrom = async (kind: WireLearnedRuleKind): Promise<void> => {
    setError(null);
    try {
      const picked = await call(
        window.matchline.dialog.openFile({
          filters: [{ name: 'Finished SSM or registry export', extensions: ['xlsx', 'xlsm'] }],
        }),
      );
      if (picked.cancelled) {
        return;
      }
      setTraining(kind);
      await call(window.matchline.learned.train({ kind, path: picked.path }));
      await refreshLearned();
    } catch (caught: unknown) {
      setError(messageOf(caught));
    } finally {
      setTraining(null);
    }
  };

  const nesting = learned.find((summary) => summary.kind === 'nesting') ?? null;
  const itemMaster = learned.find((summary) => summary.kind === 'item-master') ?? null;

  return (
    <div className="screen" data-testid="screen-7">
      <header className="screen__header">
        <h1 className="screen__title">7. Relationship rules</h1>
        <p className="screen__lede">
          What may parent what, and which evidence to believe when several answers compete.
          Matchline walks the ladder from the top and stops at the first rung that gives one
          clear answer — a rung that offers two is a tie, and a tie stops the walk rather than
          falling through to something weaker.
        </p>
      </header>

      {error === null ? null : <Callout tone="error">{error}</Callout>}

      <Panel
        title="Which roles may parent which"
        description="Roles come from the tag anatomy you taught on screen 4. Rules are one-way: MAH parents PLC does not let a PLC parent a MAH."
      >
        <RoleGraphEditor
          rules={config.roleGraph.rules}
          roles={roles}
          onChange={(rules): void => {
            void context.updateConfig({ roleGraph: { rules: [...rules] } });
          }}
        />
      </Panel>

      <Panel
        title="Parent ladder"
        description="Strongest evidence at the top. Drag to reorder; clear a rung to switch it off entirely."
      >
        <LadderEditor
          tiers={config.ladder.tiers}
          onChange={(tiers): void => {
            void context.updateConfig({ ladder: { tiers: [...tiers] } });
          }}
        />
      </Panel>

      <Panel
        title="Commissioning discipline"
        description="The model’s discipline and the discipline a register hands over by are two different things (PRODUCT.md §11.4)."
      >
        <Field
          label="Discipline rewrites"
          what="Rewrites the model's own discipline into the one the commissioning register groups by. A discipline with no row keeps its own spelling."
          example="I&C becomes Mechanical, so a PLC files under the Mechanical Dry branch it is commissioned with"
        >
          <ProjectionEditor
            rewrites={config.ssmDisciplineProjection}
            disciplines={disciplines}
            onChange={(rewrites): void => {
              void context.updateConfig({ ssmDisciplineProjection: [...rewrites] });
            }}
          />
        </Field>

        <Field
          label="Model property naming the parent"
          what="When the model states parentage outright, map that property here and it becomes the second-strongest rung on the ladder."
          example="Assembly > Parent Tag holding MAH001-10-01 on every component of that unit"
        >
          <PropertyPicker
            id="parent-tag-property"
            properties={context.properties}
            value={config.parentTagProperty}
            noneLabel="Not mapped — infer parentage instead"
            onChange={(ref): void => {
              void context.updateConfig({ parentTagProperty: ref });
            }}
          />
        </Field>
      </Panel>

      <Panel
        title="Learn from a finished register"
        description="Point Matchline at a previous SSM or an item-master registry. It trains, then grades itself against that file's own answers."
        actions={
          <>
            <button
              className="button button--small"
              type="button"
              data-testid="train-nesting"
              disabled={training !== null}
              onClick={(): void => {
                void trainFrom('nesting');
              }}
            >
              {training === 'nesting' ? 'Training…' : 'Train nesting rules'}
            </button>
            <button
              className="button button--small"
              type="button"
              data-testid="train-item-master"
              disabled={training !== null}
              onClick={(): void => {
                void trainFrom('item-master');
              }}
            >
              {training === 'item-master' ? 'Training…' : 'Train item masters'}
            </button>
          </>
        }
      >
        <Callout tone="info">
          A learned rule only builds hierarchy after it has proven itself: 85% precision or
          better over at least 10 predictions, measured by replaying the shipping policy against
          the register you supply. Everything below that becomes a review proposal and never
          moves a piece of equipment on its own.
        </Callout>

        <LearnedPanel
          title="Nesting rules"
          summary={nesting}
          empty="Nothing trained. The learned-description rung on the ladder above produces nothing until it is."
        />
        <LearnedPanel
          title="Item masters"
          summary={itemMaster}
          empty="Nothing trained. The EXTO export's item-master column will be blank."
        />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------- role graph */

function RoleGraphEditor({
  rules,
  roles,
  onChange,
}: {
  readonly rules: readonly WireRoleRule[];
  readonly roles: readonly string[];
  readonly onChange: (rules: readonly WireRoleRule[]) => void;
}): JSX.Element {
  const [parentRole, setParentRole] = useState<string>('');
  const [childRole, setChildRole] = useState<string>('');

  const canAdd =
    parentRole !== '' &&
    childRole !== '' &&
    parentRole !== childRole &&
    !rules.some((rule) => rule.parentRole === parentRole && rule.childRole === childRole);

  return (
    <div data-testid="role-graph">
      {roles.length === 0 ? (
        <Callout tone="warning">
          No roles yet. Teach the role segment on screen 4 and the tags in your model will fill
          these lists.
        </Callout>
      ) : null}

      <div className="rule-builder">
        <label className="inline-field">
          <span>Parent role</span>
          <select
            className="control control--select"
            data-testid="role-parent"
            value={parentRole}
            onChange={(event): void => {
              setParentRole(event.target.value);
            }}
          >
            <option value="">Choose…</option>
            {roles.map((role: string): JSX.Element => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <span className="rule-builder__arrow" aria-hidden="true">
          parents
        </span>
        <label className="inline-field">
          <span>Child role</span>
          <select
            className="control control--select"
            data-testid="role-child"
            value={childRole}
            onChange={(event): void => {
              setChildRole(event.target.value);
            }}
          >
            <option value="">Choose…</option>
            {roles.map((role: string): JSX.Element => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button button--small"
          type="button"
          data-testid="role-add"
          disabled={!canAdd}
          onClick={(): void => {
            onChange([...rules, { parentRole, childRole }]);
            setChildRole('');
          }}
        >
          Add rule
        </button>
      </div>

      {rules.length === 0 ? (
        <Callout tone="info">
          No pairings taught. Without one, no family evidence produces a parent and everything
          falls through to the weaker rungs of the ladder.
        </Callout>
      ) : (
        <TableScroll>
          <table className="table table--compact" data-testid="role-rules">
            <thead>
              <tr>
                <th>Parent</th>
                <th>Child</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule: WireRoleRule, index: number): JSX.Element => (
                <tr key={`${rule.parentRole}-${rule.childRole}`}>
                  <td>{rule.parentRole}</td>
                  <td>{rule.childRole}</td>
                  <td>
                    <button
                      className="button button--quiet button--small"
                      type="button"
                      onClick={(): void => {
                        onChange(rules.filter((_entry, position) => position !== index));
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
    </div>
  );
}

/* ----------------------------------------------------------------- ladder */

function LadderEditor({
  tiers,
  onChange,
}: {
  readonly tiers: readonly WireLadderSource[];
  readonly onChange: (tiers: readonly WireLadderSource[]) => void;
}): JSX.Element {
  const disabled = ALL_RUNGS.filter((rung) => !tiers.includes(rung));

  return (
    <div data-testid="ladder">
      {tiers.length === 0 ? (
        <Callout tone="error">
          Every rung is off. Nothing would ever nest and every asset would be a root.
        </Callout>
      ) : null}

      <SortableList
        items={[...tiers]}
        keyOf={(tier: WireLadderSource): string => tier}
        ariaLabel="Parent ladder"
        testId="ladder-tiers"
        onReorder={onChange}
        renderItem={(tier: WireLadderSource, index: number, handle: ReactNode): ReactNode => {
          const entry = LADDER_RUNGS.find(([kind]) => kind === tier);
          return (
            <div className="ladder-rung" data-testid={`ladder-${tier}`}>
              {handle}
              <span className="chain__order">{index + 1}</span>
              <span className="ladder-rung__text">
                <span className="ladder-rung__title">{entry?.[1] ?? tier}</span>
                <span className="ladder-rung__what">{entry?.[2] ?? ''}</span>
              </span>
              <button
                className="button button--quiet button--small"
                type="button"
                data-testid={`ladder-disable-${tier}`}
                onClick={(): void => {
                  onChange(tiers.filter((candidate) => candidate !== tier));
                }}
              >
                Switch off
              </button>
            </div>
          );
        }}
      />

      {disabled.length === 0 ? null : (
        <div className="chip-row" data-testid="ladder-disabled">
          {disabled.map((tier: WireLadderSource): JSX.Element => {
            const entry = LADDER_RUNGS.find(([kind]) => kind === tier);
            return (
              <button
                key={tier}
                type="button"
                className="chip"
                data-testid={`ladder-enable-${tier}`}
                title={entry?.[2] ?? ''}
                onClick={(): void => {
                  onChange([...tiers, tier]);
                }}
              >
                <span className="chip__label">{entry?.[1] ?? tier}</span>
                <span className="chip__hint">off — click to switch on</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- projection */

function ProjectionEditor({
  rewrites,
  disciplines,
  onChange,
}: {
  readonly rewrites: readonly WireDisciplineRewrite[];
  readonly disciplines: readonly string[];
  readonly onChange: (rewrites: readonly WireDisciplineRewrite[]) => void;
}): JSX.Element {
  const unmapped = disciplines.filter(
    (discipline) => !rewrites.some((rewrite) => rewrite.from === discipline),
  );

  return (
    <div data-testid="discipline-projection">
      {rewrites.length === 0 ? (
        <Callout tone="info">
          No rewrites. SSM Discipline is whatever the model called it.
        </Callout>
      ) : (
        <TableScroll>
          <table className="table table--compact" data-testid="projection-rows">
            <thead>
              <tr>
                <th>Model says</th>
                <th>Register uses</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rewrites.map((rewrite: WireDisciplineRewrite, index: number): JSX.Element => (
                <tr key={rewrite.from}>
                  <td>{rewrite.from}</td>
                  <td>
                    <input
                      className="control control--text"
                      type="text"
                      aria-label={`SSM discipline for ${rewrite.from}`}
                      data-testid={`projection-to-${rewrite.from}`}
                      value={rewrite.to}
                      onChange={(event): void => {
                        onChange(
                          rewrites.map((entry, position) =>
                            position === index ? { ...entry, to: event.target.value } : entry,
                          ),
                        );
                      }}
                    />
                  </td>
                  <td>
                    <button
                      className="button button--quiet button--small"
                      type="button"
                      onClick={(): void => {
                        onChange(rewrites.filter((_entry, position) => position !== index));
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

      {unmapped.length === 0 ? null : (
        <div className="chip-row" data-testid="projection-unmapped">
          {unmapped.map((discipline: string): JSX.Element => (
            <button
              key={discipline}
              type="button"
              className="chip"
              data-testid={`projection-add-${discipline}`}
              onClick={(): void => {
                onChange([...rewrites, { from: discipline, to: discipline }]);
              }}
            >
              <span className="chip__label">{discipline}</span>
              <span className="chip__hint">add a rewrite</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------- learned summary */

function LearnedPanel({
  title,
  summary,
  empty,
}: {
  readonly title: string;
  readonly summary: WireLearnedSummary | null;
  readonly empty: string;
}): JSX.Element {
  if (summary === null) {
    return (
      <>
        <h3 className="panel__subtitle">{title}</h3>
        <Callout tone="info">{empty}</Callout>
      </>
    );
  }

  return (
    <>
      <h3 className="panel__subtitle">{title}</h3>
      <p className="muted">
        Trained from {summary.label} — {count(summary.rowCount)} rows.
      </p>
      <StatRow>
        <Stat label="Classes learned" value={count(summary.classCount)} />
        <Stat label="Role gates" value={count(summary.gateCount)} />
        <Stat
          label="Claim grade"
          value={count(summary.claimGradeCount)}
          hint="may build hierarchy"
        />
        <Stat
          label="Proposal grade"
          value={count(summary.proposalGradeCount)}
          hint="review queue only"
        />
      </StatRow>

      {summary.suspectRowCount === 0 ? null : (
        <Callout tone="warning">
          {count(summary.suspectRowCount)} rows were excluded from training. They are recorded in
          the rule set’s own audit list.
        </Callout>
      )}

      {summary.grades.length === 0 ? null : (
        <TableScroll>
          <table className="table table--compact" data-testid={`grades-${summary.kind}`}>
            <thead>
              <tr>
                <th>Class</th>
                <th className="table__number">Predicted</th>
                <th className="table__number">Correct</th>
                <th className="table__number">Precision</th>
                <th>Grade</th>
              </tr>
            </thead>
            <tbody>
              {summary.grades.map((grade: WireLearnedGrade): JSX.Element => (
                <tr key={grade.className}>
                  <td>{grade.className}</td>
                  <td className="table__number">{count(grade.predicted)}</td>
                  <td className="table__number">{count(grade.correct)}</td>
                  <td className="table__number">{percent(grade.precision)}</td>
                  <td>
                    <span
                      className={`badge badge--${grade.grade === 'claim' ? 'ready' : 'suggestion'}`}
                    >
                      {grade.grade === 'claim' ? 'may nest' : 'proposal only'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </>
  );
}
