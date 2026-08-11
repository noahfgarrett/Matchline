/**
 * Stage announcements (RELEASE-1.0-PLAN, "Performance / isolation").
 *
 * `compileProject` is one synchronous call that can run for minutes on a real
 * site, and the desktop now runs it on a worker thread so the window keeps
 * drawing. A worker that could only say "still working" would be a worse answer
 * than the blocking main-thread compile it replaced, so the pipeline announces
 * which stage it is starting.
 *
 * The two things that have to hold, and are the whole of this file:
 *
 * 1. every stage is announced, once, in `COMPILE_STAGES` order -- a caller
 *    rendering "3 of 14" is counting a fixed sequence, not one that depends on
 *    which workbooks the project happens to have;
 * 2. a compile with a listener and a compile without one are deep-equal --
 *    observation cannot become influence (ENGINE.md binding rule 3).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { COMPILE_STAGES, compileProject } from '../dist/index.js';
import { fullInput, openDragonCache } from './support.mjs';

/** The compiled project minus the one member `deepEqual` cannot compare well. */
function withoutWorkbookBytes(project) {
  return { ...project, generatedMel: { rows: project.generatedMel.rows } };
}

test('every stage is announced once, in COMPILE_STAGES order', () => {
  const handle = openDragonCache('stages-order');
  try {
    const seen = [];
    compileProject({
      ...fullInput(handle.cache),
      onStage: (stage) => {
        seen.push(stage);
      },
    });
    assert.deepEqual(seen, [...COMPILE_STAGES]);
  } finally {
    handle.close();
  }
});

test('a project with no workbooks still announces the same sequence', () => {
  const handle = openDragonCache('stages-bare');
  try {
    const seen = [];
    compileProject({
      ...fullInput(handle.cache, { melWorkbook: undefined, connectivityWorkbooks: [] }),
      onStage: (stage) => {
        seen.push(stage);
      },
    });
    // A stage with nothing to do is still a stage: a sequence that shortened
    // itself would make "how far along am I" a different question per project.
    assert.deepEqual(seen, [...COMPILE_STAGES]);
  } finally {
    handle.close();
  }
});

test('listening changes nothing about what the compile decides', () => {
  const listening = openDragonCache('stages-listening');
  const silent = openDragonCache('stages-silent');
  try {
    const observed = compileProject({
      ...fullInput(listening.cache),
      onStage: () => {},
    });
    const plain = compileProject(fullInput(silent.cache));
    assert.deepStrictEqual(withoutWorkbookBytes(observed), withoutWorkbookBytes(plain));
    assert.deepEqual(
      Buffer.from(observed.generatedMel.workbookBytes),
      Buffer.from(plain.generatedMel.workbookBytes),
    );
  } finally {
    listening.close();
    silent.close();
  }
});

test('a compiled project survives a structured clone unchanged', () => {
  // What lets the desktop run a compile on a worker thread at all: the whole
  // published value has to cross a postMessage boundary, Maps and typed arrays
  // included, without a bespoke serializer that could quietly drop a stage's
  // output on the way (apps/desktop/electron/services/compile-worker.ts).
  const handle = openDragonCache('stages-clone');
  try {
    const project = compileProject(fullInput(handle.cache));
    const cloned = structuredClone(project);
    assert.deepStrictEqual(withoutWorkbookBytes(cloned), withoutWorkbookBytes(project));
    assert.deepEqual(
      Buffer.from(cloned.generatedMel.workbookBytes),
      Buffer.from(project.generatedMel.workbookBytes),
    );
    assert.ok(cloned.snapshot.nodes instanceof Map, 'the snapshot index is still a Map');
    assert.ok(cloned.systems.bySubject instanceof Map, 'the resolver index is still a Map');
    assert.ok(cloned.flow.nodes instanceof Map, 'the flow index is still a Map');
  } finally {
    handle.close();
  }
});
