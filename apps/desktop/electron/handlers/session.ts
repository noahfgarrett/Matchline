import { IpcHandlerError } from '../ipc/register.js';
import type { ProjectService } from '../services/project-session.js';

import type { IpcChannelName, IpcRequest, IpcResponse } from '../../shared/ipc.js';

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
  | 'source:list'
  | 'source:remove'
  | 'model:scan'
  | 'model:property-page'
  | 'model:class-list'
  | 'asset:preview'
  | 'anatomy:preview'
  | 'resolver:preview'
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
  | 'compile:status'
  | 'compile:issues'
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
 */
function guard<T>(work: () => T): T {
  try {
    return work();
  } catch (error: unknown) {
    throw new IpcHandlerError(
      'handler-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createSessionHandlers(service: ProjectService): SessionHandlers {
  return {
    async 'project:create'(
      request: IpcRequest<'project:create'>,
    ): Promise<IpcResponse<'project:create'>> {
      return { project: guard(() => service.create(request.path, request.name)) };
    },

    async 'project:open'(
      request: IpcRequest<'project:open'>,
    ): Promise<IpcResponse<'project:open'>> {
      return guard(() => service.open(request.path));
    },

    async 'project:close'(): Promise<IpcResponse<'project:close'>> {
      return { closed: service.close() };
    },

    async 'project:current'(): Promise<IpcResponse<'project:current'>> {
      return { project: service.current() };
    },

    async 'project:recent'(): Promise<IpcResponse<'project:recent'>> {
      return { projects: [...service.recentProjects()] };
    },

    async 'source:add'(request: IpcRequest<'source:add'>): Promise<IpcResponse<'source:add'>> {
      return { results: [...guard(() => service.addSources(request.paths))] };
    },

    async 'source:list'(): Promise<IpcResponse<'source:list'>> {
      return { sources: [...guard(() => service.listSources())] };
    },

    async 'source:remove'(
      request: IpcRequest<'source:remove'>,
    ): Promise<IpcResponse<'source:remove'>> {
      return { removed: guard(() => service.removeSource(request.role, request.fileName)) };
    },

    async 'model:scan'(): Promise<IpcResponse<'model:scan'>> {
      return { scan: guard(() => service.modelScan()) };
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
      return { summary: guard(() => service.trainLearnedRules(request.kind, request.path)) };
    },

    async 'learned:list'(): Promise<IpcResponse<'learned:list'>> {
      return { summaries: [...guard(() => service.learnedSummaries())] };
    },

    /* ------------------------------------------------------------ screen 8 */

    async 'compile:run'(): Promise<IpcResponse<'compile:run'>> {
      return { status: guard(() => service.compile()) };
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
      return { result: guard(() => service.exportGeneratedMel(request.path)) };
    },

    async 'export:template-analyze'(
      request: IpcRequest<'export:template-analyze'>,
    ): Promise<IpcResponse<'export:template-analyze'>> {
      return { analysis: guard(() => service.analyzeTemplate(request.path)) };
    },

    async 'export:template-mel'(
      request: IpcRequest<'export:template-mel'>,
    ): Promise<IpcResponse<'export:template-mel'>> {
      return { result: guard(() => service.exportTemplateMel(request.path, request.bindings)) };
    },

    async 'export:exto'(request: IpcRequest<'export:exto'>): Promise<IpcResponse<'export:exto'>> {
      return { result: guard(() => service.exportExto(request.path)) };
    },

    async 'export:predecessors'(
      request: IpcRequest<'export:predecessors'>,
    ): Promise<IpcResponse<'export:predecessors'>> {
      return { result: guard(() => service.exportPredecessors(request.path)) };
    },

    async 'export:revision-diff'(
      request: IpcRequest<'export:revision-diff'>,
    ): Promise<IpcResponse<'export:revision-diff'>> {
      return {
        result: guard(() => service.exportRevisionDiff(request.path, request.previousCompileId)),
      };
    },

    async 'profile:sections'(): Promise<IpcResponse<'profile:sections'>> {
      return { sections: [...guard(() => service.profileSections())] };
    },

    async 'profile:export'(
      request: IpcRequest<'profile:export'>,
    ): Promise<IpcResponse<'profile:export'>> {
      return { result: guard(() => service.exportProfilePackage(request.path)) };
    },

    async 'profile:import'(
      request: IpcRequest<'profile:import'>,
    ): Promise<IpcResponse<'profile:import'>> {
      return guard(() => service.importProfilePackage(request.path));
    },
  };
}
