import assert from 'node:assert/strict';
import test from 'node:test';

import { createMatchlineApi, toCamelCase } from '../dist/shared/create-api.js';
import { IPC_CHANNEL_NAMES } from '../dist/shared/ipc.js';

/** Stands in for ipcRenderer: records what the façade asked for, returns a marker. */
function createFakeIpcRenderer() {
  const calls = [];
  return {
    calls,
    invoke: async (channel, request) => {
      calls.push({ channel, request });
      return { ok: true, data: { echoed: channel } };
    },
  };
}

test('the façade exposes exactly one method per declared channel', () => {
  const fake = createFakeIpcRenderer();
  const api = createMatchlineApi(fake.invoke);

  const exposed = Object.entries(api).flatMap(([domain, methods]) =>
    Object.keys(methods).map((verb) => `${domain}.${verb}`),
  );

  const expected = IPC_CHANNEL_NAMES.map((channel) => {
    const [domain, ...rest] = channel.split(':');
    return `${domain}.${toCamelCase(rest.join(':'))}`;
  });

  assert.deepEqual(exposed.sort(), expected.sort());
  assert.equal(exposed.length, IPC_CHANNEL_NAMES.length);
});

test('every exposed member is a function', () => {
  const fake = createFakeIpcRenderer();
  const api = createMatchlineApi(fake.invoke);

  for (const methods of Object.values(api)) {
    for (const [verb, method] of Object.entries(methods)) {
      assert.equal(typeof method, 'function', `${verb} is not callable`);
    }
  }
});

test('a kebab-case verb becomes a camelCase method', () => {
  assert.equal(toCamelCase('open-file'), 'openFile');
  assert.equal(toCamelCase('run-compile-now'), 'runCompileNow');
  assert.equal(toCamelCase('version'), 'version');

  const api = createMatchlineApi(createFakeIpcRenderer().invoke);
  assert.equal(typeof api.dialog.openFile, 'function');
});

test('calling a method forwards the channel name and payload verbatim', async () => {
  const fake = createFakeIpcRenderer();
  const api = createMatchlineApi(fake.invoke);

  const request = { filters: [{ name: 'Matchline project', extensions: ['matchline'] }] };
  const result = await api.dialog.openFile(request);

  assert.deepEqual(fake.calls, [{ channel: 'dialog:open-file', request }]);
  assert.deepEqual(result, { ok: true, data: { echoed: 'dialog:open-file' } });
});

test('a void-request channel invokes with undefined rather than omitting the argument', async () => {
  const fake = createFakeIpcRenderer();
  const api = createMatchlineApi(fake.invoke);

  await api.app.version();

  assert.deepEqual(fake.calls, [{ channel: 'app:version', request: undefined }]);
});

/**
 * `files` is deliberately absent here: it needs `webUtils`, so the preload adds
 * it (preload/index.ts) and this generator stays free of Electron. Everything
 * this function produces is a channel.
 */
test('the channel façade exposes nothing beyond the declared domains', () => {
  const api = createMatchlineApi(createFakeIpcRenderer().invoke);
  const expectedDomains = new Set(IPC_CHANNEL_NAMES.map((channel) => channel.split(':')[0]));

  assert.deepEqual(new Set(Object.keys(api)), expectedDomains);
});
