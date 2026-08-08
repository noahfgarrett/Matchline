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

test('examples survive the structured clone that IPC actually performs', () => {
  for (const channel of IPC_CHANNEL_NAMES) {
    const { example } = IPC_CHANNELS[channel];
    assert.deepEqual(structuredClone(example.request), example.request);
    assert.deepEqual(structuredClone(example.response), example.response);
  }
});
