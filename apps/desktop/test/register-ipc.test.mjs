import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IpcHandlerError,
  createSenderCheck,
  registerIpc,
} from '../dist/electron/ipc/register.js';
import { IPC_CHANNEL_NAMES } from '../dist/shared/ipc.js';

const TRUSTED_ORIGIN = 'app://renderer';
const trustedEvent = { senderFrame: { url: `${TRUSTED_ORIGIN}/index.html` } };

/** Stands in for ipcMain: keeps the listeners so a test can invoke them directly. */
function createFakeIpcMain() {
  const listeners = new Map();
  return {
    listeners,
    handle(channel, listener) {
      assert.ok(!listeners.has(channel), `"${channel}" was registered twice`);
      listeners.set(channel, listener);
    },
    invoke(channel, event, request) {
      const listener = listeners.get(channel);
      assert.ok(listener !== undefined, `"${channel}" was never registered`);
      return listener(event, request);
    },
  };
}

/** Handlers that record their calls, so "the handler never ran" is observable. */
function createSpyHandlers() {
  const calls = [];
  const handlers = {};
  for (const channel of IPC_CHANNEL_NAMES) {
    handlers[channel] = async (request) => {
      calls.push({ channel, request });
      if (channel === 'dev:ping') {
        return { message: request.message };
      }
      throw new IpcHandlerError('not-implemented', `${channel} is a stub in this test.`);
    };
  }
  return { calls, handlers };
}

function setup() {
  const ipcMain = createFakeIpcMain();
  const spy = createSpyHandlers();
  registerIpc(ipcMain, spy.handlers, createSenderCheck([TRUSTED_ORIGIN]));
  return { ipcMain, ...spy };
}

test('every declared channel gets exactly one ipcMain.handle registration', () => {
  const { ipcMain } = setup();
  assert.deepEqual([...ipcMain.listeners.keys()], [...IPC_CHANNEL_NAMES]);
});

test('a valid request reaches the handler and comes back in an ok envelope', async () => {
  const { ipcMain, calls } = setup();

  const result = await ipcMain.invoke('dev:ping', trustedEvent, { message: 'dragon' });

  assert.deepEqual(result, { ok: true, data: { message: 'dragon' } });
  assert.deepEqual(calls, [{ channel: 'dev:ping', request: { message: 'dragon' } }]);
});

test('a malformed payload is rejected before the handler runs', async () => {
  const { ipcMain, calls } = setup();

  const result = await ipcMain.invoke('dev:ping', trustedEvent, { message: 42 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-request');
  assert.deepEqual(calls, [], 'the handler must not run on an invalid payload');
});

test('a missing payload is rejected the same way', async () => {
  const { ipcMain, calls } = setup();

  const result = await ipcMain.invoke('dev:ping', trustedEvent, undefined);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-request');
  assert.deepEqual(calls, []);
});

test('extra keys are stripped rather than forwarded to the handler', async () => {
  const { ipcMain, calls } = setup();

  await ipcMain.invoke('dev:ping', trustedEvent, { message: 'dragon', smuggled: 'payload' });

  assert.deepEqual(calls, [{ channel: 'dev:ping', request: { message: 'dragon' } }]);
});

test('an untrusted sender is rejected before validation or the handler', async () => {
  const { ipcMain, calls } = setup();

  const result = await ipcMain.invoke(
    'dev:ping',
    { senderFrame: { url: 'https://evil.example.com/' } },
    { message: 'dragon' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unauthorized-sender');
  assert.deepEqual(calls, []);
});

test('a null sender frame is rejected', async () => {
  const { ipcMain } = setup();

  const result = await ipcMain.invoke('dev:ping', { senderFrame: null }, { message: 'x' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unauthorized-sender');
});

test('a handler that throws IpcHandlerError surfaces its code', async () => {
  const { ipcMain } = setup();

  const result = await ipcMain.invoke('project:open', trustedEvent, {
    path: '/Users/dragon/Dragon.matchline',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not-implemented');
});

test('an unexpected handler throw becomes handler-failed, not a rejection', async () => {
  const ipcMain = createFakeIpcMain();
  const handlers = {};
  for (const channel of IPC_CHANNEL_NAMES) {
    handlers[channel] = async () => {
      throw new Error('boom');
    };
  }
  registerIpc(ipcMain, handlers, createSenderCheck([TRUSTED_ORIGIN]));

  const result = await ipcMain.invoke('dev:ping', trustedEvent, { message: 'dragon' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'handler-failed');
  assert.match(result.error.message, /boom/);
});

test('a handler returning the wrong shape is caught as invalid-response', async () => {
  const ipcMain = createFakeIpcMain();
  const handlers = {};
  for (const channel of IPC_CHANNEL_NAMES) {
    handlers[channel] = async () => ({ wrong: 'shape' });
  }
  registerIpc(ipcMain, handlers, createSenderCheck([TRUSTED_ORIGIN]));

  const result = await ipcMain.invoke('dev:ping', trustedEvent, { message: 'dragon' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-response');
});

test('the sender check accepts only the configured origins', () => {
  const isTrusted = createSenderCheck([TRUSTED_ORIGIN, 'http://localhost:5173']);

  assert.equal(isTrusted({ senderFrame: { url: 'app://renderer/index.html' } }), true);
  assert.equal(isTrusted({ senderFrame: { url: 'http://localhost:5173/' } }), true);
  assert.equal(isTrusted({ senderFrame: { url: 'file:///etc/passwd' } }), false);
  assert.equal(isTrusted({ senderFrame: { url: 'app://other/index.html' } }), false);
  assert.equal(isTrusted({ senderFrame: null }), false);
});
