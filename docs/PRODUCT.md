# Matchline — Full Product and Engineering Plan

**Working product name:** Matchline  
**Tagline:** Model-first commissioning compiler  
**Initial source:** SSManagement 4.2.2  
**Primary platform:** Windows desktop  
**Development workflow:** Mac-first for UI/compiler work, Windows for Navisworks extraction builds and tests  
**Data policy:** Local-first and local-only for project data  
**Initial version:** 0.1.0

---

## 0. As-built deviations (1.0) — read this first

**This document is the original plan, kept as written.** It is not maintained as a
description of the shipped system, and where the two disagree the built behaviour
wins. Everything below is a place where 1.0 deliberately differs from the plan.
Each one is an authoritative decision in
[`RELEASE-1.0-PLAN.md`](RELEASE-1.0-PLAN.md) — its P0 findings and gate tracker are
the binding text — and each is logged in [`DECISIONS.md`](DECISIONS.md).

| # | The plan says | 1.0 does | Why |
| --- | --- | --- | --- |
| 1 | One extraction cache per project (§6.1, §15 "Model cache"). | A **multi-model universe**: a project registers a set of model sources and every one with a readable cache is open at once. Object, source-model and selection-set identities are namespaced by `sourceId` through a typed `ModelObjectKey`, the Property Catalog aggregates across sources with per-source and overall coverage, and files sharing a basename coexist. Split and federated representations of one site compile to equivalent output. | RELEASE-1.0-PLAN P0-1; hard gates 2–4. Real sites arrive as several files from several consultants. |
| 2 | Building, discipline and system are all structural boundaries by default (§2.4 example, §11.3). | The default preset enables **Building and System as boundaries and SSM Discipline as a visible grouping only**. Discipline still groups the tree; it does not break parents. A boundary that *is* enabled is still hard, with no feed-chain exception. | P0-5; gate 11. A startup family (MAH/PLC/VFD/TIT) crosses native disciplines, and a structural discipline cuts one family into four roots. |
| 3 | Manual reparenting is a persistent override (§11.5) — and the 0.4.0 engine let it bypass the fold. | **Manual parents fold.** A manual parent is the strongest candidate and wins the ladder, then goes through the same boundary fold as any other: crossing an enabled boundary demotes it to a dependency, with provenance recording the manual origin and the demotion, and a visible review item. Manual make-root stays final. There is no "force structural across a boundary" in 1.0. | P0-4; gates 9–10. Supersedes the earlier manual-bypass behaviour. |
| 4 | A hierarchy level has one attribute (§2.4, §11). | A level has a **key, an optional display attribute and an optional boundary attribute**. The standard System level keys and compares on System Key and displays System Label, so editing a description or a label never moves equipment — the revision diff reports a label change, not a system move. | P0-6; gate 8. |
| 5 | A two-layer profile (§13.1) whose sections partly live outside it — hierarchy, role graph, ladder, discipline projection and parent-tag property arrived on the compiler input instead. | **`SiteProfileV2`**: one versioned document holding every section, stored as one revision and exported as one package. Only genuinely project-specific configuration stays outside it — the captured EXTO template belongs to one project's deliverable, not to the site's rule set. Profile package format v2; v1 packages migrate on import, never refused. | RELEASE-1.0-PLAN "SiteProfileV2"; gate 13. |
| 6 | Hierarchy levels come from raw, joined or derived fields (§2.4) without saying where a derived field is defined. | A versioned profile-level **derived attribute registry**: `DerivedAttributeDefinition` with seven resolver kinds (model-property, tag-segment, source-assignment, system-field, composite, mel-lookup, manual). The profile defines the field, the compiler resolves it deterministically, the Composer lists it, and a missing value stays missing — no fallback value ever feeds a boundary. | P0-7; gate 7. |
| 7 | One property mapping per standard field (§4, §13.2). | **Ordered fallback chains with optional per-source overrides** on every standard field, plus profile-level **source assignment rules** resolved object property > source-model > logical file > confirmed filename pattern > review, with provenance naming the tier and the rule. Existing single mappings migrate to a one-rung chain. | P0-8; gates 5–6. Editors for the chains, the assignment rules and the derived-attribute registry are still open. |
| 8 | Identity is reconciled per compile (§9). | A persistent **asset identity ledger** in the project file: `{assetId, currentCanonicalTag, aliases, modelIdentities}`. Identity evidence runs profile-mapped stable id property > source persistent id + authoring object id > source persistent id + InstanceGuid > deterministic structural key > tag as last-resort reconciliation; a content hash is never part of identity. A corrected tag keeps its `assetId`, manual decisions recorded against it keep applying, and the diff reports a tag change rather than a remove plus an add. Overrides that cannot be mapped become orphaned-decision review items and are never dropped. | P0-9; gate 12. |

Two smaller ones, for completeness: the stack trims in §14 were settled in
DECISIONS.md #5 (no Zustand; Node's built-in `node:sqlite` instead of a driver
dependency), and the repository structure in §17 has been superseded — see the
corrected tree there and the fuller table in the root `README.md`.

Nothing in this document should be read as a claim about Navisworks version
support. That claim lives in one place,
`native/navisworks-common/Protocol/SupportedAdapters.cs`, and today no version is
verified: 2025 is pending its real proof run and 2024/2026 are stub-compiled and
unverified.

---

## 1. Product definition

Matchline is a local Windows desktop application that compiles an authoritative commissioning data model from:

- Navisworks model files, initially NWD
- EasyPower exports
- Cable Schedules
- Point Master Database exports
- Optional existing MELs
- Optional prior SSMs or accepted registries
- A reusable Site Profile

Navisworks provides the authoritative equipment universe and the best available equipment metadata. EasyPower, Cable Schedule, and PMD provide the connectivity spine. Matchline reconciles those sources into one canonical evidence graph and generates:

1. Electrical Flow
2. SSM Hierarchy
3. A model-derived MEL
4. SSM and EXTO-style workbook exports
5. System/UPN predecessor outputs
6. QA, discrepancy, provenance, and revision reports

The target user experience is:

> Drop the available model and project files, confirm a small number of suggested mappings, review genuine exceptions, and export a complete commissioning structure.

The setup target is that one competent engineer can configure a new site in no more than one hour. Subsequent revisions should reuse the Site Profile and require only source replacement plus exception review.

---

## 2. Locked product decisions

### 2.1 Model authority

The coordinated model is authoritative for:

- Which modeled assets exist
- Canonical modeled equipment identity
- Model-native descriptions and types
- Model-native metadata
- Model provenance
- Building, discipline, system, area, package, or other grouping attributes when those fields are available and mapped

The MEL is not the authoritative equipment universe. It can enrich, validate, compare, and provide lookup values when the model does not carry them.

### 2.2 Connectivity authority

EasyPower, Cable Schedule, and PMD remain the primary sources for connectivity:

- EasyPower and Cable Schedule: electrical source-to-load relationships
- PMD: panel, instrument, and point relationships
- Model relationship properties: supporting or configurable primary evidence where a site models them reliably

### 2.3 System is resolved, not hardcoded

“System” is a site-configurable concept.

For a common site:

- System Key = UPN
- System Description = System Description from MEL or model
- System Label = `{UPN} {System Description}`

For another site:

- System Key may be System Code, Commissioning Package, Area + System, a model property, or a tag-derived segment
- System Label may be one selected exported column
- System Description may be absent
- A site may not use UPN terminology at all

Matchline must therefore expose a System Resolver rather than requiring a fixed UPN field.

### 2.4 Configurable hierarchy

The hierarchy is user-composed from any raw, joined, or derived field.

Example:

1. Building
2. SSM Discipline
3. System
4. Subsystem
5. Equipment tree

Any level can be omitted, reordered, renamed, or replaced. The user chooses which levels are structural boundaries.

### 2.5 Boundary rule

When a proposed structural parent and child differ across an enabled boundary:

- The relationship remains real
- It is removed from the structural parent chain
- The parent becomes a dependency of the child
- The child resolves under a valid parent in its own boundary or becomes a root of that grouping

Example:

- Electrical panel System Key = 603
- RIO System Key = 650
- Electrical Flow retains panel → RIO
- SSM Hierarchy places the RIO in System 650 with the panel listed as a dependency

### 2.6 Local-only project processing

No model, spreadsheet, Site Profile, project database, extraction result, or export leaves the machine.

The only optional network action is checking for and downloading signed application updates. Update checks must be disableable.

### 2.7 Generated MEL is a first-class output

The canonical model is capable of generating a more complete MEL than the project started with. The generated MEL is not an afterthought; it is a core product deliverable.

---

## 3. Product vocabulary

Matchline should use neutral internal terms so it can support different site standards.

| Product term | Meaning |
|---|---|
| Asset | One canonical commissionable equipment record |
| Source Observation | A fact read from a model object or spreadsheet row |
| Attribute Claim | A proposed value such as Building, Description, or System Key |
| Relationship Claim | A proposed structural parent or dependency |
| System Key | Stable identity used to group and enforce system boundaries |
| System Description | Optional human-readable description |
| System Label | Display string, commonly System Key + System Description |
| Hierarchy Level | A folder/grouping level in the SSM projection |
| Structural Boundary | A field that parent-child relationships cannot cross |
| Native Discipline | Discipline recorded by the model/source |
| SSM Discipline | Discipline branch used in the commissioning hierarchy |
| Family Key | Shared tag anatomy used to associate related equipment |
| Role | Equipment role such as MAH, PLC, VFD, TIT, RIO, or panel |
| Site Profile | Versioned site-specific mappings, rules, boundaries, and overrides |
| Baseline Rule Pack | Standard commissioning rules shipped with Matchline |

---

## 4. Source authority model

Authority should be resolved per fact, not through one global source-priority list.

### 4.1 Default authority matrix

| Fact | Default authority | Secondary evidence |
|---|---|---|
| Asset existence | Navisworks model | Flow-only and PMD-only records become review items |
| Canonical equipment tag | Model-mapped tag | Site normalization and aliases |
| Description | Model | MEL, source schedules, classification rules |
| Equipment type | Model + profile classification | Description and tag role |
| Building | Mapped model property | Ancestor/source model, filename assignment, manual |
| Native discipline | Mapped model property | Source model/file assignment |
| SSM discipline | Profile projection rule | Top-parent inheritance, manual override |
| System Key | Site System Resolver | Model, tag segment, MEL lookup, direct selected field |
| System Description | Site System Resolver | Model or MEL system catalog |
| Electrical feed | Cable Schedule / EasyPower | Explicit model relationships |
| Instrument/panel relation | PMD | Model metadata |
| SSM structural parent | Explicit relationship, flow-anchored family rule, role rule | Description model, prior accepted examples |
| Dependencies | Boundary-demoted relationships and additive rules | Model relationship metadata |
| Final override | Human | Always highest authority |

### 4.2 Model authority does not require every field to be in the model

The model owns the asset universe. A missing field can still be resolved from a configured secondary source.

For example:

- Model contains equipment tag and UPN
- MEL contains UPN and System Description
- Matchline joins the model UPN to the MEL’s system catalog
- Model asset remains authoritative
- MEL supplies only the missing display description

---

## 5. System Resolver

The System Resolver is one of the most important parts of Matchline.

### 5.1 Resolved system fields

Each asset should resolve:

```text
systemKey
systemDescription
systemLabel
systemEvidence
systemConfidenceTier
systemConflictStatus
```

The System Key and System Label must remain separate.

- Boundary checks use System Key
- Hierarchy display normally uses System Label
- Description changes cannot accidentally move equipment across systems
- A site with one complete “System” column can use the same field for both

### 5.2 Supported resolution components

The user can construct the System Resolver from:

1. **Model field**
   - Any extracted object property
   - Any ancestor/container property
   - Any source-model property

2. **Tag anatomy segment**
   - A user-taught portion of the equipment tag
   - Example: `MAH001-10-01` → System Code `001`

3. **MEL lookup**
   - Join by Equipment Tag
   - Join by System Key/UPN
   - Return UPN, System Description, or a configured field

4. **Direct imported column**
   - The user points to one model-export or spreadsheet column and labels it “System”
   - That field can be used directly as System Key and System Label

5. **Composite expression**
   - Combine fields and tag segments
   - Example: `{Area}-{SystemCode}`
   - Example: `{UPN} {SystemDescription}`

6. **Fallback chain**
   - First nonblank or first valid source in a user-defined order

7. **Manual assignment**
   - Per asset, model source, file, category, or selected group

### 5.3 Standard baseline behavior

The baseline should suggest, not force:

```text
System Key candidates:
1. Explicit mapped model UPN/System Code
2. Tag-derived system segment
3. User-selected direct System field
4. MEL lookup
5. Manual assignment

System Description candidates:
1. Explicit model System Description
2. MEL lookup by resolved System Key
3. User-selected description field

System Label:
If description exists: "{System Key} {System Description}"
Otherwise: "{System Key}"
```

The user can reorder this chain.

### 5.4 Tag-derived system example

For:

```text
MAH001-10-01
PLC001-10-01
VFD001-10-01
TIT001-10-01
```

A site-specific anatomy can resolve:

```text
Role:          MAH / PLC / VFD / TIT
System segment: 001
Family key:     001-10-01
Local family:   10-01
```

The system segment can become System Key `001`.

If an MEL contains:

```text
UPN: 001
System Description: Mechanical Dry Air Handling
```

Matchline produces:

```text
System Key: 001
System Description: Mechanical Dry Air Handling
System Label: 001 Mechanical Dry Air Handling
```

### 5.5 Normalization safeguards

System identifiers must be treated as strings, not numbers.

A site may use:

- `001` in tags
- `1` in Excel
- `UPN-001` in a model field

The Site Profile can define explicit transforms such as:

- trim
- uppercase
- remove a known prefix
- pad left to three digits
- alias `1` to `001`

Leading-zero conversion must never happen silently.

### 5.6 Conflict behavior

Examples:

- Model UPN = `002`
- Tag-derived system = `001`
- MEL lookup = `001`

Default action:

- Keep all claims
- Do not silently select based only on majority
- Use configured precedence if the profile explicitly defines it
- Otherwise create a System Conflict review item
- Show the affected hierarchy changes before publication

### 5.7 System Catalog

When an MEL is available, Matchline should build a distinct System Catalog:

```text
systemKey
systemDescription
sourceRows
aliases
conflicts
```

If one UPN maps to several descriptions, that is a review item. The equipment universe still comes from the model.

---

## 6. Model ingestion architecture

### 6.1 No file-splitting assumption

Matchline must support:

- One NWD per building and discipline
- One NWD per building
- One NWD per discipline
- One federated NWD for the entire site
- Multiple arbitrary coordination packages
- Mixed organization across files

File and source-model organization are evidence, not mandatory truth.

### 6.2 Metadata scopes

The extractor should collect metadata from:

1. Individual model object
2. Ancestor/container hierarchy
3. Internal appended source model
4. Selection/Search Set membership
5. NWD file envelope
6. Optional filename/folder parsing

Resolution should prefer explicit object metadata, then configured ancestor/source defaults, then file assignments.

### 6.3 Source Assignment grid

When metadata is missing, the setup wizard shows:

| Source file/model | Objects | Suggested Building | Suggested Discipline | User assignment |
|---|---:|---|---|---|
| Mechanical-A.nwc | 24,512 | B14 | Mechanical | Confirm/edit |
| Controls-A.nwc | 8,921 | B14 | I&C | Confirm/edit |
| Federated.nwd | 131,000 | Mixed | Mixed | Use object metadata |

Assignments may be made per:

- NWD
- Internal source model
- Selection Set
- Category
- Search result
- Individual exception

### 6.4 Extractor output

The C# worker should write a local extraction cache rather than returning a huge JSON object to Electron.

Core extracted information:

```text
source files/models
object identifiers
parent/container identifiers
display names
all property category/name/value tuples
selection paths
selection/search sets
authoring identifiers where available
bounding box, optional
extraction warnings
input file hash
extractor and Navisworks adapter version
```

Do not extract or store model geometry for the first production version.

### 6.5 Property Catalog

After extraction, Matchline creates a ranked Property Catalog:

| Property | Coverage | Distinct count | Examples | Suggested role |
|---|---:|---:|---|---|
| Identity Data > Mark | 87% | 12,450 | MAH001-10-01 | Equipment Tag |
| Commissioning > UPN | 93% | 42 | 001, 002, 603 | System Key |
| Project > Building | 98% | 6 | B14, B31 | Building |
| Item > Category | 100% | 118 | Mechanical Equipment | Asset filter |

Suggestions are based on:

- Property-name synonyms
- Fill rate
- Cardinality
- Value shape
- Tag overlap with EasyPower/Cable/PMD
- Consistency by source model
- Existing baseline and Site Profile mappings

The user can map any property, regardless of whether Matchline suggested it.

### 6.6 Asset candidate filtering

The raw model may contain millions of objects that are not commissionable assets.

The Site Profile defines:

- Included categories
- Excluded categories
- Required tag property
- Accepted tag patterns
- Selection Sets that identify equipment
- Source models to include
- Component-collapse rules
- Separately commissionable subcomponents

The first setup should propose filters using tag coverage and source overlap. It must show the inclusion impact before saving.

---

## 7. One-hour Site Setup wizard

### Screen 1 — Project sources

Drop:

- NWD files
- EasyPower
- Cable Schedule
- PMD
- Optional MEL
- Optional prior SSM

Matchline identifies the file types and displays extraction/import status.

### Screen 2 — Model scan and Property Catalog

Show:

- Total raw objects
- Candidate tagged objects
- Candidate equipment categories
- Duplicate tag count
- Property coverage
- Source-model organization
- Likely Building, Discipline, System, Tag, and Description fields

The user can accept suggestions or open Advanced Mapping.

### Screen 3 — Asset definition

Confirm:

- Equipment Tag field
- Asset inclusion filters
- Description field
- Equipment type field
- Duplicate handling
- Model-only and source-only policy

### Screen 4 — Tag anatomy

Teach or confirm:

- Role segment
- System segment
- Family key
- Unit/instance portions
- Ignored suffixes
- Alias normalization

The UI uses real tags and previews the result across the whole source set.

### Screen 5 — System Resolver

Configure:

- System Key
- System Description
- System Label
- Fallback order
- MEL join
- Tag-derived system segment
- Normalization
- Conflict policy

The preview shows:

- Coverage
- Source used per asset
- Conflicts
- Unassigned systems
- Example labels

### Screen 6 — Hierarchy Composer

Drag fields into levels:

```text
Building
SSM Discipline
System
Subsystem
Equipment
```

For each level choose:

- Display name
- Source/derived field
- Sort behavior
- Missing-value behavior
- Structural-boundary toggle

System display may use System Label while the boundary uses System Key.

### Screen 7 — Relationship rules

Begin with a standard commissioning baseline.

Configure:

- Role compatibility
- Parent ladders
- Flow-anchored family rules
- Description-driven rules
- SSM discipline inheritance
- Dependency rules
- Explicit model relationship fields

### Screen 8 — Preview and QA

Show:

- Electrical Flow
- SSM Hierarchy
- Generated MEL preview
- Model-only equipment
- Flow-only/PMD-only equipment
- Missing systems
- Cross-boundary demotions
- Duplicate tags
- Ambiguous parents
- Cycles
- Conflicting system evidence

### Screen 9 — Publish Site Profile

Save the reviewed configuration as a versioned Site Profile.

For subsequent revisions:

```text
Replace sources
→ use saved mappings and rules
→ review changes
→ export
```

---

## 8. Canonical evidence graph

Matchline should build one canonical graph and derive every output from one immutable resolved snapshot.

### 8.1 Core entities

#### CanonicalAsset

```text
assetId
canonicalTag
aliases
description
equipmentType
nativeDiscipline
ssmDiscipline
systemKey
systemDescription
systemLabel
hierarchyAttributes
modelObjectReferences
sourceStatuses
resolvedParent
dependencies
provenance
reviewStatus
```

#### SourceObservation

A raw fact from:

- Model object/property
- EasyPower row
- Cable Schedule row
- PMD row
- MEL row
- Prior SSM row
- User decision

#### AttributeClaim

```text
subjectAsset
attribute
proposedValue
source
rule
evidenceTier
provenance
```

#### RelationshipClaim

```text
subjectAsset
targetAsset
kind: structural-parent | dependency
relationshipType
source
rule
evidenceTier
provenance
```

### 8.2 Relationship types

At minimum:

```text
POWERS
WIRED_TO
CONTROLS
SERVES
EXPLICIT_PARENT
FAMILY_RELATED
STRUCTURAL_PARENT_CANDIDATE
DEPENDENCY
```

### 8.3 Deterministic resolution

Auto-detection can use scores to rank suggestions, but published hierarchy decisions should be deterministic.

A candidate’s resolution is based on:

- Manual precedence
- Explicit evidence tier
- Site Profile order
- Boundary rules
- Tie/ambiguity policy
- Cycle handling

The same inputs and profile must produce the same resolved snapshot.

### 8.4 Provenance

Every resolved fact must answer:

- Which file?
- Which model object or spreadsheet row?
- Which property/column?
- Which rule?
- Which fallback rung?
- Which manual decision?
- Which input and profile revision?

No silent rewriting.

---

## 9. Identity reconciliation

### 9.1 Model-first identity

The model tag spelling wins when a model asset exists.

Other source spellings become aliases.

### 9.2 Matching tiers

1. Exact canonical tag
2. Configured normalization
3. Explicit alias
4. Tag anatomy identity match
5. Unambiguous suffix/context match
6. Fuzzy proposal requiring review

Fuzzy identity should never auto-merge without review.

### 9.3 Source-only records

Use explicit states:

```text
MODEL_CONFIRMED
MODEL_ONLY
FLOW_ONLY
PMD_ONLY
MEL_ONLY
DUPLICATE_MODEL_TAG
UNRESOLVED_IDENTITY
MODEL_CONFLICT
```

- MODEL_ONLY records enter the canonical asset universe
- FLOW_ONLY and PMD_ONLY records remain visible and can be promoted through review
- MEL_ONLY records are discrepancy evidence, not automatic authoritative assets
- Duplicate model tags are never silently merged

---

## 10. Electrical Flow projection

Electrical Flow preserves physical and logical source-to-load connectivity.

Primary sources:

- EasyPower
- Cable Schedule
- PMD

Model assets enrich the nodes with:

- Description
- Type
- Building
- Discipline
- System
- Model source
- Model confirmation status

Electrical Flow does not enforce SSM structural boundaries. A cross-system electrical feed remains visible exactly as a feed.

The flow view should support:

- Source-to-load tree
- Multiple feeds
- Alternate feeds
- PMD instruments
- Model-matched and source-only badges
- Source provenance
- Search and filtering
- Conflict review
- Export

---

## 11. SSM Hierarchy projection

The SSM projection transforms the evidence graph into:

```text
Configured hierarchy levels
→ system grouping
→ one structural equipment parent
→ additive dependencies
```

### 11.1 Parent candidate ladder

Recommended default tiers:

1. Manual relationship override
2. Explicit model parent/relationship field
3. Explicit accepted Site Profile lookup
4. Flow-connected + exact family key + compatible role
5. Exact family key + compatible role
6. Accepted description-driven relationship model
7. Prior accepted SSM example
8. Model tree/set suggestion
9. Root of current grouping

The site can reorder or disable applicable layers.

### 11.2 Tag family example

For:

```text
MAH001-10-01
PLC001-10-01
VFD001-10-01
TIT001-10-01
```

The Site Profile may define:

```text
MAH
└── PLC
    └── VFD
        └── TIT
```

The common Family Key and role compatibility produce candidates. Flow/PMD evidence anchors the family to the real connected equipment.

### 11.3 Boundary fold

For each selected parent:

```text
If all enabled boundary keys are known and equal:
    keep structural parent

If any enabled boundary differs:
    remove structural parent
    add selected parent as dependency

If a required boundary is missing:
    retain as unresolved evidence
    send to review or provisional-root policy
```

### 11.4 Discipline behavior

Native Discipline and SSM Discipline are separate.

A PLC or VFD can retain its native model discipline but appear under a Mechanical Dry parent branch if the profile defines that commissioning projection.

Discipline only blocks a structural relationship when the site enables it as a boundary.

### 11.5 Manual corrections

Drag-and-drop reparenting should create a persistent relationship override, not mutate the output tree only.

The Visual Trainer can offer:

- Apply to this asset
- Apply to matching family
- Create reusable role rule
- Preview affected assets
- Save as one undoable profile change

---

## 12. Generated MEL

### 12.1 Canonical normalized MEL

Always available, with fields such as:

```text
Equipment Tag
Equipment Description
Equipment Type
Building
Native Discipline
SSM Discipline
System Key
System Description
System Label
System Parent Equipment Tag
Dependencies
Source Model
Model Object ID
Inclusion Status
Parent Evidence
Review Status
Model Revision Hash
```

### 12.2 Site-template MEL

The user may upload an existing MEL template and map Matchline fields to its columns.

The export mapper can map:

- System Key to UPN
- System Description to System Description
- System Label to a single System column
- Any raw or derived model field to a custom output column

### 12.3 Existing MEL comparison

When an MEL is supplied:

- Match by model tag/alias
- Compare every mapped field
- Show model value, MEL value, selected value, and evidence
- Flag model/MEL conflicts
- Build the System Catalog
- Never allow a Matchline-generated MEL to become circular authority on reimport

### 12.4 Revision output

A new model revision should produce:

```text
Added assets
Removed assets
Changed tags/aliases
Changed descriptions
Changed System Keys
Changed hierarchy levels
Moved parents
New/removed dependencies
New duplicate/conflict items
```

---

## 13. Site Profile architecture

### 13.1 Two-layer rule model

```text
Versioned Commissioning Baseline
+
Site Profile overrides
=
Compiled Effective Profile
```

The baseline minimizes setup. The Site Profile records only site-specific differences.

### 13.2 Profile sections

1. Source identification
2. Model property mappings
3. Source-model/file assignments
4. Asset filters
5. Tag anatomy
6. System Resolver
7. Hierarchy Composer
8. Structural boundaries
9. Authority matrix
10. Role and relationship graph
11. Description classification
12. SSM discipline rules
13. Export templates
14. Manual attribute overrides
15. Manual relationship overrides
16. Accepted aliases
17. Profile tests and expected examples

### 13.3 Profile safety

- Profiles are versioned
- Raw model files and spreadsheet rows are not embedded
- Profiles are portable JSON packages
- Every save validates before publication
- Baseline updates are previewed as diffs
- A site can pin a baseline version
- Hand-edited rules are not overwritten
- Rule changes trigger only the required compile stages

---

## 14. Recommended technology stack

### Desktop/UI

- Electron
- React
- TypeScript
- Vite
- Zustand for ephemeral UI state
- TanStack Table/Virtual for large tables
- dnd-kit for Hierarchy Composer and rule editing
- Zod or JSON Schema for IPC, cache, profile, and project validation

### Compiler

- TypeScript packages
- Worker threads for compilation
- Immutable resolved snapshots
- Existing SSManagement claim/profile concepts migrated and tested

### Navisworks extraction

- C# local worker executable
- Shared extraction source
- Separate adapter build for Navisworks 2024, 2025, and 2026
- Initial proof against Navisworks Manage 2025
- Worker writes extraction cache directly
- Progress and cancellation over a narrow process protocol
- Worker exits after each extraction to reclaim Autodesk/API memory

### Storage

- Embedded SQLite
- Packaged driver; no user database installation
- ProjectStore abstraction so the driver can change later
- Transactions, migrations, checksums, and automatic backups

### Spreadsheet processing

- Preserve proven SSManagement parsing/export logic initially
- Move it behind typed import/export packages
- Never execute workbook macros

### Packaging

- Signed Windows installer
- Signed MSIX primary target
- Signed EXE/Squirrel fallback when enterprise policy requires it
- Stable and beta update channels

---

## 15. Local project and cache design

### Project file

```text
ProjectName.matchline
```

A SQLite database containing:

- Project metadata
- Source manifests and hashes
- Site Profile reference/snapshot
- Canonical assets
- Source observations
- Claims
- Resolved snapshot
- Review decisions
- Compile history
- Export settings
- Lightweight normalized model data

### Model cache

Stored under local application data:

```text
%LOCALAPPDATA%\Matchline\cache\models\<sha256>.sqlite
```

Contains:

- Raw extracted objects
- Raw property tuples
- source hierarchy
- selection sets
- extraction diagnostics

An unchanged NWD hash reuses the cache.

### Portable package

Optional:

```text
ProjectName.matchlinepkg
```

Contains:

- Project database
- Profile
- Selected extraction caches
- Manifest
- Optional source spreadsheets

Large NWDs remain external unless the user deliberately includes them.

### Recovery

- Automatic snapshot before schema migration
- Transactional writes
- Recent project backups
- Corrupt-generation fallback
- Exportable profile independent of project database

---

## 16. Process architecture and security

```text
Electron main process
├── window and lifecycle
├── file dialogs
├── update service
├── ProjectStore service
├── compiler worker supervisor
└── Navisworks worker supervisor

Sandboxed renderer
├── React UI
└── narrow typed preload API

Compiler workers
├── import/normalization
├── identity reconciliation
├── graph resolution
└── projections/exports

C# Navisworks worker
└── read-only model metadata extraction
```

Security defaults:

- Local packaged content only
- `nodeIntegration: false`
- `contextIsolation: true`
- Renderer sandbox enabled
- Restrictive Content Security Policy
- Typed and validated IPC
- Validate IPC sender
- No arbitrary shell execution
- No credentials inside the renderer
- Escaped model/spreadsheet text
- Worker input/output restricted to approved paths
- No telemetry by default

---

## 17. Repository strategy

### Repositories

```text
noahfgarrett/matchline
noahfgarrett/matchline-releases
```

### Origin strategy

1. Copy/preserve SSManagement history into the new private repo
2. Tag the exact origin commit as `ssmanagement-origin-4.2.2`
3. Add `docs/ORIGIN.md`
4. Leave SSManagement unchanged
5. Reset Matchline app version to `0.1.0`
6. Preserve SSManagement golden fixtures for compatibility

### Structure (as built)

The tree originally proposed here has been replaced by what the repository
actually contains. Engine responsibilities landed as more, smaller packages than
the plan sketched, `native/` grew a shared adapter source plus per-year projects
and two not-shipped support projects, and unit tests live beside the package they
test rather than in a top-level `tests/unit`. The root `README.md` carries the same
tree with one line of explanation per entry.

```text
matchline/
├── apps/
│   └── desktop/
│       ├── electron/          main process: services, handlers, IPC, security
│       ├── preload/           contextBridge façade
│       ├── renderer/          React wizard + workspace
│       └── shared/            the IPC channel declaration table
├── packages/
│   ├── domain/                vocabulary, SiteProfileV2, model universe, derived attributes
│   ├── model-schema/          extraction-cache reader, Property Catalog
│   ├── tag-anatomy/
│   ├── spreadsheet-import/
│   ├── asset-catalog/
│   ├── asset-identity/        stable identity + ledger
│   ├── system-resolver/
│   ├── identity/
│   ├── connectivity-import/
│   ├── electrical-flow/
│   ├── relationship-claims/
│   ├── learned-rules/
│   ├── ssm-compiler/          ladder, boundary fold, hierarchy tree
│   ├── compiler/              orchestrator
│   ├── scheduling/
│   ├── mel-export/
│   ├── exto-export/
│   ├── project-store/         the .matchline file and its migrations
│   └── legacy-parity/         the frozen SSManagement 4.2.2 donor
├── native/
│   ├── navisworks-common/     protocol, DTOs, NDJSON, adapter support table
│   ├── navisworks-adapter/    the one copy of the Autodesk-touching source
│   ├── navisworks-2024/       csproj + year constant only
│   ├── navisworks-2025/       csproj + year constant only
│   ├── navisworks-2026/       csproj + year constant only
│   ├── extractor/             the net48 launcher
│   ├── navisworks-stubs/      not shipped — Autodesk API stand-in for type-checking
│   └── smoke/                 not shipped — Autodesk-free pipeline harness
├── schemas/                   extraction-cache DDL (shared with the C# writer)
├── tests/
│   ├── integration/           cross-package pipeline tests
│   └── acceptance-1.0/        the 1.0 hard-gate acceptance tests
└── docs/
    ├── PRODUCT.md             this plan
    ├── RELEASE-1.0-PLAN.md    the 1.0 directive and gate tracker
    ├── ENGINE.md
    ├── APP.md
    ├── EXTRACTION.md
    ├── WINDOWS-RUNBOOK.md
    ├── RELEASE-RUNBOOK.md
    ├── INSTALL-TRY-IT.md
    ├── DECISIONS.md
    ├── STATUS.md
    └── ORIGIN.md
```

Use a normal workspace/monorepo layout without preserving the single-file HTML build constraint.

---

## 18. Development and release workflow

### Mac development

Develop and test on the Mac:

- React UI
- TypeScript compiler
- Site Profile editor
- SQLite logic
- Spreadsheet import/export
- Model-fixture replay
- Golden hierarchy tests

Captured extraction fixtures let nearly all development run without Navisworks.

### Windows extraction/build testing

Use a private Windows self-hosted CI runner or runner group.

Recommended labels:

```text
self-hosted
windows
x64
navisworks-2025
```

Later:

```text
navisworks-2024
navisworks-2026
```

### Release pipeline

```text
Push version tag from Mac
→ run TypeScript tests
→ run legacy golden tests
→ run Windows model adapter tests
→ build Electron application
→ build Navisworks adapters
→ sign binaries/installer
→ publish artifacts to matchline-releases
→ publish update metadata
→ stable/beta clients receive the update
```

Users must retain a manual signed-installer path for offline or locked-down environments.

---

## 19. Build phases and exit criteria

### Phase 0 — Repository foundation

Deliver:

- New Matchline repo
- Origin tag and documentation
- Workspace structure
- Current SSManagement golden fixtures
- Typed domain skeleton
- CI for Mac-compatible packages

Exit criteria:

- SSManagement donor logic remains reproducible
- No changes to the SSManagement repo
- Matchline builds as 0.1.0

### Phase 1 — Navisworks 2025 extraction proof

Deliver:

- C# 2025 worker
- NWD open/extract pipeline
- Raw object/property cache
- Property Catalog
- Progress, cancellation, and diagnostics
- Representative model fixtures

Exit criteria:

- A real NWD produces a stable local cache
- No geometry is required
- All useful property categories are discoverable
- Repeating an unchanged extraction reuses cache
- Worker failure cannot corrupt the project

### Phase 2 — Model-first asset catalog and System Resolver

Deliver:

- Asset candidate filters
- Model-first canonical tags
- Tag anatomy trainer
- System Resolver
- MEL System Catalog lookup
- Direct System-column mode
- Model/MEL conflict review
- Canonical generated MEL

Exit criteria:

- Matchline can generate a credible MEL from model data
- `MAH001-10-01` can derive System Key `001` through a site rule
- A model UPN can join to MEL System Description
- A user can select one direct System column instead
- Every system value has provenance
- Conflicts are visible, not silently overwritten

### Phase 3 — Connectivity spine

Deliver:

- EasyPower import
- Cable Schedule import
- PMD import
- Identity matching to model
- Electrical Flow projection
- Flow-only/PMD-only review states

Exit criteria:

- Source-to-load flow is complete for test fixtures
- Model metadata enriches matched nodes
- Unmatched nodes remain visible
- No source-only item silently becomes model-authoritative

### Phase 4 — SSM hierarchy compiler

Deliver:

- Role graph
- Flow-anchored family inference
- Description evidence
- Hierarchy Composer
- Configurable structural boundaries
- Boundary-to-dependency fold
- SSM projection
- Manual drag overrides
- Cycle and ambiguity review

Exit criteria:

- RIO cross-System relationship becomes a dependency
- MAH/PLC/VFD/TIT family resolves within one system
- Native and SSM disciplines remain separate
- No structural relationship crosses an enabled boundary
- Rebuilds are deterministic

### Phase 5 — Site Profile Studio and one-hour workflow

Deliver:

- Commissioning Baseline pack
- Guided quick setup
- Advanced mapping
- Coverage dashboards
- Profile validation
- Impact diff
- Portable profile export/import
- Visual Trainer

Exit criteria:

- A pilot engineer can configure a new representative site within one hour
- A second revision uses the profile without remapping
- Baseline changes never overwrite site rules silently

### Phase 6 — Product hardening and updates

Deliver:

- Signed installer
- Stable/beta update channel
- Project backups and migrations
- Security review
- Crash diagnostics without project content
- Large-model performance work
- End-to-end acceptance suite

Exit criteria:

- Updates preserve projects and profiles
- All project data remains local
- Renderer has no direct filesystem/database/native access
- Extraction and compile are cancellable
- Application recovers cleanly from interrupted operations

### Phase 7 — Navisworks 2024 and 2026

Deliver:

- Separate adapters
- Adapter selection at runtime
- Version-specific extraction fixtures
- CI runner coverage
- Clear unsupported-version messaging

Exit criteria:

- 2024, 2025, and 2026 produce the same normalized extraction schema
- Profile/compiler behavior is version-independent

### Phase 8 — Pilot and standardization

Deliver:

- Multiple site pilots
- Baseline rule refinement
- Standard export templates
- Profile starter library
- Performance benchmark set
- Support/runbook documentation

Exit criteria:

- Different model organization patterns work
- Standard sites require minimal custom work
- Site-specific behavior is isolated to profiles
- Generated MEL and SSM results are accepted by engineering reviewers

---

## 20. Test matrix

### Model organization

- One file per building/discipline
- One file per building
- One file per discipline
- Federated site NWD
- Mixed internal source models
- Missing source metadata
- Conflicting source assignments

### System resolution

- Explicit model UPN + model description
- Explicit model UPN + MEL description
- Tag-derived `001` + MEL description
- Direct user-selected System column
- Composite Area + System Code
- Model/tag/MEL conflict
- Leading-zero mismatch
- Missing System Key
- Duplicate System descriptions

### Identity

- Exact model/source tags
- Prefix/suffix variants
- Accepted aliases
- Duplicate model tags
- Ambiguous suffix
- Fuzzy candidate requiring review

### Relationships

- Same-system structural parent
- Cross-system dependency
- Cross-building dependency
- Discipline display difference with valid structural chain
- Discipline enabled as hard boundary
- Multiple feeds
- Alternate dependencies
- Cycle
- Equal-priority parent conflict
- Manual override

### Outputs

- Electrical Flow
- SSM Hierarchy
- Canonical MEL
- Site-template MEL
- Existing MEL comparison
- Provenance
- Diff report
- Predecessor matrix
- Repeated deterministic build

---

## 21. Product acceptance criteria

### Ease of setup

- A standard site reaches first useful preview with the baseline and suggestions
- A single engineer completes first Site Profile setup within one hour
- Subsequent revisions require no repeated mapping unless the schema changed

### Correctness

- 100% of output rows are traceable to source evidence or a manual decision
- Zero silent parent conflicts
- Zero structural parent links crossing enabled boundaries
- Every cross-boundary feed is retained as a dependency
- Every duplicate tag is visible
- Every source-only item is visible
- Same inputs and profile produce the same output

### Locality

- No project content is transmitted
- No cloud account is required
- SQLite and all runtime components ship with the app
- Update checking can be disabled
- Manual offline update remains available

### Performance

- Raw model metadata never floods the renderer
- Extraction streams into local storage
- Tables and trees are virtualized
- Unchanged models reuse hash-addressed caches
- Rule/hierarchy changes do not reopen NWDs
- Replacing one model invalidates only dependent stages
- Long operations are cancellable with visible progress

---

## 22. First production scope

### Required for initial production

- Matchline desktop shell
- Navisworks Manage 2025 extraction
- NWD metadata cache
- Property Catalog
- Model-first asset universe
- Tag anatomy
- Configurable System Resolver
- Hierarchy Composer and boundary rules
- EasyPower/Cable/PMD imports
- Electrical Flow
- SSM Hierarchy
- Generated MEL
- Site Profiles
- Review/QA
- Local SQLite project
- Signed update path

### Required before broad multi-site rollout

- Navisworks 2024 and 2026 adapters
- One-hour setup validation on several sites
- Stable baseline rule pack
- Existing MEL comparison
- Profile migration/update safeguards
- Large-model hardening
- Full provenance and diff exports

### Deliberate non-goals for v1

- Cloud processing or storage
- Multiuser live collaboration
- Editing NWD geometry
- Full 3D model viewer
- Automatic writes back into Navisworks
- Hidden AI decisions
- Requiring a separate database installation
- Requiring the MEL to seed the asset universe

---

## 23. Immediate implementation epic

The first epic should prove the new upstream foundation before rebuilding every SSManagement screen.

### Epic: Model to System-aware MEL

1. Create `matchline`
2. Record SSManagement 4.2.2 origin
3. Establish Electron/React/TypeScript workspace
4. Create shared extraction schema
5. Build Navisworks 2025 metadata worker
6. Extract one real NWD into SQLite cache
7. Build Property Catalog
8. Map Equipment Tag and asset filters
9. Teach tag anatomy including System segment
10. Build System Resolver with:
    - direct model field
    - tag-derived field
    - MEL lookup
    - direct System column
    - fallback order
11. Build configurable Hierarchy Composer
12. Export canonical generated MEL
13. Save/reload the Site Profile
14. Re-run the same NWD deterministically
15. Replace the NWD and show the MEL diff

That epic validates the single most valuable premise:

> The model can become the authoritative equipment register, while the site controls how System and hierarchy are resolved.

After that proof, bring the existing EasyPower, Cable, PMD, claim resolver, hierarchy, review, and export behavior across in controlled packages.

---

## 24. Final architecture statement

Matchline should be a local, model-first commissioning compiler.

- Navisworks establishes the authoritative equipment universe.
- The Site Profile determines how raw metadata, tag anatomy, and optional MEL lookups resolve System and hierarchy fields.
- EasyPower, Cable Schedule, and PMD establish the connectivity spine.
- One canonical evidence graph preserves every observation and relationship.
- Electrical Flow projects physical connectivity.
- SSM Hierarchy projects configurable grouping and structural parentage.
- Relationships crossing a selected boundary become dependencies.
- The same resolved snapshot produces a complete, model-derived MEL and all commissioning exports.
- A standard baseline makes new sites fast.
- Site overrides make the product universal.
- Everything stays local.
