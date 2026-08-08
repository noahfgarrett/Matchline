import assert from 'node:assert/strict';
import test from 'node:test';

import { IPC_CHANNELS, IPC_CHANNEL_NAMES } from '../dist/shared/ipc.js';

const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9]*:[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

test('the exported channel list is exactly the table keys, with no duplicates', () => {
  assert.deepEqual([...IPC_CHANNEL_NAMES], Object.keys(IPC_CHANNELS));
  assert.equal(new Set(IPC_CHANNEL_NAMES).size, IPC_CHANNEL_NAMES.length);
});

test('the table is not empty', () => {
  assert.ok(IPC_CHANNEL_NAMES.length > 0);
});

test('every channel name is domain:verb, so the façade can nest it', () => {
  for (const channel of IPC_CHANNEL_NAMES) {
    assert.match(channel, CHANNEL_NAME_PATTERN, `"${channel}" is not domain:verb`);
  }
});

test('every channel declares both schemas and an example', () => {
  for (const channel of IPC_CHANNEL_NAMES) {
    const declaration = IPC_CHANNELS[channel];
    assert.equal(
      typeof declaration.request?.safeParse,
      'function',
      `"${channel}" has no request schema`,
    );
    assert.equal(
      typeof declaration.response?.safeParse,
      'function',
      `"${channel}" has no response schema`,
    );
    assert.ok(declaration.example !== undefined, `"${channel}" has no example`);
    assert.ok(
      'request' in declaration.example && 'response' in declaration.example,
      `"${channel}" example is missing a side`,
    );
  }
});

test("each channel's example round-trips through both schemas unchanged", () => {
  for (const channel of IPC_CHANNEL_NAMES) {
    const { request, response, example } = IPC_CHANNELS[channel];

    const parsedRequest = request.safeParse(example.request);
    assert.ok(parsedRequest.success, `"${channel}" request example failed to parse`);
    assert.deepEqual(parsedRequest.data, example.request);

    const parsedResponse = response.safeParse(example.response);
    assert.ok(parsedResponse.success, `"${channel}" response example failed to parse`);
    assert.deepEqual(parsedResponse.data, example.response);
  }
});

test('a void-request channel declares its example request as undefined', () => {
  for (const channel of IPC_CHANNEL_NAMES) {
    const { request, example } = IPC_CHANNELS[channel];
    // The façade calls a void-request channel with no argument, so a declared
    // example of anything else would describe a call that cannot happen.
    if (request.safeParse(undefined).success && !request.safeParse({}).success) {
      assert.equal(
        example.request,
        undefined,
        `"${channel}" takes no request but its example supplies one`,
      );
    }
  }
});

test('the round-2 channels are all declared', () => {
  const expected = [
    'dialog:save-file',
    'dialog:open-files',
    'project:create',
    'project:open',
    'project:close',
    'project:current',
    'project:recent',
    'source:add',
    'source:list',
    'source:remove',
    'model:scan',
    'model:property-page',
    'model:class-list',
    'asset:preview',
    'anatomy:preview',
    'resolver:preview',
    'profile:draft',
    'profile:update',
    'profile:save',
  ];

  for (const channel of expected) {
    assert.ok(IPC_CHANNEL_NAMES.includes(channel), `"${channel}" is missing from the table`);
  }
});

test('the round-3 channels are all declared', () => {
  const expected = [
    // screens 6 and 7
    'hierarchy:attributes',
    'config:get',
    'config:update',
    'config:roles',
    'config:disciplines',
    'learned:train',
    'learned:list',
    // screen 8
    'compile:run',
    'compile:status',
    'compile:issues',
    'compile:history',
    // the workspace
    'tree:children',
    'tree:search',
    'tree:reparent-preview',
    'override:set',
    'override:list',
    'override:remove',
    'flow:roots',
    'flow:walk',
    'review:page',
    'review:decide',
    // exports and packages
    'export:generated-mel',
    'export:template-analyze',
    'export:template-mel',
    'export:exto',
    'export:predecessors',
    'export:revision-diff',
    'profile:sections',
    'profile:export',
    'profile:import',
  ];

  for (const channel of expected) {
    assert.ok(IPC_CHANNEL_NAMES.includes(channel), `"${channel}" is missing from the table`);
  }
});

test('every paged channel caps its page size, so paging cannot be defeated', () => {
  const paged = [
    'model:property-page',
    'compile:issues',
    'tree:children',
    'tree:search',
    'flow:roots',
    'flow:walk',
    'review:page',
  ];

  for (const channel of paged) {
    const { request } = IPC_CHANNELS[channel];
    const oversized = { ...IPC_CHANNELS[channel].example.request, limit: 100_000 };
    assert.equal(
      request.safeParse(oversized).success,
      false,
      `"${channel}" accepts an unbounded page size`,
    );
  }
});

test('a null parent is expressible wherever "make this a root" is a real answer', () => {
  // `ManualRelationshipOverride.parentAssetId` is nullable rather than optional
  // precisely because null is an instruction, not an absence. The wire has to
  // preserve that distinction or the instruction cannot be sent.
  for (const channel of ['tree:reparent-preview', 'override:set']) {
    const { request, example } = IPC_CHANNELS[channel];
    const asRoot = { ...example.request, parentAssetId: null };
    assert.ok(
      request.safeParse(asRoot).success,
      `"${channel}" cannot express a make-root instruction`,
    );
  }
});

test('examples survive the structured clone that IPC actually performs', () => {
  for (const channel of IPC_CHANNEL_NAMES) {
    const { example } = IPC_CHANNELS[channel];
    assert.deepEqual(structuredClone(example.request), example.request);
    assert.deepEqual(structuredClone(example.response), example.response);
  }
});
