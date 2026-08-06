import test from 'node:test'
import assert from 'node:assert/strict'
import { loadApp } from './support/harness.mjs'

/* The lasso modal froze at "Rendering page…" in the field: legendLassoOpen's
   first renderProfile() ran BEFORE its try block, and the binder wiring threw
   ($ instead of $$ on '[data-legend-unbind]'), so the finally that clears
   lasso.busy never ran and the modal stayed on the loading frame forever. */

test('wiring the anatomy binder never throws when no unbind buttons are rendered', async () => {
  const app = await loadApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      try { wireLegendAnatomyBinder(activeProfile()); return { ok: true }; }
      catch (error) { return { ok: false, message: String(error && error.message || error) }; }
    })())
  `))
  assert.equal(result.ok, true, `binder wiring threw: ${result.message}`)
})

test('a render crash during lasso open surfaces an error instead of freezing on busy', async () => {
  const app = await loadApp()
  app.eval(`
    globalThis.__renderCalls = 0;
    globalThis.__origRenderProfile = renderProfile;
    renderProfile = function () {
      __renderCalls++;
      if (__renderCalls === 1) throw new Error('render exploded');
    };
  `)
  await app.evalAsync(`
    try { await legendLassoOpen('no-such-source', 1); } catch (_) { /* must not reject either */ }
    return '';
  `)
  const state = JSON.parse(app.eval(`
    renderProfile = __origRenderProfile;
    JSON.stringify({ busy: legendSession.lasso.busy, error: legendSession.lasso.error })
  `))
  assert.equal(state.busy, false, 'busy must always clear — a stuck true is the frozen "Rendering page…" modal')
  assert.ok(state.error.length > 0, 'the failure must surface as a visible error')
})
