import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';

import { createSessionHandlers } from '../dist/electron/handlers/session.js';
import { createSenderCheck, registerIpc } from '../dist/electron/ipc/register.js';
import { createPathGrants } from '../dist/electron/security/path-grants.js';
import { createProjectService } from '../dist/electron/services/project-session.js';
import { IPC_CHANNELS, IPC_CHANNEL_NAMES } from '../dist/shared/ipc.js';

/**
 * The session handlers against the real registration path.
 *
 * `register-ipc.test.mjs` proves the transport with spy handlers; this proves
 * the handlers themselves — that every one of them satisfies its declared
 * response schema, and that a service error reaches the renderer as a sentence
 * rather than as a rejected promise.
 */

/** Channels answered by something other than the project service. */
const NON_SESSION_CHANNELS = [
  'app:version',
  'dialog:open-file',
  'dialog:open-files',
  'dialog:save-file',
  'dev:ping',
];

const TRUSTED_ORIGIN = 'app://renderer';
const trustedEvent = { senderFrame: { url: `${TRUSTED_ORIGIN}/index.html` } };

let userDataDir = '';

before(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'matchline-handlers-'));
});

after(() => {
  if (userDataDir !== '') {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

function createFakeIpcMain() {
  const listeners = new Map();
  return {
    listeners,
    handle(channel, listener) {
      listeners.set(channel, listener);
    },
    invoke(channel, request) {
      const listener = listeners.get(channel);
      assert.ok(listener !== undefined, `"${channel}" was never registered`);
      return listener(trustedEvent, request);
    },
  };
}

test('the session handlers plus the standalone ones cover the whole table', () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const covered = [
    ...Object.keys(createSessionHandlers(service, createPathGrants())),
    ...NON_SESSION_CHANNELS,
  ];

  assert.deepEqual(
    [...covered].sort(),
    [...IPC_CHANNEL_NAMES].sort(),
    'a channel exists that nothing in main answers',
  );
  service.close();
});

test('every session handler is registrable and returns a schema-valid response', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const handlers = createSessionHandlers(service, createPathGrants());

  // registerIpc demands a handler for every channel; the ones this test is not
  // about get a stub that fails loudly rather than a fake success.
  const full = { ...handlers };
  for (const channel of NON_SESSION_CHANNELS) {
    full[channel] = async () => {
      throw new Error(`${channel} is out of scope for this test.`);
    };
  }

  const ipcMain = createFakeIpcMain();
  registerIpc(ipcMain, full, createSenderCheck([TRUSTED_ORIGIN]));

  // No project open: every read channel still has to answer in its own shape.
  const withNoProject = [
    ['project:current', undefined],
    ['project:recent', undefined],
    ['profile:draft', undefined],
    ['compile:status', undefined],
    ['hierarchy:attributes', undefined],
    ['project:close', undefined],
  ];

  for (const [channel, request] of withNoProject) {
    const result = await ipcMain.invoke(channel, request);
    assert.equal(result.ok, true, `"${channel}" failed: ${JSON.stringify(result)}`);
    const parsed = IPC_CHANNELS[channel].response.safeParse(result.data);
    assert.ok(parsed.success, `"${channel}" response does not satisfy its schema`);
  }

  assert.deepEqual(await ipcMain.invoke('project:current', undefined), {
    ok: true,
    data: { project: null },
  });

  service.close();
});

test('a service refusal reaches the renderer as its own sentence', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const handlers = createSessionHandlers(service, createPathGrants());
  const full = { ...handlers };
  for (const channel of NON_SESSION_CHANNELS) {
    full[channel] = async () => {
      throw new Error('out of scope');
    };
  }

  const ipcMain = createFakeIpcMain();
  registerIpc(ipcMain, full, createSenderCheck([TRUSTED_ORIGIN]));

  const result = await ipcMain.invoke('source:list', undefined);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'handler-failed');
  assert.equal(
    result.error.message,
    'No project is open. Create or open one first.',
    'the message is the service\'s own wording, not wrapped in handler machinery',
  );

  service.close();
});

test('an invalid property page request never reaches the service', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const full = { ...createSessionHandlers(service, createPathGrants()) };
  for (const channel of NON_SESSION_CHANNELS) {
    full[channel] = async () => {
      throw new Error('out of scope');
    };
  }

  const ipcMain = createFakeIpcMain();
  registerIpc(ipcMain, full, createSenderCheck([TRUSTED_ORIGIN]));

  // 5000 rows in one page would defeat the point of paging at all.
  const result = await ipcMain.invoke('model:property-page', {
    offset: 0,
    limit: 5000,
    sortBy: 'coverage',
    descending: true,
    search: '',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-request');

  service.close();
});

/**
 * The renderer may only name files it was handed (electron/security/path-grants.ts).
 *
 * Registered through the real transport rather than by calling the handler
 * directly, because the point is that the refusal is what the renderer sees:
 * a typed envelope with a sentence in it, not a thrown path.
 */
function registerWithGrants(service, grants) {
  const full = { ...createSessionHandlers(service, grants) };
  for (const channel of NON_SESSION_CHANNELS) {
    full[channel] = async () => {
      throw new Error('out of scope');
    };
  }
  const ipcMain = createFakeIpcMain();
  registerIpc(ipcMain, full, createSenderCheck([TRUSTED_ORIGIN]));
  return ipcMain;
}

test('a path no dialog ever returned is refused before the service opens it', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const ipcMain = registerWithGrants(service, createPathGrants());

  const result = await ipcMain.invoke('export:template-analyze', {
    path: '/etc/ssh/ssh_host_rsa_key',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'path-not-granted');
  assert.match(result.error.message, /files you have chosen yourself/);
  assert.match(result.error.message, /ssh_host_rsa_key/, 'the refusal names the file');

  service.close();
});

test('a path a dialog returned is accepted, and closing the project forgets it', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const grants = createPathGrants();
  const ipcMain = registerWithGrants(service, grants);
  const projectPath = join(userDataDir, 'Granted.matchline');

  // Stands in for the save dialog, which is the only other thing that grants.
  grants.grant(projectPath);

  const created = await ipcMain.invoke('project:create', { path: projectPath, name: 'Granted' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.project.name, 'Granted');

  const closed = await ipcMain.invoke('project:close', undefined);
  assert.equal(closed.ok, true);
  assert.equal(grants.size, 0, 'grants do not outlive the project they were made for');

  const reopened = await ipcMain.invoke('project:open', { path: projectPath });
  assert.equal(reopened.ok, false, 'the same path has to be granted again');
  assert.equal(reopened.error.code, 'path-not-granted');

  service.close();
  rmSync(projectPath, { force: true });
});

/**
 * Drag-and-drop intake (`source:add-dropped`).
 *
 * A dropped path is not a granted path and never becomes one — main screens it
 * from the filesystem instead (electron/services/sources.ts). These prove both
 * halves: what screens as a source file is registered without any dialog having
 * run, and what does not is refused without the grant record moving.
 */
test('a dropped source file is added even though no dialog ever granted it', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const grants = createPathGrants();
  const ipcMain = registerWithGrants(service, grants);

  const projectPath = join(userDataDir, 'Dropped.matchline');
  grants.grant(projectPath);
  const created = await ipcMain.invoke('project:create', { path: projectPath, name: 'Dropped' });
  assert.equal(created.ok, true, JSON.stringify(created));

  const cachePath = join(userDataDir, 'Dropped.matchline-cache');
  writeDragonFixture(cachePath);
  assert.equal(grants.isGranted(cachePath), false, 'nothing has granted the dropped file');

  const dropped = await ipcMain.invoke('source:add-dropped', { paths: [cachePath] });
  assert.equal(dropped.ok, true, JSON.stringify(dropped));
  assert.deepEqual(
    dropped.data.results.map((entry) => entry.outcome),
    ['added'],
  );
  assert.equal(dropped.data.results[0].source.role, 'model');

  // The add is the whole capability. A drop does not leave behind a path the
  // renderer can then name on a channel that writes.
  assert.equal(grants.isGranted(cachePath), false, 'a drop mints no grant');
  const write = await ipcMain.invoke('export:generated-mel', { path: cachePath });
  assert.equal(write.ok, false);
  assert.equal(write.error.code, 'path-not-granted');

  await ipcMain.invoke('project:close', undefined);
  service.close();
  rmSync(projectPath, { force: true });
  rmSync(cachePath, { force: true });
});

test('a dropped path that is not a source file is refused before anything opens it', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const grants = createPathGrants();
  const ipcMain = registerWithGrants(service, grants);

  const projectPath = join(userDataDir, 'Screened.matchline');
  grants.grant(projectPath);
  await ipcMain.invoke('project:create', { path: projectPath, name: 'Screened' });

  const keyPath = join(userDataDir, 'id_rsa');
  writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\n');

  const refused = await ipcMain.invoke('source:add-dropped', {
    paths: [keyPath, userDataDir],
  });
  assert.equal(refused.ok, true, 'a screening refusal is a result, not a transport failure');
  assert.deepEqual(
    refused.data.results.map((entry) => entry.outcome),
    ['rejected', 'rejected'],
  );
  assert.match(refused.data.results[0].reason, /does not read id_rsa/);
  // A directory carries no accepted extension either, so it is turned away on
  // the same check rather than walked.
  assert.equal(refused.data.results[1].outcome, 'rejected');
  assert.equal(grants.size, 1, 'screening moved nothing into the grant record');

  const sources = await ipcMain.invoke('source:list', undefined);
  assert.equal(sources.ok, true);
  assert.deepEqual(sources.data.sources, [], 'nothing was registered');

  await ipcMain.invoke('project:close', undefined);
  service.close();
  rmSync(projectPath, { force: true });
  rmSync(keyPath, { force: true });
});

test('a drop with no project open says so, rather than listing file complaints', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const ipcMain = registerWithGrants(service, createPathGrants());

  const result = await ipcMain.invoke('source:add-dropped', { paths: ['/tmp/whatever.txt'] });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'handler-failed');
  assert.equal(result.error.message, 'No project is open. Create or open one first.');

  service.close();
});

test('the recents list grants the paths it hands over', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const grants = createPathGrants();
  const ipcMain = registerWithGrants(service, grants);

  const recents = await ipcMain.invoke('project:recent', undefined);
  assert.equal(recents.ok, true);
  for (const entry of recents.data.projects) {
    assert.equal(grants.isGranted(entry.path), true, `${entry.path} came from main, not the UI`);
  }

  service.close();
});
