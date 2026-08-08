/**
 * System Label composition (PRODUCT.md §5.1, §5.3).
 *
 * The label is display text and the key is identity; they are built
 * separately on purpose, so that editing a description can never move
 * equipment across a system boundary.
 */

/** `{systemKey} {systemDescription}` when a description exists, else the key. */
export function defaultLabel(systemKey: string, systemDescription: string | undefined): string {
  return systemDescription === undefined || systemDescription.length === 0
    ? systemKey
    : `${systemKey} ${systemDescription}`;
}

/**
 * Expands `config.labelTemplate`.
 *
 * Only `{systemKey}` and `{systemDescription}` are substituted. Any other
 * `{...}` text is left verbatim so a profile typo shows up in the label rather
 * than silently disappearing.
 *
 * A template that names `{systemDescription}` on a subject with no description
 * falls back to the default rule rather than emitting the surrounding
 * punctuation around a hole.
 */
export function buildLabel(
  systemKey: string,
  systemDescription: string | undefined,
  template: string | undefined,
): string {
  if (template === undefined) {
    return defaultLabel(systemKey, systemDescription);
  }
  const hasDescription = systemDescription !== undefined && systemDescription.length > 0;
  if (!hasDescription && template.includes('{systemDescription}')) {
    return defaultLabel(systemKey, systemDescription);
  }
  const expanded = template
    .split('{systemKey}')
    .join(systemKey)
    .split('{systemDescription}')
    .join(systemDescription ?? '');
  return expanded.length === 0 ? defaultLabel(systemKey, systemDescription) : expanded;
}
