/**
 * The pipeline (ENGINE.md E3, "the orchestrator that owns the E1 property-bag
 * seam").
 *
 * Eleven stages, in the one order they can run in, each reading only what the
 * stages above it produced. Every engine package is deliberately decoupled from
 * the packages that feed it -- the resolver takes property bags, claims assembly
 * takes flat facts, the exporter takes its own flattened row shape -- and the
 * adapters between them are what this file is. Nothing here decides anything a
 * package could have decided; it converts, it orders, and it publishes.
 *
 * Determinism is the whole contract (ENGINE.md binding rule 3): every stage is
 * pure, every list is built by iterating `catalog.assets` in catalog order or is
 * sorted by content downstream, and nothing reads a clock, a locale or the
 * filesystem. Two runs over the same sources, workbooks and profile produce a
 * deep-equal `CompiledProject` and byte-identical MEL workbook bytes.
 *
 * Many sources, one project (RELEASE-1.0-PLAN P0-1). The universe is ordered by
 * `sourceId` before anything reads it, so registering the same two files in the
 * other order is the same compile; every per-asset cache read goes through the
 * asset's own source, because an object ordinal addresses nothing without one.
 */
import {
  chainFor,
  EVIDENCE_TIER,
  migrateDerivedAttributes,
  migrateHierarchyConfig,
  migratePropertyMappings,
  migrateSourceAssignmentRules,
} from '@matchline/domain';
import type {
  CompletenessReport,
  DeadClaimRuleReviewItem,
  DerivedAttributeDefinition,
  ManualRelationshipOverride,
  PropertyChain,
  PropertyMappings,
  PropertyRef,
  Provenance,
  ResolvedAssetNode,
  ReviewItem,
  SystemResolution,
  SystemResolverConfig,
  TagAnatomyConfig,
} from '@matchline/domain';
import {
  buildAssetCatalog,
  buildUniversePropertyCatalog,
  orderCatalogSources,
} from '@matchline/asset-catalog';
import type { ModelAsset } from '@matchline/asset-catalog';
import { reconcileLedger } from '@matchline/asset-identity';
import { importConnectivityWorkbook } from '@matchline/connectivity-import';
import type { ConnectivityObservation, ConnectivityWorkbookReport } from '@matchline/connectivity-import';
import { buildElectricalFlowFromIndex } from '@matchline/electrical-flow';
import type { FlowEnrichment } from '@matchline/electrical-flow';
import { buildIdentityIndex, resolveTag } from '@matchline/identity';
import type { IdentityConfig } from '@matchline/identity';
import { proposeNestings } from '@matchline/learned-rules';
import type { NestingAsset, ProposedNesting } from '@matchline/learned-rules';
import { buildCanonicalMelRows, writeCanonicalMelWorkbook } from '@matchline/mel-export';
import type { GeneratedMelAsset } from '@matchline/mel-export';
import { assembleRelationshipClaims } from '@matchline/relationship-claims';
import type {
  ClaimSubject,
  FlowEdgeInput,
  LearnedClaimInput,
  MelParentInput,
  ResolveTag,
  SkippedClaimInput,
} from '@matchline/relationship-claims';
import { readMelTable } from '@matchline/spreadsheet-import';
import { auditCompiledProject } from '@matchline/ssm-audit';
import { equipmentClass } from '@matchline/ssm-audit/classify';
import { compileSnapshot, hierarchyTree } from '@matchline/ssm-compiler';
import type { CompileSubject } from '@matchline/ssm-compiler';
import { buildSystemCatalog, resolveSystems, UNSTATED_ROW } from '@matchline/system-resolver';
import type {
  MelCatalogRow,
  ResolveContext,
  ResolverSubject,
  SystemCatalog,
  SystemCatalogResult,
} from '@matchline/system-resolver';
import { applyAnatomy } from '@matchline/tag-anatomy';

import {
  attributesFor,
  icSystemKeyOf,
  sopTagFactsOf,
  ssmDisciplineOf,
  IC_DISCIPLINE_RULE,
} from './attributes.js';
import { buildCompleteness } from './completeness.js';
import {
  anatomyResultOf,
  derivedAttributesFor,
  derivedNeedsAnatomy,
  validateDerivedAttributes,
  NO_MEL_JOIN,
} from './derived.js';
import type { MelJoinIndex, MelRecord } from './derived.js';
import {
  applyLedgerMapping,
  decisionResolverOf,
  ledgerCandidateOf,
  possibleRematches,
  resolveDerivedAssignments,
  resolveManualAssignments,
  resolveManualOverrides,
} from './identity-ledger.js';
import { modelTreeParents } from './model-tree.js';
import {
  propertyFrom,
  readAssetProperties,
  resolverSubjectOf,
  sourceFileOf,
  sourceModelFileNames,
} from './properties.js';
import type { AssetPropertyBag } from './properties.js';
import { aggregateReviewItems } from './review.js';
import { ssmAuditReviewItems } from './ssm-audit.js';
import { DEFAULT_MEL_SHEET } from './types.js';
import { validateProfile } from './validate.js';
import type {
  CompiledProject,
  CompileProjectInput,
  CompileStage,
  CompileStats,
  DerivedAssetAttributes,
  DerivedAttributeValue,
  MelWorkbookInput,
  ModelSourceInput,
  SourceAssetCount,
  SsmDisciplineProjection,
} from './types.js';

/**
 * The resolver config a profile with no System Resolver section gets.
 *
 * Every subject resolves to nothing, which is the truthful answer for a site
 * that has not said how it names systems -- and it keeps the stage in the
 * pipeline rather than making every downstream consumer handle "systems were
 * skipped" as a separate state.
 */
const NO_SYSTEM_RESOLVER: SystemResolverConfig = {
  keyChain: [],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** A workbook's `(category, name)` pair, as provenance prints it. */
function propertyLabel(category: string, name: string): string {
  return `${category} > ${name}`;
}

/** Trimmed, or `undefined` when the cell says nothing. */
function stated(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * One MEL record as the System Resolver reads it.
 *
 * `upn` is the system key. PRODUCT.md §2.3 puts it plainly -- "System Key =
 * UPN" for a common site -- and `@matchline/spreadsheet-import`'s `MelMapping`
 * names the column accordingly; a site that spells it something else maps its
 * own header onto the same field. A row that states neither a tag nor a key nor
 * a description is dropped: it can join to nothing and describes nothing.
 *
 * No `row` is recorded. `readMelTable` returns records, not addresses: blank
 * rows are dropped on the way out, so a position in the returned array is not a
 * sheet row and pretending otherwise would put a wrong row number on real
 * provenance. The resolver stamps `UNSTATED_ROW` and the sheet name stands.
 */
function melCatalogRow(
  row: Readonly<Record<string, string | undefined>>,
  sourceFile: string,
  sheet: string,
): MelCatalogRow | null {
  const equipmentTag = stated(row['equipmentTag']);
  const systemKey = stated(row['upn']);
  const systemDescription = stated(row['systemDescription']);
  if (equipmentTag === undefined && systemKey === undefined && systemDescription === undefined) {
    return null;
  }
  return {
    ...(equipmentTag === undefined ? {} : { equipmentTag }),
    ...(systemKey === undefined ? {} : { systemKey }),
    ...(systemDescription === undefined ? {} : { systemDescription }),
    sourceFile,
    sheet,
  };
}

/**
 * The separators a "System Parent" cell may list several parents with.
 *
 * A MEL is a document people type into, and a cell naming two parents spells it
 * with a comma or a semicolon. Nothing else is treated as a separator: a tag
 * with a space in it is a tag, not two.
 */
const MEL_PARENT_SEPARATORS = /[,;]/;

/** The System Parent tags one row states, in the order it states them. */
function melParentTags(cell: string | undefined): ReadonlyArray<string> {
  if (cell === undefined) {
    return [];
  }
  return cell
    .split(MEL_PARENT_SEPARATORS)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** What one MEL workbook contributes, read once. */
interface MelReadResult {
  readonly rows: ReadonlyArray<MelCatalogRow>;
  readonly catalog: SystemCatalog;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
  /**
   * The workbook's own records, grouped by tag, for the derived `mel-lookup`
   * rung (P0-7) and for the MEL parent rung.
   *
   * `MelCatalogRow` carries only the three fields the System Resolver joins on;
   * a derived attribute may return any column the project mapped -- `building`,
   * `discipline`, `projectPhase` -- so the records are kept as read rather than
   * projected down and then re-read. They are keyed by TAG here and re-keyed by
   * asset id once identity exists; the tag is all a workbook knows.
   */
  readonly byTag: ReadonlyMap<string, ReadonlyArray<MelRecord>>;
  /** The `mel-parent` rung's inputs (§11.1), one per row stating a parent. */
  readonly parents: ReadonlyArray<MelParentInput>;
  readonly sourceFile: string;
  readonly sheet: string;
  /**
   * Rows that stated no tag, no key and no description.
   *
   * They join to nothing and describe nothing, so they are dropped -- and until
   * now dropped without saying so. A MEL whose mapping names the wrong columns
   * produces a workbook of them, which is a thing a person can fix the moment
   * they are told the number (audit low finding).
   */
  readonly droppedRowCount: number;
}

/** Stage 3: the MEL, or the empty catalog a MEL-less compile runs on. */
function readMel(mel: MelWorkbookInput | undefined): MelReadResult {
  if (mel === undefined) {
    return {
      rows: [],
      catalog: new Map(),
      reviewItems: [],
      byTag: new Map(),
      parents: [],
      sourceFile: NO_MEL_JOIN.sourceFile,
      sheet: NO_MEL_JOIN.sheet,
      droppedRowCount: 0,
    };
  }

  const sheet = mel.sheetName ?? DEFAULT_MEL_SHEET;
  const table = readMelTable(mel.bytes, sheet, mel.mapping, mel.headerRow ?? 0);

  const rows: MelCatalogRow[] = [];
  const byTag = new Map<string, MelRecord[]>();
  const parents: MelParentInput[] = [];
  let droppedRowCount = 0;
  for (const record of table.rows) {
    const row = melCatalogRow(record, mel.sourceFile, sheet);
    if (row === null) {
      droppedRowCount += 1;
    } else {
      rows.push(row);
    }
    const tag = stated(record['equipmentTag']);
    if (tag === undefined) {
      continue;
    }
    // Every row stating the tag, in workbook order: the rung takes the first one
    // that also states the field it asked for, exactly as the resolver's own tag
    // join does.
    const bucket = byTag.get(tag);
    if (bucket === undefined) {
      byTag.set(tag, [record]);
    } else {
      bucket.push(record);
    }

    // The donor's primary structural source, kept rather than dropped. No row
    // number is recorded for the same reason `melCatalogRow` records none: a
    // position in `table.rows` is not a sheet row once blank rows are gone, and
    // a wrong row number on real provenance is worse than an unstated one.
    const parentTags = melParentTags(record['systemParent']);
    if (parentTags.length > 0) {
      parents.push({
        childTag: tag,
        parentTags,
        provenance: {
          sourceFile: mel.sourceFile,
          sourceRef: { kind: 'sheet-row', sheet, row: UNSTATED_ROW },
          propertyOrColumn: 'System Parent',
        },
      });
    }
  }

  const built: SystemCatalogResult = buildSystemCatalog(rows);
  return {
    rows,
    catalog: built.catalog,
    reviewItems: built.reviewItems,
    byTag,
    parents,
    sourceFile: mel.sourceFile,
    sheet,
    droppedRowCount,
  };
}

/** Anatomy segments for one tag, or nothing when the site taught no anatomy. */
function anatomyOf(
  anatomy: TagAnatomyConfig | undefined,
  canonicalTag: string,
): {
  readonly role?: string;
  readonly familyKey?: string;
  readonly system?: string;
  readonly instance?: string;
} {
  if (anatomy === undefined || canonicalTag === '') {
    return {};
  }
  const result = applyAnatomy(anatomy, canonicalTag);
  if (!result.matched) {
    return {};
  }
  const role = result.segments.role;
  // `system` and `instance` are carried for the SOP rules, which pair a device
  // to equipment by the UPN and instance in its tag. A site that taught both
  // segments has already said where they live, which is why `sopTagFactsOf`
  // prefers them over reading the approved list out of the tag.
  const system = result.segments.system;
  const instance = result.segments.instance;
  return {
    ...(role === undefined ? {} : { role }),
    ...(result.familyKey === undefined ? {} : { familyKey: result.familyKey }),
    ...(system === undefined ? {} : { system }),
    ...(instance === undefined ? {} : { instance }),
  };
}

/** One source, plus the two cache facts every asset of it is read against. */
interface SourceContext {
  readonly source: ModelSourceInput;
  /** Source-model id -> file name, flattened across appended models. */
  readonly fileNames: ReadonlyMap<number, string>;
  /** What this source's cache was extracted from. Never blank. */
  readonly inputFileName: string;
}

/**
 * Compile one project: a model universe + spreadsheets + Site Profile in, every
 * stage's output out.
 *
 * The caches are the caller's: they are read, never written and never closed
 * here, so one set of open handles can serve a compile, a re-compile under an
 * edited profile, and whatever the UI does between them.
 *
 * @throws AssetCatalogConfigError when two sources share a `sourceId`, when one
 * is blank, or when the profile names a selection set no source contains.
 */
export function compileProject(input: CompileProjectInput): CompiledProject {
  const { profile } = input;
  const anatomy = profile.tagAnatomy;
  /**
   * Announce a stage. Observation only -- see `CompileStageListener`: nothing
   * below reads a return value, so a compile with a listener and a compile
   * without one decide exactly the same things.
   */
  const onStage = input.onStage;
  const stage =
    onStage === undefined
      ? (_stage: CompileStage): void => {}
      : (name: CompileStage): void => {
          onStage(name);
        };
  // The mappings in the one shape the pipeline reads them in (P0-8). A profile
  // written before chains spells each field as a single `PropertyRef`; it is
  // lifted here, once, so nothing below has two shapes to handle -- and the
  // asset catalog is handed the profile's own value so the two entry points
  // cannot disagree about what a lifted mapping means.
  const mappings: PropertyMappings = migratePropertyMappings(profile.propertyMappings);
  /** The tag chain one source reads through, per-source overrides included. */
  const tagChainOf = (sourceId: string): PropertyChain =>
    chainFor(mappings.equipmentTag, sourceId);
  // Refused before a single cache is read: a definition that shadowed a built-in
  // attribute key would change where equipment is filed without saying so.
  const declaredDerived = validateDerivedAttributes(
    migrateDerivedAttributes(profile.derivedAttributes),
  );
  // And the rest of the profile, before a single cache is read. A ladder tier or
  // a level key the engine does not have is silently disabled rather than
  // refused, which is the one failure mode a person cannot see (see
  // `validateProfile`).
  validateProfile(profile, declaredDerived);
  // The projection as the attribute helpers read it. Always built, never
  // optional: an empty table rewrites nothing, which is exactly what "this site
  // stated no rewrites" has always meant.
  //
  // Keys are trimmed on the way in because `ssmDisciplineOf` looks a TRIMMED
  // native discipline up in this map: a profile row typed as `"Mechanical "`
  // would otherwise never match the discipline it was written for, and the
  // rewrite would silently do nothing.
  const disciplineProjection: SsmDisciplineProjection = new Map(
    profile.ssmDisciplineProjection.map((rewrite) => [rewrite.from.trim(), rewrite.to] as const),
  );

  // The universe, in the one order every stage reads it in. `orderCatalogSources`
  // is `@matchline/asset-catalog`'s own ordering and validation, borrowed rather
  // than restated: the catalog and the compiler disagreeing about what a valid
  // universe is, or about which source is read first, is the whole class of bug
  // this shares one implementation to rule out.
  const sources = orderCatalogSources(input.sources);

  // --- 1. the model-first asset universe -----------------------------------
  stage('asset-catalog');
  const modelCatalog = buildAssetCatalog(
    sources,
    profile.propertyMappings,
    profile.assetFilters,
    migrateSourceAssignmentRules(profile.sourceAssignments),
  );
  // One streaming pass per cache, for a value only a property picker reads. Not
  // run unless it was asked for (see `includePropertyCatalog`).
  const propertyCatalog =
    input.includePropertyCatalog === true ? buildUniversePropertyCatalog(sources) : [];

  // --- 2. the property-bag seam --------------------------------------------
  // One pass over the owning source's cache per asset, and every consumer of the
  // raw bag is served from it: the resolver subject, the claim subject's
  // explicit parent tag, and the identity ledger's stable-id property. Reading
  // it twice would double the only I/O the compile does.
  const contexts = new Map<string, SourceContext>();
  for (const source of sources) {
    contexts.set(source.sourceId, {
      source,
      fileNames: sourceModelFileNames(source.cache),
      inputFileName: source.cache.meta().inputFileName,
    });
  }
  const contextOf = (asset: ModelAsset): SourceContext => {
    const context = contexts.get(asset.sourceId);
    if (context === undefined) {
      // Unreachable: every asset was produced from `sources` a few lines up.
      // Stated rather than defaulted, because the fallback would be reading
      // another source's object of the same ordinal and calling it this asset.
      throw new Error(
        `the asset catalog produced ${JSON.stringify(asset.assetId)} from an ` +
          `unregistered source ${JSON.stringify(asset.sourceId)}`,
      );
    }
    return context;
  };

  // --- 2b. stable asset identity (P0-9) --------------------------------------
  stage('identity-ledger');
  // THE SPLICE POINT. The catalog derives an id from the content it read, which
  // is stable for one compile and wrong across two -- a corrected tag would mint
  // a new id and orphan every decision recorded against the old one. The ledger
  // decides the id instead, and it is applied here, exactly once, before any
  // stage has keyed anything: everything below reads ledger ids only.
  //
  // The model half of the evidence is already on the asset. The stable-id
  // property is not -- it lives in the bag, and the bag is read below, after the
  // ids are settled. Reading it here costs a second pass over the caches, so it
  // is taken ONLY when the site mapped one: holding every asset's whole bag in
  // memory to save that pass would be a per-asset property map for a project
  // with 40k assets and a million property rows.
  const stableIdProperty = profile.stableIdProperty;
  const stableIds: ReadonlyArray<string | undefined> =
    stableIdProperty === null
      ? []
      : modelCatalog.assets.map((asset) => {
          const bag = readAssetProperties(
            contextOf(asset).source.cache,
            asset,
            tagChainOf(asset.sourceId),
          );
          return propertyFrom(bag, stableIdProperty)?.value;
        });

  const ledgerResult = reconcileLedger(
    input.identityLedger ?? null,
    modelCatalog.assets.map((asset, index) => ledgerCandidateOf(asset, stableIds[index])),
  );
  const catalog = applyLedgerMapping(modelCatalog, ledgerResult.mapping);
  const identityLedger = ledgerResult.ledger;
  // The subset of tag-tier re-matches where a reused tag is as likely as a
  // re-tagged unit. The re-match itself has already happened -- refusing it
  // would orphan every decision recorded against the id -- so this is a
  // question, not a refusal (P0-9).
  const rematchQuestions = possibleRematches(input.identityLedger ?? null, ledgerResult);

  stage('properties');
  const sourceFiles = new Map<string, string>();
  const subjects: ResolverSubject[] = [];
  const claimSubjects: ClaimSubject[] = [];
  for (const asset of catalog.assets) {
    const context = contextOf(asset);
    const bag = readAssetProperties(context.source.cache, asset, tagChainOf(asset.sourceId));
    const sourceFile = sourceFileOf(asset, context.fileNames, context.inputFileName);
    sourceFiles.set(asset.assetId, sourceFile);
    subjects.push(resolverSubjectOf(asset, bag, sourceFile));
    claimSubjects.push(
      claimSubjectOf(asset, bag, sourceFile, anatomy, profile.parentTagProperty ?? undefined),
    );
  }
  /** The document an asset was read from. Filled for every catalog asset above. */
  const sourceFileFor = (asset: ModelAsset): string =>
    sourceFiles.get(asset.assetId) ?? contextOf(asset).inputFileName;

  // --- 2c. stored decisions, re-addressed through the ledger ------------------
  stage('stored-decisions');
  // A project file holds decisions taken against the ids an earlier compile
  // published. They are re-aimed here, once, so every rung below sees decisions
  // about assets that exist -- and the ones that cannot be re-aimed become
  // review items rather than silence.
  const resolveDecisionRef = decisionResolverOf(catalog.assets, identityLedger);
  const manualParents = resolveManualOverrides(
    input.manualRelationshipOverrides ?? [],
    resolveDecisionRef,
  );
  const manualSystems =
    input.manualSystemAssignments === undefined
      ? null
      : resolveManualAssignments(input.manualSystemAssignments, resolveDecisionRef);
  // A derived attribute's `manual` rung is a person's own table, keyed by asset
  // id exactly like a parent decision -- and until now the only stored decision
  // that was NOT re-addressed through the ledger, so a re-keyed asset silently
  // lost a hand-assigned boundary value. Same treatment, same review item.
  const derivedAssignments = resolveDerivedAssignments(declaredDerived, resolveDecisionRef);
  const derivedDefinitions: ReadonlyArray<DerivedAttributeDefinition> =
    derivedAssignments.definitions;

  /** The one file this project was extracted from, or `null` once there are two. */
  const soleSource = sources.length === 1 ? sources[0] : undefined;
  const soleInputFileName =
    soleSource === undefined ? null : (contexts.get(soleSource.sourceId)?.inputFileName ?? null);

  // --- 3. the MEL and the System Catalog ------------------------------------
  stage('mel');
  const mel = readMel(input.melWorkbook);

  // --- 4. system resolution --------------------------------------------------
  stage('systems');
  const resolveContext: ResolveContext = {
    ...(anatomy === undefined ? {} : { anatomy }),
    catalog: mel.catalog,
    melRows: mel.rows,
    ...(manualSystems === null ? {} : { manual: manualSystems.assignments }),
  };
  const systems = resolveSystems(
    subjects,
    profile.systemResolver ?? NO_SYSTEM_RESOLVER,
    resolveContext,
  );
  // The SSM SOP's instrumentation rule, opt-in per profile (P0 layer 2). Off
  // for a migrated profile, because turning it on moves assets between
  // disciplines and systems and nobody asked for that on a reopen.
  const applyIcRule = profile.systemResolver?.applyIcDisciplineRule ?? false;

  /**
   * The resolution one asset actually carries, I&C rule included.
   *
   * The rule is applied HERE rather than in `attributesFor` alone so that the
   * hierarchy, the generated MEL and the EXTO sheet cannot disagree about which
   * system a transmitter is on. The chain's own claims are untouched -- every
   * one of them is still on `systems` for review -- and the override records
   * itself as one more `Provenance` entry on the resolution's evidence, so a
   * changed key is never a value that appeared from nowhere.
   */
  const icResolutions = new Map<string, SystemResolution>();
  if (applyIcRule) {
    for (const asset of catalog.assets) {
      const upn = icSystemKeyOf(asset.canonicalTag, asset.nativeDiscipline, true);
      if (upn === undefined) {
        continue;
      }
      const resolved = systems.bySubject.get(asset.assetId)?.resolution ?? null;
      if (resolved !== null && resolved.systemKey === upn) {
        continue;
      }
      const evidence: Provenance = {
        rule: IC_DISCIPLINE_RULE,
        fallbackRung: 0,
        sourceFile: '',
        sourceRef: { kind: 'model-object', objectId: asset.assetId },
        propertyOrColumn: 'approved UPN in the equipment tag',
      };
      icResolutions.set(asset.assetId, {
        systemKey: upn,
        ...(resolved?.systemDescription === undefined
          ? {}
          : { systemDescription: resolved.systemDescription }),
        // The label follows the key it now carries, not the one it had.
        systemLabel: resolved?.systemDescription === undefined
          ? upn
          : `${upn} ${resolved.systemDescription}`,
        systemEvidence: [evidence, ...(resolved?.systemEvidence ?? [])],
        systemConfidenceTier: EVIDENCE_TIER.INFERRED,
        systemConflictStatus: resolved === null ? 'AGREED' : resolved.systemConflictStatus,
      });
    }
  }

  const resolutionOf = (assetId: string): SystemResolution | null =>
    icResolutions.get(assetId) ?? systems.bySubject.get(assetId)?.resolution ?? null;

  // --- 5. identity ------------------------------------------------------------
  stage('identity-index');
  // The profile's anatomy enables the anatomy tier unless the caller states its
  // own: one taught tag shape should not have to be configured twice.
  const identityConfig: IdentityConfig = {
    ...(profile.identityConfig.tagNormalization.length === 0
      ? {}
      : { tagNormalization: profile.identityConfig.tagNormalization }),
    ...(profile.identityConfig.aliases.length === 0
      ? {}
      : {
          aliases: new Map(
            profile.identityConfig.aliases.map((alias) => [alias.from, alias.to] as const),
          ),
        }),
    ...(profile.identityConfig.fuzzyMaxDistance === undefined
      ? {}
      : { fuzzyMaxDistance: profile.identityConfig.fuzzyMaxDistance }),
    ...(anatomy === undefined ? {} : { anatomy }),
  };
  const identityIndex = buildIdentityIndex(
    catalog.assets.map((asset) => ({
      assetId: asset.assetId,
      canonicalTag: asset.canonicalTag,
    })),
    identityConfig,
  );

  // --- 6. connectivity --------------------------------------------------------
  stage('connectivity');
  const connectivityReports: ConnectivityWorkbookReport[] = [];
  const observations: ConnectivityObservation[] = [];
  for (const workbook of input.connectivityWorkbooks ?? []) {
    const report = importConnectivityWorkbook(
      workbook.bytes,
      workbook.sourceFile,
      workbook.overrides ?? {},
    );
    connectivityReports.push(report);
    observations.push(...report.observations);
  }

  // --- 7. the Electrical Flow projection --------------------------------------
  stage('flow');
  const enrichment = new Map<string, FlowEnrichment>();
  for (const asset of catalog.assets) {
    const resolution = resolutionOf(asset.assetId);
    enrichment.set(asset.assetId, {
      ...(asset.description === undefined ? {} : { description: asset.description }),
      ...(asset.equipmentType === undefined ? {} : { equipmentType: asset.equipmentType }),
      ...(asset.building === undefined ? {} : { building: asset.building }),
      ...(asset.nativeDiscipline === undefined
        ? {}
        : { nativeDiscipline: asset.nativeDiscipline }),
      ...(resolution === null
        ? {}
        : { systemKey: resolution.systemKey, systemLabel: resolution.systemLabel }),
      sourceModelFile: sourceFileFor(asset),
    });
  }
  // `buildElectricalFlowFromIndex` resolves the observation tags once and
  // carries identity's own review items onto `flow.reviewItems`; those ARE the
  // identity batch's items, which is why no second batch runs here.
  const flow = buildElectricalFlowFromIndex(observations, identityIndex, enrichment);

  // --- 8. relationship claims --------------------------------------------------
  stage('claims');
  // Only edges whose two ends are both model-confirmed can become claims: a
  // source-only node carries no assetId, and inventing one would make a
  // spreadsheet model-authoritative (ENGINE.md binding rule 1).
  const flowEdges: FlowEdgeInput[] = [];
  for (const edge of flow.edges) {
    const from = flow.nodes.get(edge.fromNodeId);
    const to = flow.nodes.get(edge.toNodeId);
    if (from?.assetId === undefined || to?.assetId === undefined) {
      continue;
    }
    flowEdges.push({
      fromAssetId: from.assetId,
      toAssetId: to.assetId,
      relationshipType: edge.relationshipType,
      provenance: edge.provenance,
    });
  }

  const learnedProposals: ReadonlyArray<ProposedNesting> =
    input.learnedRules === undefined
      ? []
      : proposeNestings(
          input.learnedRules,
          catalog.assets.map((asset) =>
            nestingAssetOf(
              asset,
              resolutionOf(asset.assetId),
              anatomy,
              disciplineProjection,
              applyIcRule,
            ),
          ),
        );
  const learned: LearnedClaimInput[] = learnedProposals.map((proposal) => ({
    childAssetId: proposal.childAssetId,
    parentAssetId: proposal.parentAssetId,
    ruleDetail: proposal.ruleDetail,
    confidence: proposal.confidence,
    grade: proposal.grade,
  }));

  /**
   * The identity bridge every tag-borne structural rung goes through.
   *
   * Two things it deliberately does NOT do. It does not resolve a tag several
   * assets carry: identity answers "the first id in code-unit order", which is
   * right for enrichment and wrong for a parent -- a profile row naming a
   * duplicated tag has not said which copy, and picking one would nest a site's
   * equipment under whichever spelling sorted first. Assembly is told
   * `duplicate` and skips the input loudly.
   *
   * And it does not rank fuzzy proposals. Fuzzy never matches (§9.2), so for a
   * caller that reads only "did it match" the tier changes no answer and costs a
   * bounded Levenshtein against every asset in the index -- per unmatched tag,
   * on every profile row, on a 40,000-asset site. Fuzzy stays where it is
   * review-only: the connectivity endpoints, resolved by
   * `buildElectricalFlowFromIndex`.
   */
  const bridge: ResolveTag = (tag) => {
    const outcome = resolveTag(identityIndex, tag, { includeFuzzy: false });
    if (outcome.status !== 'matched') {
      return null;
    }
    return outcome.sharingAssets > 1
      ? { duplicate: true, sharingAssets: outcome.sharingAssets }
      : outcome.assetId;
  };

  /**
   * The MEL's rows, re-addressed onto the assets they are about.
   *
   * The join runs through identity rather than comparing strings, so the
   * normalization, aliases and anatomy a site taught apply to its MEL exactly as
   * they apply to its cable schedule. A row whose tag resolves to nothing, or to
   * several assets, joins to nothing -- the same refusals every other tag-borne
   * input takes.
   */
  const melByAsset = new Map<string, MelRecord[]>();
  for (const [tag, records] of mel.byTag) {
    const outcome = resolveTag(identityIndex, tag, { includeFuzzy: false });
    if (outcome.status !== 'matched' || outcome.sharingAssets > 1) {
      continue;
    }
    const bucket = melByAsset.get(outcome.assetId);
    if (bucket === undefined) {
      melByAsset.set(outcome.assetId, [...records]);
    } else {
      bucket.push(...records);
    }
  }
  const melJoin: MelJoinIndex = {
    byAsset: melByAsset,
    sourceFile: mel.sourceFile,
    sheet: mel.sheet,
  };

  const manualOverrides: ReadonlyArray<ManualRelationshipOverride> = manualParents.overrides;

  const claims = assembleRelationshipClaims(claimSubjects, {
    // Passed only when the site stated something. An empty role graph behaves
    // like an absent one, but saying "no rules" and saying nothing are the same
    // fact and the assembler should be handed one of them, not both.
    ...(profile.roleGraph.rules.length === 0 ? {} : { roleGraph: profile.roleGraph }),
    ...(profile.profileLookup.length === 0 ? {} : { profileLookup: profile.profileLookup }),
    ...(profile.priorSsm.length === 0 ? {} : { priorSsm: profile.priorSsm }),
    flowEdges,
    learned,
    manualOverrides,
    // The MEL's own System Parent column (§11.1). Only reaches the ladder when
    // the site's profile lists the `mel-parent` rung; the claims exist either
    // way, because a claim nobody walked is still evidence.
    ...(mel.parents.length === 0 ? {} : { melParents: mel.parents }),
    // The SSM SOP's own nesting rules, and only when the site's ladder carries
    // the rung. Unlike every other source these also produce DEPENDENCY claims,
    // which no ladder would have filtered -- so the switch has to be here, at
    // the point the source is offered, rather than downstream at the walk.
    ...(profile.ladder.tiers.includes('sop-rule') ? { sopRules: profile.sopRules } : {}),
    resolveTag: bridge,
    // Profile-borne claims address the published profile they came out of, so a
    // re-compile under a new version explains itself.
    profileSource: { sourceFile: profile.profileId, profileRevision: String(profile.version) },
    // Assembly's fallback for an explicit-model claim whose subject carried no
    // provenance. `claimSubjectOf` always states both together, so this never
    // fires from here -- and once a project holds several files there is no one
    // document to name, so it is only offered when there is exactly one.
    // Naming an arbitrary source would be a wrong file name rather than none.
    ...(soleInputFileName === null ? {} : { modelSourceFile: soleInputFileName }),
  });

  // --- 8b. derived attributes (P0-7) -------------------------------------------
  stage('derived-attributes');
  // After systems, because a `system-field` rung reads what the resolver settled
  // on; before the snapshot, because a level may group, label or bound on a
  // derived key and the fold has to see it. The subjects built in stage 2 still
  // carry every asset's property bag, so no cache is read a second time.
  const derivedByAsset = new Map<string, ReadonlyArray<DerivedAttributeValue>>();
  // Asked once rather than per asset: a registry that reads only properties and
  // the MEL should not pay for 40,000 tag parses to find that out.
  const derivedAnatomy = derivedNeedsAnatomy(derivedDefinitions) ? anatomy : undefined;
  // A project that defines none publishes nothing rather than one empty row per
  // asset: "this project derives no attributes" and "every asset resolved to
  // nothing" are different statements, and only the second needs 40,000 rows.
  const derivedAttributes: ReadonlyArray<DerivedAssetAttributes> =
    derivedDefinitions.length === 0
      ? []
      : catalog.assets.map((asset, index): DerivedAssetAttributes => {
          const subject = subjects[index];
          const values =
            subject === undefined
              ? []
              : derivedAttributesFor(
                  derivedDefinitions,
                  {
                    asset,
                    subject,
                    resolution: resolutionOf(asset.assetId),
                    anatomy: anatomyResultOf(derivedAnatomy, asset.canonicalTag),
                  },
                  melJoin,
                );
          if (values.length > 0) {
            derivedByAsset.set(asset.assetId, values);
          }
          return { assetId: asset.assetId, values };
        });

  // --- 9. the resolved snapshot ------------------------------------------------
  stage('snapshot');
  // The model tree is the one ladder rung assembled here rather than in
  // `@matchline/relationship-claims`: it is a fact about the extraction caches,
  // and the caches are the orchestrator's to read. One walk per source, never
  // across -- a tree is what one file drew.
  const treeParents = modelTreeParents(sources, catalog.assets);
  const compileSubjects: CompileSubject[] = catalog.assets.map((asset) => {
    const modelTreeParentId = treeParents.get(asset.assetId);
    return {
      assetId: asset.assetId,
      attributes: attributesFor(
        asset,
        resolutionOf(asset.assetId),
        disciplineProjection,
        derivedByAsset.get(asset.assetId),
        applyIcRule,
      ),
      ...(modelTreeParentId === undefined ? {} : { modelTreeParentId }),
      // Classified once per asset, here, and read by the fold for a level's
      // boundary exception. The same call `claimSubjectOf` made -- pure, and
      // over the same two strings, so the two can never disagree.
      equipmentClass: equipmentClass(asset.description ?? '', asset.canonicalTag),
    };
  });
  const snapshot = compileSnapshot({
    subjects: compileSubjects,
    claims,
    hierarchy: profile.hierarchy,
    // An empty tier list is not a preference -- it would disable every rung and
    // root the whole site -- so it falls through to the compiler's own default,
    // which is what an absent ladder has always done.
    ...(profile.ladder.tiers.length === 0 ? {} : { ladder: profile.ladder }),
  });

  // --- 10. projections ----------------------------------------------------------
  stage('projections');
  const tree = hierarchyTree(snapshot, profile.hierarchy, compileSubjects);

  const tagByAssetId = new Map<string, string>();
  for (const asset of catalog.assets) {
    if (asset.canonicalTag !== '') {
      tagByAssetId.set(asset.assetId, asset.canonicalTag);
    }
  }

  const generatedAssets: GeneratedMelAsset[] = catalog.assets.map((asset) =>
    generatedMelAssetOf(
      asset,
      resolutionOf(asset.assetId),
      snapshot.nodes.get(asset.assetId),
      tagByAssetId,
      sourceFileFor(asset),
      disciplineProjection,
      applyIcRule,
    ),
  );
  const generatedMel = {
    rows: buildCanonicalMelRows(generatedAssets),
    workbookBytes: writeCanonicalMelWorkbook(generatedAssets),
    assets: generatedAssets,
  };

  // --- 10b. how much of the site the compile actually described (B3) --------------
  // Read off the fold's and the resolver's own decisions, never recomputed: a
  // report that re-derived anything could disagree with the snapshot it
  // describes, and a site would have two answers to "is my equipment nested".
  const completeness = buildCompleteness({
    hierarchy: migrateHierarchyConfig(profile.hierarchy),
    subjects: compileSubjects,
    snapshot,
    systems,
    structuralClaims: claims.structural,
    melRowsDropped: mel.droppedRowCount,
    // The register as the EXTO sheet prints it, so the approved-value counts
    // judge the cells that would actually be uploaded rather than some other
    // spelling of the same asset.
    registerRows: generatedAssets.map((asset) => ({
      canonicalTag: asset.canonicalTag,
      ...(asset.system === undefined ? {} : { systemKey: asset.system.systemKey }),
      ...(asset.system === undefined ? {} : { systemLabel: asset.system.systemLabel }),
      ...(asset.ssmDiscipline === undefined ? {} : { ssmDiscipline: asset.ssmDiscipline }),
      ...(asset.equipmentClassification === undefined
        ? {}
        : { equipmentClassification: asset.equipmentClassification }),
      ...(asset.itemMaster === undefined ? {} : { itemMaster: asset.itemMaster }),
    })),
  });

  // --- 10c. the SSM Audit gate ----------------------------------------------------
  // Last, and deliberately after the register exists: the rulebook audits the
  // EXTO rows the export would carry, so it has to be handed a finished
  // register rather than a half-built one. It changes nothing (docs/ENGINE.md,
  // "SSM Audit gate"); its findings join the queue like any other stage's.
  const ssmAudit = auditCompiledProject(
    { generatedMel, identityIndex },
    { disabledRuleIds: profile.ssmAudit.disabledRuleIds },
  );

  // --- 11. one review queue -------------------------------------------------------
  stage('review');
  const reviewItems = aggregateReviewItems([
    catalog.reviewItems,
    // Stored decisions the ledger could not re-address. Raised before the
    // stages that would have consumed them, because a decision nobody can see
    // is exactly what P0-9 forbids.
    rematchQuestions,
    manualParents.reviewItems,
    manualSystems?.reviewItems ?? [],
    derivedAssignments.reviewItems,
    mel.reviewItems,
    systems.reviewItems,
    flow.reviewItems,
    claims.proposals,
    deadClaimRules(claims.skipped),
    snapshot.reviewItems,
    // "34 assets have no system" used to be a number on a summary with nothing
    // behind it. It is a queue row now, grouped by the reasons that explain it.
    completeness.reviewItems,
    // The gate: what Exto and the SOP would say about the register above.
    ssmAuditReviewItems(ssmAudit),
  ]);

  const stats = statsOf({
    sourceCount: sources.length,
    catalog,
    mel,
    systems,
    identityAssetCount: identityIndex.assets.length,
    observationCount: observations.length,
    flowStats: flow.stats,
    claims,
    learnedProposalCount: claims.proposals.length,
    snapshotStats: snapshot.stats,
    generatedMelRowCount: generatedMel.rows.length,
    reviewItemCount: reviewItems.length,
  });

  return {
    catalog,
    identityLedger,
    identityLedgerEvents: ledgerResult.events,
    propertyCatalog,
    subjects,
    melRows: mel.rows,
    systemCatalog: mel.catalog,
    systems,
    derivedAttributes,
    identityIndex,
    connectivityReports,
    observations,
    flow,
    learnedProposals,
    claims,
    compileSubjects,
    snapshot,
    tree,
    generatedMel,
    reviewItems,
    completeness: completeness.report,
    ssmAudit,
    stats,
  };
}

/**
 * Every input claims assembly refused, as review items.
 *
 * `@matchline/relationship-claims` publishes its skipped list because skipping
 * is loud by design (its `types.ts`: "a mistyped tag in a profile lookup would
 * otherwise vanish silently"). Loud only counts if it reaches the one queue a
 * person actually works, so the adapter lives here -- assembly does not know
 * what a review item is, and the orchestrator is what already turns every other
 * stage's refusals into one list.
 *
 * A make-root input names no parent by construction, so its `parentRef` is
 * `null`; it flattens to the empty string rather than to an invented tag, and
 * `reviewItemSummary` renders it as the "-> " with nothing after it that it is.
 */
function deadClaimRules(
  skipped: ReadonlyArray<SkippedClaimInput>,
): ReadonlyArray<DeadClaimRuleReviewItem> {
  return skipped.map((skip) => ({
    kind: 'dead-claim-rule',
    ladderSource: skip.ladderSource,
    reason: skip.reason,
    childRef: skip.childRef,
    parentRef: skip.parentRef ?? '',
  }));
}

/**
 * One asset as claims assembly reads it.
 *
 * `explicitParentTag` is read straight off the property bag, which is the whole
 * point of the seam: `ModelAsset` carries no such field, and only the compiler
 * knows the profile mapped one. The provenance addresses the object that
 * actually held the property, not the asset's representative object -- with
 * component collapse on, those differ.
 */
function claimSubjectOf(
  asset: ModelAsset,
  bag: AssetPropertyBag,
  sourceFile: string,
  anatomy: TagAnatomyConfig | undefined,
  parentTagProperty: PropertyRef | undefined,
): ClaimSubject {
  const anatomySegments = anatomyOf(anatomy, asset.canonicalTag);
  // The two anatomy segments the SOP reads are consumed by `sopTagFactsOf` and
  // are NOT passed on as claim-subject fields of their own: `role` and
  // `familyKey` are what the family rungs read, and adding two more segments to
  // that shape would invite a rung to start pairing on them by accident.
  const { system, instance, ...familySegments } = anatomySegments;
  const sop = sopTagFactsOf(asset.canonicalTag, {
    ...(system === undefined ? {} : { system }),
    ...(instance === undefined ? {} : { instance }),
  });
  const segments = {
    ...familySegments,
    ...sop,
    equipmentClass: equipmentClass(asset.description ?? '', asset.canonicalTag),
    ...(asset.building === undefined || asset.building.trim() === ''
      ? {}
      : { building: asset.building.trim() }),
  };
  if (parentTagProperty === undefined) {
    return { assetId: asset.assetId, canonicalTag: asset.canonicalTag, ...segments };
  }

  const read = propertyFrom(bag, parentTagProperty);
  if (read === null) {
    return { assetId: asset.assetId, canonicalTag: asset.canonicalTag, ...segments };
  }

  const provenance: Provenance = {
    sourceFile,
    sourceRef: { kind: 'model-object', objectId: String(read.objectId) },
    propertyOrColumn: propertyLabel(parentTagProperty.category, parentTagProperty.name),
  };
  return {
    assetId: asset.assetId,
    canonicalTag: asset.canonicalTag,
    ...segments,
    explicitParentTag: read.value,
    explicitParentProvenance: provenance,
  };
}

/**
 * One asset as the learned rules read it.
 *
 * `discipline` is the SSM discipline, not the native one: a learned rule set is
 * trained from a finished SSM export, whose discipline column is the projected
 * value, and scoring a rule against a differently-spelled discipline would make
 * its measured precision a number about something else.
 */
function nestingAssetOf(
  asset: ModelAsset,
  resolution: SystemResolution | null,
  anatomy: TagAnatomyConfig | undefined,
  projection: SsmDisciplineProjection,
  applyIcRule: boolean,
): NestingAsset {
  const segments = anatomyOf(anatomy, asset.canonicalTag);
  const discipline = ssmDisciplineOf(asset.nativeDiscipline, projection, applyIcRule);
  return {
    assetId: asset.assetId,
    description: asset.description ?? '',
    ...(asset.canonicalTag === '' ? {} : { tag: asset.canonicalTag }),
    ...(segments.familyKey === undefined ? {} : { familyKey: segments.familyKey }),
    ...(resolution === null ? {} : { systemKey: resolution.systemKey }),
    ...(discipline === undefined ? {} : { discipline }),
  };
}

/**
 * One compiled asset flattened onto the §12.1 MEL columns.
 *
 * Parent and dependencies are written as *tags*, not asset ids: a MEL is a
 * document engineers read and join against, and an internal id means nothing
 * outside Matchline. An untagged parent therefore names nobody -- which is the
 * truthful rendering, since there is no tag to write.
 */
function generatedMelAssetOf(
  asset: ModelAsset,
  resolution: SystemResolution | null,
  node: ResolvedAssetNode | undefined,
  tagByAssetId: ReadonlyMap<string, string>,
  sourceModelFile: string,
  projection: SsmDisciplineProjection,
  applyIcRule: boolean,
): GeneratedMelAsset {
  const parentAssetId = node?.parent.parentAssetId ?? null;
  const parentTag = parentAssetId === null ? undefined : tagByAssetId.get(parentAssetId);
  const ladderSource = node?.parent.ladderSource ?? null;

  // One upstream asset can be several `ResolvedDependency` entries -- a feeder
  // that also got demoted out of the parent chain is both `POWERS` and
  // `DEPENDENCY` -- but the column names assets, not relationships, so the same
  // tag twice would be a rendering artifact rather than a second dependency.
  const dependencyTags = new Set<string>();
  for (const dependency of node?.dependencies ?? []) {
    const tag = tagByAssetId.get(dependency.parentAssetId);
    if (tag !== undefined) {
      dependencyTags.add(tag);
    }
  }

  const ssmDiscipline = ssmDisciplineOf(asset.nativeDiscipline, projection, applyIcRule);

  return {
    canonicalTag: asset.canonicalTag,
    // The ledger id, never printed. It is what lets a revision diff report a
    // corrected tag as a changed tag rather than a remove and an add (P0-9).
    stableAssetId: asset.assetId,
    ...(asset.description === undefined ? {} : { description: asset.description }),
    ...(asset.equipmentType === undefined ? {} : { equipmentType: asset.equipmentType }),
    ...(asset.building === undefined ? {} : { building: asset.building }),
    ...(asset.nativeDiscipline === undefined
      ? {}
      : { nativeDiscipline: asset.nativeDiscipline }),
    ...(ssmDiscipline === undefined ? {} : { ssmDiscipline }),
    // Model-stated register fields, carried through verbatim. The EXTO assembly
    // prefers these over any learned assignment; nothing else reads them.
    ...(asset.wbs === undefined ? {} : { wbs: asset.wbs }),
    ...(asset.itemMaster === undefined ? {} : { itemMaster: asset.itemMaster }),
    ...(asset.equipmentClassification === undefined
      ? {}
      : { equipmentClassification: asset.equipmentClassification }),
    ...(resolution === null ? {} : { system: resolution }),
    ...(parentTag === undefined ? {} : { systemParentTag: parentTag }),
    ...(dependencyTags.size === 0 ? {} : { dependencyTags: [...dependencyTags] }),
    sourceModelFile,
    modelObjectIds: asset.objectIds,
    inclusionStatus: asset.status,
    ...(ladderSource === null ? {} : { parentEvidence: ladderSource }),
  };
}

/** Every stage's headline number, assembled once. */
function statsOf(parts: {
  readonly sourceCount: number;
  readonly catalog: CompiledProject['catalog'];
  readonly mel: { readonly rows: ReadonlyArray<MelCatalogRow>; readonly catalog: SystemCatalog };
  readonly systems: CompiledProject['systems'];
  readonly identityAssetCount: number;
  readonly observationCount: number;
  readonly flowStats: CompileStats['flow'];
  readonly claims: CompiledProject['claims'];
  readonly learnedProposalCount: number;
  readonly snapshotStats: CompileStats['snapshot'];
  readonly generatedMelRowCount: number;
  readonly reviewItemCount: number;
}): CompileStats {
  let resolvedSystemCount = 0;
  let systemConflictCount = 0;
  for (const resolution of parts.systems.bySubject.values()) {
    if (resolution.resolution !== null) {
      resolvedSystemCount += 1;
    }
    if (resolution.agreement === 'conflict') {
      systemConflictCount += 1;
    }
  }

  // Read off the catalog's own per-source impact rather than recounted, so the
  // breakdown can never disagree with the total it was summed from. That map is
  // already keyed by `sourceId` ascending, so the array inherits the order.
  const assetCountBySource: SourceAssetCount[] = [];
  for (const [sourceId, impact] of parts.catalog.impact.bySource) {
    assetCountBySource.push({ sourceId, assetCount: impact.finalAssetCount });
  }

  return {
    sourceCount: parts.sourceCount,
    assetCount: parts.catalog.assets.length,
    assetCountBySource,
    duplicateTagCount: parts.catalog.impact.duplicateTagCount,
    systemCatalogSize: parts.mel.catalog.size,
    melRowCount: parts.mel.rows.length,
    resolvedSystemCount,
    systemConflictCount,
    identityAssetCount: parts.identityAssetCount,
    observationCount: parts.observationCount,
    flow: parts.flowStats,
    structuralClaimCount: parts.claims.structural.length,
    dependencyClaimCount: parts.claims.dependencies.length,
    learnedProposalCount: parts.learnedProposalCount,
    skippedClaimInputCount: parts.claims.skipped.length,
    snapshot: parts.snapshotStats,
    generatedMelRowCount: parts.generatedMelRowCount,
    reviewItemCount: parts.reviewItemCount,
  };
}
