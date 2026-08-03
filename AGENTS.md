# SSManagement

Standalone single-file HTML app, distributed as one self-contained file that opens offline by double-click. Edit source under `src/`, never `SSManagement.html` directly — the HTML is a generated artifact, rebuilt by `npm run build` and committed. `npm test` fails if it is stale.

## Commands

```bash
npm run build
npm test
python3 -m http.server 8787 --bind 127.0.0.1
```

Open `http://127.0.0.1:8787/SSManagement.html` for browser checks.

## Release Notes Style

When publishing a new GitHub release, write the release body as brief user-facing bullets.

- Use one bullet per meaningful user-facing fix or feature.
- For bug fixes, use this style: `- Fixed an issue where loading spinners could get stuck occasionally`
- For features, use this style: `- Added a new feature to include working-copy comparisons`
- For polish or performance, use this style: `- Improved iPad update downloads`
- Keep bullets short and plain. No implementation details, no test notes, no QA notes, no long explanations.
- Only mention changes included in that version.

Good examples:

```md
- Fixed an issue where loading spinners could get stuck occasionally
- Added support for saving updated HTML files through the iPad share sheet
- Improved hierarchy build progress for large spreadsheets
```

## Release Checklist

The source repository stays private. Public downloadable artifacts are published only to
`noahfgarrett/SSManagement-Releases`.

1. Bump `version` in `package.json`.
2. Bump `APP_VERSION` in `src/update/private-update.js` and add the matching top entry to `src/changelog.json`.
3. Bump `EAGLE_PRESET_VERSION` when the built-in Eagle definition changes.
4. Run `npm run build` to regenerate `SSManagement.html`.
5. Run `npm test`.
6. Browser-check `SSManagement.html`, including an iPad-sized viewport when the change affects layout, loading, downloads, or touch behavior.
7. Commit and push the source changes to the private `SSManagement` repository.
8. Create a public release tag like `v3.0.1` in `noahfgarrett/SSManagement-Releases`.
9. Attach the generated HTML as `SSManagement-v3.0.1.html`; also attach a gzip copy when available.
10. Verify `https://api.github.com/repos/noahfgarrett/SSManagement-Releases/releases/latest` returns the new tag and both assets.

For the first release containing the public updater only, also publish the same assets as
a final private release in `noahfgarrett/SSManagement`. That bridges existing token-based
copies onto the public channel. Do not publish later versions to the private source
repository.

Use the release notes style above for the GitHub release body.

Docs-only changes do not need an app version bump or release unless the user specifically asks for one.

## Distribution Boundaries

- Keep the `SSManagement` source repository private.
- Treat `SSManagement-Releases` as an artifact-only public repository.
- Never read from or publish to `SSM-Builder`; it is a separate frozen application.
- Do not add GitHub Pages deployment workflows unless Noah explicitly requests the PWA.
- Do not publish a PWA unless Noah explicitly requests it after reviewing access controls.
- The standalone HTML must never contain GitHub credentials or tokens.
- The updater must make anonymous requests only to `SSManagement-Releases`.
- Site profiles and imported spreadsheet data remain local to the browser or exported profile files.
- Treat spreadsheet imports as trusted internal files until the embedded style-enabled SheetJS runtime is upgraded.

## Profile Architecture Invariants

- `Eagle - SSM Builder Legacy` is a locked built-in profile. Keep its executable rules
  materialized and visible; project profiles are editable clones. Eagle must exactly match
  the frozen `/Users/noahgarrett/Codebase/SSM-Builder/SSM-Builder.html` v1.1.37 behavior.
- Never infer or inject Eagle rules into an incomplete custom profile. Profiles are complete
  executable documents, and missing logic must fail validation instead of falling back
  silently.
- Tag Trainer records compile into the same Normalize/Classify arrays the production engine
  executes. Do not add a second tag-rule runtime.
- Parent evidence from Easy Power, Cable Schedule, MEL, and PMD stays as independent claims.
  Relationship rules and manual placement overrides resolve those claims.
- Eagle Electrical Flow preserves the frozen source-occurrence tree and Eagle register/export
  policies preserve its staged first-row behavior. Custom profiles use the canonical resolved
  snapshot for Hierarchy, Review/Comparison values, and SSM/Exto exports.
- In canonical custom profiles, a structural parent is singular and dependencies are additive.
  Equal-priority parent conflicts and cycles are review states. Eagle's explicit legacy
  policies are the only compatibility exception.
- Manual branch moves must become relationship overrides. Editable profiles persist them;
  the locked Eagle profile may hold session-only overrides.
- Profile publication must pass `compileRuleProfile`. Any executable change requires a full
  hierarchy rebuild, not only a projection refresh.
- Keep profile persistence checksummed and recoverable. Downloaded replacement HTML must
  carry the portable profile handoff so version updates do not discard site work.
- Eight workbook scenarios plus downstream-gap, case-variant, duplicate-parent, and repeated
  PMD-occurrence edges are checked against the frozen SSM Builder HTML. Do not recapture Eagle
  goldens or weaken the frozen differential without an explicit compatibility decision.

## Legend Trainer Invariants

- A document never publishes a rule. Extraction yields knowledge, knowledge yields
  proposals, proposals yield unpublished draft changes. `Save & apply` stays the only
  publication action.
- Raw document state never reaches a profile: no files, bytes, page objects, canvases,
  blob URLs, page text, OCR output, or worker handles. Only compact reviewed metadata is
  persisted, and it lives in `profile.legendTraining` under enforced caps.
- Transient document state lives in the module-owned legend session, never on
  `S.profileDraft`. `profileClone` is a JSON round trip and would silently destroy it.
- `legendTraining` stays out of `profileExecutionSignature` and the compiler fingerprint,
  so reviewing a document never forces a hierarchy rebuild. Provenance is stored beside
  rules, never inside them, for the same reason.
- The legend corpus resolves columns through an explicitly supplied candidate profile.
  Never fall back to `activeProfile()` when validating a profile being created, and never
  mutate the active profile to make an existing helper work.
- Generated rules are ordinary editable rules. There is no locked generated-rule type, and
  a hand-edited generated rule is never overwritten by re-analysis.
- High-risk proposals — identity normalization, relationship rules, hierarchy roots — are
  never preselected, regardless of confidence. Nothing is preselected without a project
  corpus.
- All extracted document text passes through `esc()` before reaching markup.

## Bundle Scope

The build concatenates every module into ONE top-level scope. Two modules declaring the
same top-level name is not a syntax error for `function` declarations — the later one
silently wins and earlier callers start calling a stranger, at runtime, in the bundle only.
ESM tests give each module its own scope and cannot see it. `npm run build` refuses to emit
a bundle with duplicate top-level names or with surviving `import`/`export` syntax; do not
weaken either guard.

## Vendored PDF.js

`pdfjs-dist@6.1.200` (Mozilla, Apache-2.0) is vendored under `src/vendor/legend/` with its
licence, and embedded as SOURCE STRINGS in a dedicated `<script>` block — not as executed
code. The library is an ES module and its worker must come from a URL, so both are handed
to `URL.createObjectURL` on demand. This is verified working under `file://`, including a
real `Worker` rather than PDF.js's main-thread fallback.

- The built artifact has **four** script blocks: sheetjs, fflate, PDF.js sources, app.
  `tests/support/harness.mjs` locates blocks by content and deliberately skips the PDF.js
  one; a dozen VM contexts each parsing ~1.8 MB segfaulted V8 under the suite's fan-out.
- Nothing is decoded at boot. The two strings are untouched until a PDF is uploaded.
- No page is rendered: extraction is text-layer only. A page with no text layer is
  reported as needing OCR, which this build does not carry.
- To change the pinned version, replace both files and the licence together, re-run the
  `file://` compatibility check, and re-measure the artifact size.

## MEL System Parent Claims

`hierarchy.workflow.melSystemParentClaims` records System Parent Equipment Tag(s) as an
ordinary parent claim for every MEL row that has one — off for Eagle, on for project
profiles.

- The scoping is NOT a rule and must not become one. Cable Schedule claims only exist for
  equipment in the Cable Schedule, so ranking cable above mel in `parentSourcePriority`
  means MEL can only win where cable is silent. Do not add per-discipline precedence.
- This path records claims and nothing else. Unlike `melUpnParents`, it never mutates the
  raw tree, which is why it cannot move Eagle.
- The first tag in the column is the structural parent; the remainder become dependencies.
  A structural parent is singular and dependencies are additive.
- The Hierarchy tab shows how many parents each source actually resolved. Two toggles in
  two bands decide that outcome, and nobody infers it from the controls alone.

## Eagle Is A Reference, Not A Default

A first run lands on an editable starter profile (`STARTER_PROFILE_NAME`) with modern
resolution policies. Eagle stays in the list, locked, as a worked example to read or
duplicate.

- `installCurrentEagle` never reassigns an activeId that still resolves, so existing stores
  keep their selection and anyone who deliberately chose Eagle keeps it. Only a store with
  nothing to point at picks a profile, and it prefers an editable one.
- The starter differs from Eagle by POLICY, not by being crippled. `compileRuleProfile`
  rejects a profile with no executable rules, and there is no site-neutral rule set to
  offer, so the starter inherits the shipped rules as an editable template.
- Delete is guarded on the count of EDITABLE profiles. Deleting down to Eagle alone would
  leave nowhere to work and `installCurrentEagle` would silently conjure a replacement.
- Tests that assert Eagle behaviour must SELECT Eagle explicitly. The golden harness, the
  frozen differential, and the Eagle acceptance tests all used to inherit it from the
  default; the golden harness now throws if it is not running Eagle.
