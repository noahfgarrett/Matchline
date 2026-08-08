import type { JSX, ReactNode } from 'react';

/**
 * The one control wrapper every mapping decision uses.
 *
 * APP.md's UI rule — "plain-language UI text: what it does, an example, when to
 * change it" — is enforced by the type: `what` and `example` are required
 * props. A control that cannot explain itself in one line and show one concrete
 * value does not get to render, which is why there is no variant of this
 * component without them.
 */

export interface FieldProps {
  readonly label: string;
  /** One sentence: what this control does to the result. No jargon. */
  readonly what: string;
  /** One concrete value or outcome. `MAH001-10-01` beats "a tag-like string". */
  readonly example: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}

export function Field({ label, what, example, htmlFor, children }: FieldProps): JSX.Element {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      <p className="field__what">{what}</p>
      <p className="field__example">
        <span className="field__example-tag">Example</span>
        {example}
      </p>
      <div className="field__control">{children}</div>
    </div>
  );
}
