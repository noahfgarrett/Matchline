import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

test('hierarchy-launched Studio previews only the tabs used by the hierarchy', async () => {
  const app=await loadApp()
  const result=JSON.parse(app.eval(`
    JSON.stringify((function(){
      const sep=KEYSEP;
      S.files=[
        {id:'f1',name:'Power.xlsx',error:null,sheets:['Easy Power','Notes']},
        {id:'f2',name:'Cable.xlsx',error:null,sheets:['Cable Schedule','Archive']},
        {id:'f3',name:'MEL.xlsx',error:null,sheets:['Equipment_List']}
      ];
      const easy='f1'+sep+'Easy Power',cable='f2'+sep+'Cable Schedule',mel='f3'+sep+'Equipment_List';
      S.selected.add(easy);S.cableSel.add(cable);S.melSel.add(mel);
      S.profileUi.returnScreen='result';
      const resultKeys=profilePreviewKeys();
      S.profileUi.returnScreen='upload';
      const uploadKeys=profilePreviewKeys();
      return {resultKeys,uploadKeys};
    })())
  `))

  assert.deepEqual(result.resultKeys.map(String),[
    'f1\u0001Easy Power',
    'f2\u0001Cable Schedule',
    'f3\u0001Equipment_List',
  ])
  assert.equal(result.uploadKeys.length,5)
  assert.ok(result.uploadKeys.some(key=>key.endsWith('Notes')))
  assert.ok(result.uploadKeys.some(key=>key.endsWith('Archive')))
})

test('virtual spreadsheet reaches rows beyond 120 without rendering the whole workbook', async () => {
  const app=await loadApp()
  const result=JSON.parse(app.eval(`
    JSON.stringify((function(){
      const rows=Array.from({length:2500},(_,row)=>['TAG-'+(row+1),'VALUE-'+(row+1)]);
      const rec={aoa:rows,rowNums:rows.map((_,row)=>row),headerRow:0};
      const data={rec,headerRow:0,mappedCols:new Set([0])};
      const scrollTop=2200*PROFILE_PREVIEW_ROW_HEIGHT;
      const start=profilePreviewWindowStart(scrollTop,rows.length);
      S.profileUi.selectedCell={row:2210,col:0};
      S.profileUi.rangeStart=2;S.profileUi.rangeEnd=5;
      const html=previewRowsMarkup(data,start,profilePreviewColumnCount(rec));
      return {
        start,
        renderedRows:(html.match(/data-preview-table-row=/g)||[]).length,
        hasDeepRow:html.includes('data-preview-row="2210"'),
        selected:html.includes('class="selected mapped"'),
        hasFirstRow:html.includes('data-preview-row="0"'),
        range:[S.profileUi.rangeStart,S.profileUi.rangeEnd],
        hasVirtualSpace:html.includes('preview-spacer')
      };
    })())
  `))

  assert.ok(result.start>120)
  assert.equal(result.renderedRows,96)
  assert.equal(result.hasDeepRow,true)
  assert.equal(result.selected,true)
  assert.equal(result.hasFirstRow,false)
  assert.deepEqual(result.range,[2,5])
  assert.equal(result.hasVirtualSpace,true)
})

test('spreadsheet preview exposes fullscreen controls and keeps viewport state', async () => {
  const app=await loadApp()
  const result=JSON.parse(app.eval(`
    JSON.stringify((function(){
      initProfiles();
      const key='f1'+KEYSEP+'Equipment_List';
      const aoa=Array.from({length:700},(_,row)=>['EQ-'+row,'UPN-'+row]);
      S.files=[{id:'f1',name:'MEL.xlsx',error:null,sheets:['Equipment_List']}];
      S.aoaCache.set(key,{aoa,rowNums:aoa.map((_,row)=>row),headerRow:0});
      S.profileUi.previewKey=key;S.profileUi.sourceKind='mel';
      S.profileUi.previewScrollTop=510*PROFILE_PREVIEW_ROW_HEIGHT;
      S.profileUi.previewScrollLeft=128;S.profileUi.previewFullscreen=true;
      S.profileUi.selectedCell={row:520,col:0};S.profileUi.rangeStart=1;S.profileUi.rangeEnd=3;
      const html=renderSheetPreview(activeProfile());
      return {
        fullscreen:html.includes('sheet-preview-frame fullscreen'),
        minimize:html.includes('title="Return to compact view"'),
        allRows:html.includes('aria-rowcount="700"'),
        deepSelection:html.includes('data-preview-row="520"'),
        scroll:[S.profileUi.previewScrollTop,S.profileUi.previewScrollLeft],
        selection:S.profileUi.selectedCell,
        range:[S.profileUi.rangeStart,S.profileUi.rangeEnd]
      };
    })())
  `))

  assert.equal(result.fullscreen,true)
  assert.equal(result.minimize,true)
  assert.equal(result.allRows,true)
  assert.equal(result.deepSelection,true)
  assert.deepEqual(result.scroll,[17340,128])
  assert.deepEqual(result.selection,{row:520,col:0})
  assert.deepEqual(result.range,[1,3])
})

test('Files guidance and the sectioned in-app Guide cover the complete workflow', async () => {
  const app=await loadApp()
  const result=JSON.parse(app.eval(`
    JSON.stringify((function(){
      const imports=importRequirementsMarkup(),modal=guideModalMarkup(),studio=guideSectionMarkup('studio'),start=guideSectionMarkup('start');
      return {
        imports:['Easy Power','Cable Schedule','Master Equipment List','Point Master Database','INSTALL PMD','Equipment_List'].every(text=>imports.includes(text)),
        sections:GUIDE_SECTIONS.map(([id])=>id).every(id=>modal.includes('data-guide-section="'+id+'"')),
        studio:['Data Mapping','Tag Trainer','Relationships','Hierarchy and Details','Test and Publish','automatically rebuilds'].every(text=>studio.includes(text)),
        journey:['Upload','Select','Build','Review','Export'].every(text=>start.includes(text)),
        close:modal.includes('id="closeGuide"')
      };
    })())
  `))

  assert.deepEqual(result,{imports:true,sections:true,studio:true,journey:true,close:true})
})
