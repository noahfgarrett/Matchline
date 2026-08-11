import path from 'node:path';

import { IpcHandlerError } from '../ipc/register.js';
import type { PathGrants } from '../security/path-grants.js';
import type { ProjectService } from '../services/project-session.js';
import { screenDroppedPaths } from '../services/sources.js';

import type { IpcChannelName, IpcRequest, IpcResponse } from '../../shared/ipc.js';
import type { WireCompileStatus } from '../../shared/schemas.js';

/**
 * Every channel that reads or writes the open project.
 *
 * The handlers are thin on purpose: validate-and-delegate, with the service
 * owning all state and all engine calls. What they do add is the error
 * contract — a service that throws for a reason the user can act on ("no
 * project is open", "pick a tag property first") becomes a `handler-failed`
 * envelope carrying that sentence, and the renderer shows it verbatim.
 */

/** The subset of the channel table this module answers. */
export type SessionChannel = Extract<
  IpcChannelName,
  | 'project:create'
  | 'project:open'
  | 'project:close'
  | 'project:current'
  | 'project:recent'
  | 'source:add'
  | 'source:add-dropped'
  | 'source:list'
  | 'source:remove'
  | 'extraction:status'
  | 'extraction:cancel'
  | 'model:scan'
  | 'model:property-page'
  | 'model:class-list'
  | 'asset:preview'
  | 'anatomy:preview'
  | 'resolver:preview'
  | 'derived:preview'
  | 'assignment:preview'
  | 'setup:suggest'
  | 'setup:resolver-preview'
  | 'profile:draft'
  | 'profile:update'
  | 'profile:save'
  | 'hierarchy:attributes'
  | 'config:get'
  | 'config:update'
  | 'config:roles'
  | 'config:disciplines'
  | 'learned:train'
  | 'learned:list'
  | 'compile:run'
  | 'compile:cancel'
  | 'compile:status'
  | 'compile:issues'
  | 'compile:ledger-events'
  | 'compile:history'
  | 'tree:children'
  | 'tree:search'
  | 'tree:reparent-preview'
  | 'override:set'
  | 'override:list'
  | 'override:remove'
  | 'flow:roots'
  | 'flow:walk'
  | 'review:page'
  | 'review:decide'
  | 'export:generated-mel'
  | 'export:template-analyze'
  | 'export:template-mel'
  | 'export:exto-template-capture'
  | 'export:exto-template-clear'
  | 'export:exto'
  | 'export:predecessors'
  | 'export:revision-diff'
  | 'profile:sections'
  | 'profile:export'
  | 'profile:import'
>;

export type SessionHandlers = {
  readonly [TChannel in SessionChannel]: (
    request: IpcRequest<TChannel>,
  ) => Promise<IpcResponse<TChannel>>;
};

/**
 * Runs `work`, turning any throw into a failure the renderer can display.
 *
 * The service throws plain `Error`s whose messages are already written for a
 * person; wrapping them in `IpcHandlerError` keeps that message intact instead
 * of letting `registerIpc` prefix it with handler machinery.
 *
 * An `IpcHandlerError` is passed through untouched. A handler that raised one
 * had already decided which code the renderer should see — `path-not-granted`
 * is not a service failure, and relabelling it `handler-failed` would throw
 * away the only thing that distinguishes it.
 */
function guard<T>(work: () => T): T {
  try {
    return work();
  } catch (error: unknown) {
    if (error instanceof IpcHandlerError) {
      throw error;
    }
    throw new IpcHandlerError(
      'handler-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * {@link guard} for the service calls that are asynchronous.
 *
 * Registering a source streams a sha256 and so returns a promise; a rejection
 * has to become the same `handler-failed` envelope carrying the same sentence,
 * or "no project is open" would reach the renderer as a stack trace on one
 * channel and as a sentence on every other.
 */
async function guardAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof IpcHandlerError) {
      throw error;
    }
    throw new IpcHandlerError(
      'handler-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * The session handlers.
 *
 * @param grants the paths a dialog (or main's own recents list) has handed the
 * renderer. Required rather than optional: a permissive default is exactly the
 * hole this closes, and it should not be reachable by forgetting an argument.
 */
export function createSessionHandlers(
  service: ProjectService,
  grants: PathGrants,
): SessionHandlers {
  /**
   * Refuses a path the renderer was never given.
   *
   * The message names the file and says what to do, because the one way an
   * honest renderer hits this is a path that has gone stale — a recents entry
   * from before a project close, for instance.
   */
  function requireGranted(candidate: string): string {
    if (!grants.isGranted(candidate)) {
      throw new IpcHandlerError(
        'path-not-granted',
        `Matchline will only read or write files you have chosen yourself, and ` +
          `${path.basename(candidate)} was not one of them. Use the Browse or Save button ` +
          'to pick it.',
      );
    }
    return candidate;
  }

  return {
    async 'project:create'(
      request: IpcRequest<'project:create'>,
    ): Promise<IpcResponse<'project:create'>> {
      return {
        project: guard(() => service.create(requireGranted(request.path), request.name)),
      };
    },

    async 'project:open'(
      request: IpcRequest<'project:open'>,
    ): Promise<IpcResponse<'project:open'>> {
      return guard(() =>
        service.open(requireGranted(request.path), request.acceptMigration === true),
      );
    },

    /** Closing drops the paths this project's dialogs granted, along with it. */
    async 'project:close'(): Promise<IpcResponse<'project:close'>> {
      const closed = service.close();
      grants.clear();
      return { closed };
    },

    async 'project:current'(): Promise<IpcResponse<'project:current'>> {
      return { project: service.current() };
    },

    /**
     * The recents list is main's own record of files this installation opened,
     * so handing it to the renderer is also granting it: the paths came from
     * here, not from there.
     */
    async 'project:recent'(): Promise<IpcResponse<'project:recent'>> {
      const projects = [...service.recentProjects()];
      grants.grant(...projects.map((entry) => entry.path));
      return { projects };
    },

    async 'source:add'(request: IpcRequest<'source:add'>): Promise<IpcResponse<'source:add'>> {
      const paths = request.paths.map(requireGranted);
      return { results: [...(await guardAsync(() => service.addSources(paths)))] };
    },

    /**
     * Drag-and-drop intake.
     *
     * No `requireGranted`, because there is nothing to check against: the path
     * came off the drag payload rather than out of a dialog. `screenDroppedPaths`
     * is the substitute — main decides from the filesystem what it will open, and
     * mints no grant, so a drop can register a source and do nothing else. The
     * reasoning is written out in full in services/sources.ts.
     *
     * `addSources` is called even when nothing survived screening, so that "no
     * project is open" still reaches the user ahead of a list of file complaints.
     */
    async 'source:add-dropped'(
      request: IpcRequest<'source:add-dropped'>,
    ): Promise<IpcResponse<'source:add-dropped'>> {
      const screening = screenDroppedPaths(request.paths);
      const added = await guardAsync(() => service.addSources(screening.accepted));
      return {
        results: [
          ...added,
          ...screening.rejected.map((entry) => ({
            outcome: 'rejected' as const,
            fileName: entry.fileName,
            reason: entry.reason,
          })),
        ],
      };
    },

    async 'source:list'(): Promise<IpcResponse<'source:list'>> {
      return { sources: [...guard(() => service.listSources())] };
    },

    async 'source:remove'(
      request: IpcRequest<'source:remove'>,
    ): Promise<IpcResponse<'source:remove'>> {
      return { removed: guard(() => service.removeSource(request.sourceId)) };
    },

    async 'extraction:status'(
      request: IpcRequest<'extraction:status'>,
    ): Promise<IpcResponse<'extraction:status'>> {
      const page = guard(() => service.extractionStatus(request.offset, request.limit));
      return { total: page.total, active: page.active, rows: [...page.rows] };
    },

    async 'extraction:cancel'(
      request: IpcRequest<'extraction:cancel'>,
    ): Promise<IpcResponse<'extraction:cancel'>> {
      return { cancelled: guard(() => service.cancelExtraction(request.sourceId)) };
    },

    async 'model:scan'(): Promise<IpcResponse<'model:scan'>> {
      return { universe: guard(() => service.modelUniverse()) };
    },

    async 'model:property-page'(
      request: IpcRequest<'model:property-page'>,
    ): Promise<IpcResponse<'model:property-page'>> {
      const page = guard(() => service.propertyPage(request));
      return { total: page.total, rows: [...page.rows] };
    },

    async 'model:class-list'(): Promise<IpcResponse<'model:class-list'>> {
      return { classes: [...guard(() => service.classList())] };
    },

    async 'asset:preview'(): Promise<IpcResponse<'asset:preview'>> {
      return { preview: guard(() => service.assetPreview()) };
    },

    async 'anatomy:preview'(): Promise<IpcResponse<'anatomy:preview'>> {
      return { preview: guard(() => service.anatomyPreview()) };
    },

    async 'resolver:preview'(): Promise<IpcResponse<'resolver:preview'>> {
      return { preview: guard(() => service.resolverPreview()) };
    },

    async 'derived:preview'(
      request: IpcRequest<'derived:preview'>,
    ): Promise<IpcResponse<'derived:preview'>> {
      return { preview: guard(() => service.derivedPreview(request.definition)) };
    },

    async 'assignment:preview'(
      request: IpcRequest<'assignment:preview'>,
    ): Promise<IpcResponse<'assignment:preview'>> {
      return { preview: guard(() => service.assignmentPreview(request.rule)) };
    },

    async 'setup:suggest'(): Promise<IpcResponse<'setup:suggest'>> {
      return { suggestions: guard(() => service.quickSetupSuggestions()) };
    },

    async 'setup:resolver-preview'(
      request: IpcRequest<'setup:resolver-preview'>,
    ): Promise<IpcResponse<'setup:resolver-preview'>> {
      return { preview: guard(() => service.resolverTemplatePreview(request.resolver)) };
    },

    async 'profile:draft'(): Promise<IpcResponse<'profile:draft'>> {
      const state = service.draftState();
      return { draft: state.draft, savedRevision: state.savedRevision };
    },

    async 'profile:update'(
      request: IpcRequest<'profile:update'>,
    ): Promise<IpcResponse<'profile:update'>> {
      return { draft: guard(() => service.updateDraft(request.patch)) };
    },

    async 'profile:save'(
      request: IpcRequest<'profile:save'>,
    ): Promise<IpcResponse<'profile:save'>> {
      return guard(() => service.saveProfile(request.note));
    },

    /* ----------------------------------------------------- screens 6 and 7 */

    async 'hierarchy:attributes'(): Promise<IpcResponse<'hierarchy:attributes'>> {
      return { attributes: [...guard(() => service.attributeChoices())] };
    },

    async 'config:get'(): Promise<IpcResponse<'config:get'>> {
      return { config: guard(() => service.config()) };
    },

    async 'config:update'(
      request: IpcRequest<'config:update'>,
    ): Promise<IpcResponse<'config:update'>> {
      return { config: guard(() => service.updateConfig(request.patch)) };
    },

    async 'config:roles'(): Promise<IpcResponse<'config:roles'>> {
      return { roles: [...guard(() => service.roleValues())] };
    },

    async 'config:disciplines'(): Promise<IpcResponse<'config:disciplines'>> {
      return { disciplines: [...guard(() => service.disciplineValues())] };
    },

    async 'learned:train'(
      request: IpcRequest<'learned:train'>,
    ): Promise<IpcResponse<'learned:train'>> {
      return {
        summary: guard(() =>
          service.trainLearnedRules(request.kind, requireGranted(request.path)),
        ),
      };
    },

    async 'learned:list'(): Promise<IpcResponse<'learned:list'>> {
      return { summaries: [...guard(() => service.learnedSummaries())] };
    },

    /* ------------------------------------------------------------ screen 8 */

    async 'compile:run'(): Promise<IpcResponse<'compile:run'>> {
      return { status: await guardAsync((): Promise<WireCompileStatus> => service.compile()) };
    },

    /**
     * Stops the running compile.
     *
     * Answered while `compile:run` is still outstanding — that is the only time
     * it can be useful — which the transport allows because every invoke is
     * independent.
     */
    async 'compile:cancel'(): Promise<IpcResponse<'compile:cancel'>> {
      return { cancelled: guard(() => service.cancelCompile()) };
    },

    async 'compile:status'(): Promise<IpcResponse<'compile:status'>> {
      return { status: service.compileStatus() };
    },

    async 'compile:issues'(
      request: IpcRequest<'compile:issues'>,
    ): Promise<IpcResponse<'compile:issues'>> {
      const page = guard(() => service.compileIssues(request.kind, request.offset, request.limit));
      return { total: page.total, rows: [...page.rows] };
    },

    async 'compile:ledger-events'(
      request: IpcRequest<'compile:ledger-events'>,
    ): Promise<IpcResponse<'compile:ledger-events'>> {
      const page = guard(() => service.compileLedgerEvents(request.offset, request.limit));
      return { total: page.total, rows: [...page.rows] };
    },

    async 'compile:history'(): Promise<IpcResponse<'compile:history'>> {
      return { compiles: [...guard(() => service.compileHistory())] };
    },

    /* ----------------------------------------------------------- workspace */

    async 'tree:children'(
      request: IpcRequest<'tree:children'>,
    ): Promise<IpcResponse<'tree:children'>> {
      return guard(() => service.treeChildren(request.nodeKey, request.offset, request.limit));
    },

    async 'tree:search'(request: IpcRequest<'tree:search'>): Promise<IpcResponse<'tree:search'>> {
      return { rows: [...guard(() => service.treeSearch(request.query, request.limit))] };
    },

    async 'tree:reparent-preview'(
      request: IpcRequest<'tree:reparent-preview'>,
    ): Promise<IpcResponse<'tree:reparent-preview'>> {
      return {
        preview: guard(() => service.reparentPreview(request.childAssetId, request.parentAssetId)),
      };
    },

    async 'override:set'(request: IpcRequest<'override:set'>): Promise<IpcResponse<'override:set'>> {
      return {
        overrides: [
          ...guard(() =>
            service.setRelationshipOverride(
              request.childAssetId,
              request.parentAssetId,
              request.note,
            ),
          ),
        ],
      };
    },

    async 'override:list'(): Promise<IpcResponse<'override:list'>> {
      return { overrides: [...guard(() => service.listRelationshipOverrides())] };
    },

    async 'override:remove'(
      request: IpcRequest<'override:remove'>,
    ): Promise<IpcResponse<'override:remove'>> {
      const removed = guard(() => service.removeRelationshipOverride(request.childAssetId));
      return { removed, overrides: [...guard(() => service.listRelationshipOverrides())] };
    },

    async 'flow:roots'(request: IpcRequest<'flow:roots'>): Promise<IpcResponse<'flow:roots'>> {
      const page = guard(() => service.flowRoots(request.offset, request.limit));
      return { total: page.total, rows: [...page.rows] };
    },

    async 'flow:walk'(request: IpcRequest<'flow:walk'>): Promise<IpcResponse<'flow:walk'>> {
      const page = guard(() =>
        service.flowWalk(request.rootNodeId, request.offset, request.limit),
      );
      return { total: page.total, rows: [...page.rows] };
    },

    async 'review:page'(request: IpcRequest<'review:page'>): Promise<IpcResponse<'review:page'>> {
      return guard(() => service.reviewPage(request.kind, request.offset, request.limit));
    },

    async 'review:decide'(
      request: IpcRequest<'review:decide'>,
    ): Promise<IpcResponse<'review:decide'>> {
      return {
        recorded: guard(() =>
          service.recordDecision(request.reviewKey, request.decision, request.note),
        ),
      };
    },

    /* ------------------------------------------------- exports and packages */

    async 'export:generated-mel'(
      request: IpcRequest<'export:generated-mel'>,
    ): Promise<IpcResponse<'export:generated-mel'>> {
      return { result: guard(() => service.exportGeneratedMel(requireGranted(request.path))) };
    },

    async 'export:template-analyze'(
      request: IpcRequest<'export:template-analyze'>,
    ): Promise<IpcResponse<'export:template-analyze'>> {
      return { analysis: guard(() => service.analyzeTemplate(requireGranted(request.path))) };
    },

    async 'export:template-mel'(
      request: IpcRequest<'export:template-mel'>,
    ): Promise<IpcResponse<'export:template-mel'>> {
      return {
        result: guard(() =>
          service.exportTemplateMel(requireGranted(request.path), request.bindings),
        ),
      };
    },

    async 'export:exto-template-capture'(
      request: IpcRequest<'export:exto-template-capture'>,
    ): Promise<IpcResponse<'export:exto-template-capture'>> {
      return {
        config: guard(() => service.captureExtoTemplate(requireGranted(request.path))),
      };
    },

    async 'export:exto-template-clear'(): Promise<IpcResponse<'export:exto-template-clear'>> {
      return { config: guard(() => service.clearExtoTemplate()) };
    },

    async 'export:exto'(request: IpcRequest<'export:exto'>): Promise<IpcResponse<'export:exto'>> {
      return { result: guard(() => service.exportExto(requireGranted(request.path))) };
    },

    async 'export:predecessors'(
      request: IpcRequest<'export:predecessors'>,
    ): Promise<IpcResponse<'export:predecessors'>> {
      return { result: guard(() => service.exportPredecessors(requireGranted(request.path))) };
    },

    async 'export:revision-diff'(
      request: IpcRequest<'export:revision-diff'>,
    ): Promise<IpcResponse<'export:revision-diff'>> {
      return {
        result: guard(() =>
          service.exportRevisionDiff(requireGranted(request.path), request.previousCompileId),
        ),
      };
    },

    async 'profile:sections'(): Promise<IpcResponse<'profile:sections'>> {
      return { sections: [...guard(() => service.profileSections())] };
    },

    async 'profile:export'(
      request: IpcRequest<'profile:export'>,
    ): Promise<IpcResponse<'profile:export'>> {
      return { result: guard(() => service.exportProfilePackage(requireGranted(request.path))) };
    },

    async 'profile:import'(
      request: IpcRequest<'profile:import'>,
    ): Promise<IpcResponse<'profile:import'>> {
      return guard(() => service.importProfilePackage(requireGranted(request.path)));
    },
  };
}
