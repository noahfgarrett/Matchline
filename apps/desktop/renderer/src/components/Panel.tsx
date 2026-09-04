import type { JSX, ReactNode } from 'react';

/** A titled section. Every screen is a stack of these, so the rhythm is fixed. */
export function Panel({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h2 className="panel__title">{title}</h2>
          {description === undefined ? null : <p className="panel__description">{description}</p>}
        </div>
        {actions === undefined ? null : <div className="panel__actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * A short message with a tone. Used for blocked previews, errors and notes.
 *
 * `data-testid` is declared and forwarded on purpose. A hyphenated JSX
 * attribute is exempt from excess-property checking, so a caller that passed
 * one to a component which did not declare it type-checked and then rendered
 * nothing — which is how several callouts came to carry test ids that were
 * never in the DOM. Declaring it makes the forwarding real.
 */
export function Callout({
  tone,
  children,
  'data-testid': testId,
}: {
  readonly tone: 'info' | 'warning' | 'error' | 'success';
  readonly children: ReactNode;
  readonly 'data-testid'?: string | undefined;
}): JSX.Element {
  return (
    <p
      className={`callout callout--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

/** One headline number with its meaning underneath. */
export function Stat({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  /** Optional, so it is `| undefined` explicitly (exactOptionalPropertyTypes). */
  readonly hint?: string | undefined;
}): JSX.Element {
  return (
    <div className="stat">
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
      {hint === undefined ? null : <span className="stat__hint">{hint}</span>}
    </div>
  );
}

export function StatRow({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="stat-row">{children}</div>;
}

/**
 * Wraps a table so it scrolls sideways inside itself.
 *
 * A data table has a floor width — the header row does not wrap, and a column of
 * counts should not either — and on a narrow split screen that floor can exceed
 * the column it sits in. Without this the overflow escapes the panel and the
 * whole wizard pane scrolls horizontally, which reads as a broken layout even
 * though every number in it is right. Every `<table>` in the wizard goes in one.
 */
export function TableScroll({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="table-scroll">{children}</div>;
}
