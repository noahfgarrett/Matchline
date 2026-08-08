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
      return { project: guard(() => service.open(request.path)) };
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
  };
}
