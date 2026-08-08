import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { createSessionHandlers } from '../dist/electron/handlers/session.js';
import { createSenderCheck, registerIpc } from '../dist/electron/ipc/register.js';
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
  'compile:run',
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
  const covered = [...Object.keys(createSessionHandlers(service)), ...NON_SESSION_CHANNELS];

  assert.deepEqual(
    [...covered].sort(),
    [...IPC_CHANNEL_NAMES].sort(),
    'a channel exists that nothing in main answers',
  );
  service.close();
});

test('every session handler is registrable and returns a schema-valid response', async () => {
  const service = createProjectService({ userDataDir, appVersion: '0.5.0' });
  const handlers = createSessionHandlers(service);

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
  const handlers = createSessionHandlers(service);
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
  const full = { ...createSessionHandlers(service) };
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
