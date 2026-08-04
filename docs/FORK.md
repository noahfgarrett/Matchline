# Fork provenance

This repo began as a full copy of SSManagement's `src/`, `build/`, `tests/`,
`package.json`, and `AGENTS.md` at commit `6d51935` (2026-08-03, v3.5.0).

Policy: one-time fork. No build or runtime coupling with SSManagement.
Improvements flow between repos only by deliberate cherry-pick.
SSManagement is never modified by Compiler work.

Trim of unused surfaces (legend trainer, update UI, etc.) is deferred to
Phase 3 — see docs/specs/2026-08-03-ssm-compiler-design.md §11.

## Phase 1 deviations from the plan

- `pwa/` was also copied — the deployment suite covers its manifest and service worker.
- Tests activate a project profile via `tests/support/compiler-harness.mjs`; the
  forked harness boots with the locked Eagle legacy profile, which keeps every
  MEL-first behavior off (that is also how Eagle's frozen expectations survive).
- MEL attribute consumption (Discipline, System = "{UPN} {System Description}")
  is gated on `hierarchy.melSeed.enabled` — the MEL-first master switch — rather
  than an `expression` Classify kind; expression wiring is deferred until a
  profile needs a custom composition.
- `src/compiler/edges.js` landed in Phase 1 (the plan had no task for it): the
  raw-tree cable stage only claims parents for loads with Easy Power register
  rows, so MEL-seeded records needed a direct cable-edge pass. It honors the
  `cableParentChains` workflow toggle.
- `recordPartitionKey` returns null unless building/discipline/system are all
  explicit — profile fallback values must never manufacture partitions.
- The register keeps its existing convention of rendering rooted (blank)
  parents as `N/A`.
- `tests/profile.test.mjs`'s pinned `detectMel` shape gained the two new keys.

## Phase 2+3 deviations and deferrals

- P6 rung-1 (direct equipment) matching uses explicit equipment-ID columns only
  (XLSX activity exports); no fuzzy activity-text scanning.
- Milestone/sequence/precedence computation is gated on the same MEL-first
  switch (`hierarchy.melSeed.enabled`) as everything else — Eagle stays frozen.
- Line-list roll-up partition attributes come from the UPN's MEL majority; a
  manual piping-add UI is deferred.
- Deferred intentionally: fork surface trim (legend trainer, update UI, etc.),
  rule-pack authoring polish, review-queue UX. The SOP-baseline equipment-type
  relate rules (VFD→major equipment with PLC/panel deps, etc.) remain profile
  authoring work, not code.

## 2026-08-04 EXTO-layer batch

- EXTO is a profile-gated optional layer (`hierarchy.exto`): other sites use
  different Cx software and only want the SSM itself. Eagle keeps the frozen
  historical Exto layout (deps at AM, no milestone/IM columns, N/A roots);
  project profiles follow Upload Template Rev21.
- Item-master learning keys: (discipline, classification, UPN) then
  (discipline, UPN, first description word), 0.9 confidence gate — measured on
  a real 18k-row registry at ~81% auto-assignment, ~99% accuracy.
- Registry rows with placeholder masters or electrical-gear masters on
  non-electrical equipment are excluded from learning and audited instead.

## 2026-08-04 description-classification batch

- Descriptions predict Equipment Classification at ~94% (digit-masked key) —
  shipped as a learned, confidence-gated attribute.
- Statistical parent GUESSING was evaluated and rejected: six policy iterations
  against 15,951 real same-system parent links topped out near 50% precision
  (coordinate families are real — 87% share a number — but which family member
  is the parent is site-anatomy-specific). Nesting conventions should be
  authored as profile relate rules keyed on the classification attribute and
  validated against a registry export, not guessed.
