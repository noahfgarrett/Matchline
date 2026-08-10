import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewKey } from '@matchline/ssm-compiler';

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

/**
 * The `review:decide` example is a key the compiler could actually have
 * produced, not a hand-written sketch of one.
 *
 * It has been the second thing already: the example outlived a change of
 * separator and went on describing a `|`-joined key nothing emits. Asserting it
 * against `reviewKey` means the next change to the flattening breaks here
 * instead.
 */
test('the review:decide example is a key reviewKey really produces', () => {
  const conflict = {
    kind: 'system-conflict',
    assetId: 'tag:MAH001-10-01',
    claims: [
      { rule: 'tag-segment', proposedValue: '001' },
      { rule: 'mel-lookup', proposedValue: '002' },
    ],
  };

  assert.equal(IPC_CHANNELS['review:decide'].example.request.reviewKey, reviewKey(conflict));
});

/**
 * Every channel that carries per-source data addresses it by `sourceId`
 * (RELEASE-1.0-PLAN P0-1).
 *
 * A file name is not an address once a project may hold two files called
 * `Level 1.nwc`, so a wire shape that named one would be ambiguous exactly
 * where it matters most. This asserts against the declared examples, which the
 * test above already proves are schema-valid.
 */
test('the per-source channels address sources by id, never by file name', () => {
  const [added] = IPC_CHANNELS['source:add'].example.response.results;
  assert.equal(added.outcome, 'added');
  assert.ok(added.source.sourceId.length > 0, 'a registered source carries its id');
  assert.ok(added.source.rawFileName.length > 0);
  assert.ok(added.source.logicalName.length > 0);
  assert.ok('derivedCacheSha256' in added.source, 'and whether a cache is associated yet');

  assert.deepEqual(
    Object.keys(IPC_CHANNELS['source:remove'].example.request),
    ['sourceId'],
    'remove takes an id and nothing else: a name could name two rows',
  );

  const { universe } = IPC_CHANNELS['model:scan'].example.response;
  assert.equal(universe.sources.length, universe.sourceCount);
  for (const source of universe.sources) {
    assert.ok(source.sourceId.length > 0);
  }

  for (const row of IPC_CHANNELS['model:property-page'].example.response.rows) {
    assert.ok(row.bySource.length > 0, 'a catalog row discloses its per-source coverage');
    for (const source of row.bySource) {
      assert.ok(source.sourceId.length > 0);
      assert.ok(source.label.length > 0, 'and a short name to print it under');
    }
  }

  const { preview } = IPC_CHANNELS['asset:preview'].example.response;
  assert.equal(preview.state, 'ready');
  assert.ok(preview.bySource.length > 0, 'the inclusion impact breaks down per source');
  for (const sample of preview.samples) {
    assert.ok(sample.sourceId.length > 0, 'and every sampled asset says where it came from');
  }

  const resolver = IPC_CHANNELS['resolver:preview'].example.response.preview;
  assert.equal(resolver.state, 'ready');
  for (const sample of resolver.samples) {
    assert.ok(sample.sourceId.length > 0);
  }
});

/**
 * A per-source list and its total have to be able to disagree in the shape,
 * because they disagree in the world: 60% overall with one source at 100% and
 * another at 0% is the case the disclosure exists for. A schema that derived
 * one from the other could not express it.
 */
test('per-source coverage is carried, not derived from the overall number', () => {
  const { response } = IPC_CHANNELS['model:property-page'];
  const [row] = IPC_CHANNELS['model:property-page'].example.response.rows;
  const lopsided = {
    ...IPC_CHANNELS['model:property-page'].example.response,
    rows: [
      {
        ...row,
        coverage: 0.6,
        bySource: [
          { sourceId: 'model:a.nwd', label: 'a', objectCount: 10, coverage: 1 },
          { sourceId: 'model:b.nwd', label: 'b', objectCount: 0, coverage: 0 },
        ],
      },
    ],
  };
  assert.ok(response.safeParse(lopsided).success);
});

test('examples survive the structured clone that IPC actually performs', () => {
  for (const channel of IPC_CHANNEL_NAMES) {
    const { example } = IPC_CHANNELS[channel];
    assert.deepEqual(structuredClone(example.request), example.request);
    assert.deepEqual(structuredClone(example.response), example.response);
  }
});
