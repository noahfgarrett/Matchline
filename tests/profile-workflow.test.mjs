import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

const rootDir=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const fixtureBytes=file=>[...readFileSync(resolve(rootDir,'tests/fixtures',file))]

async function buildWithWorkflow(files,changes={}){
  const app=await loadApp()
  app.eval(`globalThis.__workflowFixtures=${JSON.stringify(files.map(name=>({name,bytes:fixtureBytes(name)})))};
    globalThis.__workflowChanges=${JSON.stringify(changes)}`)
  await app.evalAsync(`
    initProfiles();
    const profile=normalizeProfile({...profileCore(activeProfile()),id:'workflow-test',name:'Workflow Test',builtIn:false,locked:false});
    Object.assign(profile.hierarchy.workflow,__workflowChanges);
    PROFILE_STORE.activeId=profile.id;PROFILE_STORE.profiles=[profile];setRuleProfile(profile);
    for(const fx of __workflowFixtures){
      const bytes=new Uint8Array(fx.bytes),wb=XLSX.read(bytes,{type:'array'});
      S.files.push({id:'f'+S.files.length,name:fx.name,ext:fx.name.split('.').pop(),size:bytes.length,wb,
        sheets:wb.SheetNames.slice(),strikes:extractStrikeCells(bytes),error:null});
    }
    await prewarmSheets();
    for(const key of allHierKeys())S.selected.add(key);
    await buildHierarchy();
  `)
  return app
}

test('PMD attachment switch changes the hierarchy and register, not just the Studio UI',async()=>{
  const enabled=await buildWithWorkflow(['easy-power.xlsx','pmd.xlsx'])
  const disabled=await buildWithWorkflow(['easy-power.xlsx','pmd.xlsx'],{pmdInstrumentAttachment:false})
  const read=app=>JSON.parse(app.eval(`JSON.stringify({
    read:S.pmdRows.length,
    instruments:S.stats.instruments,
    register:S.ssmCombined.filter(row=>/^PT-|^TT-/.test(row[0])).map(row=>row[0])
  })`))
  assert.deepEqual(read(enabled),{read:2,instruments:2,register:['PT-0001','TT-0002']})
  assert.deepEqual(read(disabled),{read:2,instruments:0,register:[]})
})

test('Cable Schedule parent-chain switch preserves the Easy Power parent when disabled',async()=>{
  const files=['easy-power-rules.xlsx','cable-schedule-rules.xlsx']
  const enabled=await buildWithWorkflow(files)
  const disabled=await buildWithWorkflow(files,{cableParentChains:false})
  const parent=app=>app.eval(`ssmResolve(S.ssmCombined.find(row=>row[0]==='MTR-4100')).parent`)
  assert.equal(parent(enabled),'B14-LVS-4002')
  assert.equal(parent(disabled),'B14-LVS-4001')
})

test('MEL UPN parent switch controls System Parent Equipment Tag replacement',async()=>{
  const files=['easy-power-upn-repair.csv','mel-row2-upn-repair.csv']
  const enabled=await buildWithWorkflow(files)
  const disabled=await buildWithWorkflow(files,{melUpnParents:false})
  const relation=app=>JSON.parse(app.eval(`JSON.stringify(ssmResolve(S.ssmCombined.find(row=>row[0]==='EQUIPMENT-133')))`))
  assert.equal(relation(enabled).parent,'F15-SYSTEM-PARENT-133')
  assert.equal(relation(enabled).dep,'OLD-PARENT-603')
  assert.equal(relation(disabled).parent,'OLD-PARENT-603')
})
