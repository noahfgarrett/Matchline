/**
 * The classifier module, pinned to the vendored engine.
 *
 * `src/classify.ts` restates the rulebook's description regexes because the
 * engine's own `auditIsX` predicates are module-private and `vendor/` is never
 * edited. Restating them is only safe if a re-vendor that changes one FAILS,
 * so this file reads `vendor/audit/engine.js` as text, pulls each function's
 * regex literals out by name, and compares them against `AUDIT_REGEXPS`
 * source-for-source and flag-for-flag, in order.
 *
 * A new word in `auditIsPanel`, a dropped alternative in `auditIsRoomSensor`,
 * an added `i` flag: every one of those turns into a failure here rather than
 * into Matchline building a hierarchy its own gate rejects.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AUDIT_REGEXPS,
  equipmentClass,
  isControlValve,
  isDrivenEquipment,
  isFmsIo,
  isInstrumentLike,
  isLcp,
  isPanel,
  isRoomSensor,
  isVfd,
  polarity,
} from '../dist/classify.js';

const ENGINE = readFileSync(
  fileURLToPath(new URL('../vendor/audit/engine.js', import.meta.url)),
  'utf8',
);

/**
 * Every regex literal in one engine function, in source order.
 *
 * Each classifier is one line in the engine, so the body is the rest of that
 * line. The literal pattern handles escaped slashes (`I\/?O`) and character
 * classes, which is everything these regexes actually use.
 */
function engineRegexps(name) {
  const start = ENGINE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is not in the vendored engine`);
  const end = ENGINE.indexOf('\n', start);
  const body = ENGINE.slice(start, end === -1 ? undefined : end);
  const literal = /\/((?:[^/\\[\n]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/([gimsuy]*)/g;
  const found = [];
  let match;
  while ((match = literal.exec(body)) !== null) {
    found.push({ source: match[1], flags: match[2] });
  }
  return found;
}

test('every classifier regex is the vendored engine’s, character for character', () => {
  const names = Object.keys(AUDIT_REGEXPS);
  assert.ok(names.length >= 20, 'every classifier the SOP rules read is pinned');

  for (const name of names) {
    const vendored = engineRegexps(name);
    const restated = AUDIT_REGEXPS[name].map((value) => ({
      source: value.source,
      flags: value.flags,
    }));
    assert.deepEqual(restated, vendored, `${name} drifted from the vendored engine`);
  }
});

test('the classifiers answer what the engine answers', () => {
  assert.equal(isVfd('Variable frequency drive for the supply fan'), true);
  assert.equal(isVfd('Motor starter for the sump pump'), false, 'a starter is not a VFD');
  assert.equal(isPanel('MCC 101 motor control centre'), true);
  assert.equal(isLcp('Local control panel'), true);
  assert.equal(isFmsIo('FMS hardwired I/O for the supply fan drive'), true);
  assert.equal(isControlValve('Chilled water control valve'), true);
  assert.equal(isRoomSensor('Room temperature sensor'), true);
  assert.equal(isDrivenEquipment('Makeup air handler for the cleanroom suite'), true);
  assert.equal(
    isDrivenEquipment('Variable frequency drive for the air handler'),
    false,
    'a drive named after what it drives is still a drive',
  );
  assert.equal(
    isInstrumentLike('MCC 101 motor control centre switch'),
    false,
    'a panel is not an instrument',
  );
  assert.equal(polarity('Electrical'), 'top-down');
  assert.equal(polarity('Mechanical'), 'bottom-up');
});

test('equipmentClass resolves the overlaps in one documented order', () => {
  assert.equal(equipmentClass('Fire alarm control panel'), 'facp', 'before panel and controller');
  assert.equal(equipmentClass('Local control panel'), 'lcp', 'before panel');
  assert.equal(equipmentClass('Heat trace panel'), 'heat-trace-panel', 'before panel');
  assert.equal(equipmentClass('Heat trace power connection box'), 'heat-trace-connection');
  assert.equal(equipmentClass('Chilled water control valve'), 'control-valve', 'before instrument');
  assert.equal(equipmentClass('Room temperature sensor'), 'room-sensor', 'before instrument');
  assert.equal(equipmentClass('Supply air temperature element'), 'instrument');
  assert.equal(equipmentClass('MCC 101 motor control centre'), 'panel');
  assert.equal(equipmentClass('Makeup air handler for the cleanroom suite'), 'driven');
  assert.equal(equipmentClass('Dry type transformer'), 'transformer');
  assert.equal(equipmentClass('Remote I/O drop'), 'rio', 'before plc');
  assert.equal(equipmentClass('A thing'), 'other');
});

test('the tag is read only when the description says nothing, and only in the engine’s own words', () => {
  assert.equal(equipmentClass('', 'VFD101-01'), 'vfd');
  assert.equal(equipmentClass('', 'MCC101'), 'panel');
  assert.equal(equipmentClass('', 'PLC101-01'), 'plc');
  assert.equal(
    equipmentClass('', 'TIT101-01'),
    'other',
    'what TIT means is a fact about a site, not about the rulebook',
  );
  assert.equal(
    equipmentClass('Makeup air handler for the cleanroom suite', 'VFD101-01'),
    'driven',
    'the description decides whenever it decides anything',
  );
});
