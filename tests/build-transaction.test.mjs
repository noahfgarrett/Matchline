import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { buildHtml } from '../build/build.mjs'
import { loadApp } from './support/harness.mjs'

test('a failed rebuild restores the complete previous result snapshot', async () => {
  const directory=mkdtempSync(join(tmpdir(),'ssmanagement-transaction-'))
  const htmlPath=join(directory,'SSMCompiler.html')
  writeFileSync(htmlPath,buildHtml())
  try{
    const app=await loadApp(htmlPath),bytes=[...readFileSync(resolve('tests/fixtures/easy-power.xlsx'))]
    app.eval(`globalThis.__fixture=${JSON.stringify(bytes)}`)
    const result=JSON.parse(await app.evalAsync(`
      const bytes=new Uint8Array(__fixture),wb=XLSX.read(bytes,{type:'array'});
      S.files=[{id:'f0',name:'easy-power.xlsx',ext:'xlsx',size:bytes.length,wb,sheets:wb.SheetNames.slice(),strikes:extractStrikeCells(bytes),error:null}];
      await prewarmSheets();for(const key of allHierKeys())S.selected.add(key);
      const first=await buildHierarchy(),beforeRoots=S.roots,beforeRows=JSON.stringify(S.ssmCombined),beforeSnapshot=S.resolvedSnapshot;
      const original=rebuildProfileProjections,originalError=console.error;console.error=()=>{};
      rebuildProfileProjections=()=>{throw new Error('injected resolver failure')};
      const second=await buildHierarchy();
      rebuildProfileProjections=original;console.error=originalError;
      return JSON.stringify({first,second,sameRoots:S.roots===beforeRoots,sameRows:JSON.stringify(S.ssmCombined)===beforeRows,
        sameSnapshot:S.resolvedSnapshot===beforeSnapshot,screen:S.screen});
    `))
    assert.deepEqual(result,{first:true,second:false,sameRoots:true,sameRows:true,sameSnapshot:true,screen:'result'})
  }finally{
    rmSync(directory,{recursive:true,force:true})
  }
})
