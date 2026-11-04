const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),a=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),deps=path.join(root,'node_modules');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||path.join(deps,'playwright'));
const out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
require(path.join(deps,'esbuild')).buildSync({stdin:{contents:'window.TestCM={state:require("@codemirror/state"),view:require("@codemirror/view"),commands:require("@codemirror/commands")};',resolveDir:root},nodePaths:[path.join(root,'node_modules')],bundle:true,platform:'browser',outfile:path.join(out,'fixture-cm.js')});
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();fs.readFile(file,(e,body)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html;charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript');res.end(body)});});
const results=[],errors=[];let browser;
async function check(name,run){await run();results.push(name);console.log('PASS '+name)}
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const context=await browser.newContext({viewport:{width:1000,height:1100},hasTouch:true,isMobile:true});const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/tests/fixture.html');await page.waitForFunction(()=>window.ready);
 const cell=(r,c)=>page.locator('#existing tr').nth(r).locator('th,td').nth(c);
 const action=async(group,item)=>{await page.getByRole('button',{name:group,exact:true}).click();await page.getByRole('button',{name:item,exact:true}).click();await page.waitForTimeout(60);};
 await check('startup keeps all existing Markdown, tables and cell contents',async()=>{
  a.equal(await page.evaluate(()=>editor.getValue()===originalSource),true);a.equal(await page.evaluate(()=>writes.length),0);a.equal(await page.evaluate(()=>JSON.stringify(testGrids())===originalGrids),true);a.equal(await page.locator('#tables table').count(),2);
  a.equal(await cell(2,2).isVisible(),true);a.equal(await page.locator('#existing .tcr-merged-hidden').count(),3);
  a.deepEqual(await page.evaluate(()=>p.widths['sample.md'].uexisting),['200px','210px','220px','230px','240px','250px']);
  a.equal(await page.locator('.tt-fixed-header,.tt-fixed-first').count(),0);
 });
 await check('normal touch edits without installing range-drag listeners',async()=>{await cell(1,0).tap();a.equal(await page.evaluate(()=>!!p._drag),false);a.equal(await page.evaluate(()=>!!p._sel),false);a.equal(await page.getByRole('button',{name:'选择区域',exact:true}).isVisible(),true);});
 await check('touch toolbar buttons are at least 44px',async()=>{const sizes=await page.locator('.tt-toolbar button').evaluateAll(bs=>bs.map(b=>[b.getBoundingClientRect().width,b.getBoundingClientRect().height]));a.ok(sizes.every(([w,h])=>w>=44&&h>=44));});
 await check('two taps select a range without Shift',async()=>{await page.getByRole('button',{name:'选择区域',exact:true}).tap();await cell(1,0).tap();await cell(1,1).tap();a.deepEqual(await page.evaluate(()=>[p._sel.r1,p._sel.c1,p._sel.r2,p._sel.c2]),[1,0,1,1]);a.equal(await page.evaluate(()=>!!p._touchRange),false);});
 await check('toolbar style action preserves range and applies to two cells',async()=>{await action('样式','浅黄底色');a.equal(await cell(1,0).getAttribute('data-tt-bg'),'yellow');a.equal(await cell(1,1).getAttribute('data-tt-bg'),'yellow');a.equal(await page.evaluate(()=>p._sel.cells.size),2);});
 await check('real CodeMirror undo and redo restore styles',async()=>{await page.getByRole('button',{name:'撤销',exact:true}).click();await page.waitForTimeout(80);a.equal(await cell(1,0).getAttribute('data-tt-bg'),null);await cell(1,0).tap();await page.getByRole('button',{name:'重做',exact:true}).click();await page.waitForTimeout(80);a.equal(await cell(1,0).getAttribute('data-tt-bg'),'yellow');});
 await check('mark coexists with background and clear styles retains text',async()=>{await cell(1,0).tap();const before=await cell(1,0).textContent();await action('样式','重点标记');a.equal(await cell(1,0).getAttribute('data-tt-marked'),'true');a.equal(await cell(1,0).getAttribute('data-tt-bg'),'yellow');await action('样式','清除样式');a.equal(await cell(1,0).textContent(),before);a.equal(await cell(1,0).getAttribute('data-tt-bg'),null);});
 await check('fit respects pane width and equalization defaults to whole table',async()=>{await action('整理','适应屏幕');const widths=await page.evaluate(()=>p.widths['sample.md'].uexisting.map(parseFloat));a.ok(widths.every(w=>w>=64));a.ok(widths.reduce((a,b)=>a+b)<=950);await action('整理','平均列宽');const next=await page.evaluate(()=>p.widths['sample.md'].uexisting.map(parseFloat));a.equal(next.reduce((a,b)=>a+b),widths.reduce((a,b)=>a+b));a.ok(Math.max(...next)-Math.min(...next)<=1);});
 await check('cancelled column resize restores widths without persisting partial drag',async()=>{
  const state=await page.evaluate(()=>{const table=document.getElementById('existing'),before=JSON.stringify(p.widths['sample.md'].uexisting),handle=table.querySelector('.tcr-handle');handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:9,pointerType:'touch',button:0,clientX:200,clientY:200}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:9,pointerType:'touch',clientX:300,clientY:200}));window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:9,pointerType:'touch'}));return {before,after:JSON.stringify(p.widths['sample.md'].uexisting),resizing:!!table.dataset.tcrResizing}});a.equal(state.after,state.before);a.equal(state.resizing,false);
 });
 await check('lost capture also cancels column drag safely',async()=>{
  const state=await page.evaluate(()=>{const table=document.getElementById('existing'),before=JSON.stringify(p.widths['sample.md'].uexisting),handle=table.querySelector('.tcr-handle');handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:10,pointerType:'touch',button:0,clientX:200}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:10,pointerType:'touch',clientX:290}));handle.dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:10}));return {before,after:JSON.stringify(p.widths['sample.md'].uexisting),resizing:!!table.dataset.tcrResizing}});a.equal(state.after,state.before);a.equal(state.resizing,false);
 });
 await check('row resize uses saved merged-grid height and works during range mode',async()=>{
  const state=await page.evaluate(()=>{const table=document.getElementById('existing');p.setRowHeights('sample.md','uexisting',[null,'90px']);p.reflowTable(table);p._touchRange={table,anchor:null};const handle=table.rows[1].cells[0].querySelector('.tt-row-handle');const before=parseFloat(getComputedStyle(table).gridTemplateRows.split(' ')[1]);handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:20,pointerType:'touch',button:0,clientY:100}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:20,pointerType:'touch',clientY:120}));const after=parseFloat(p.getRowHeights('sample.md','uexisting')[1]);window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:20}));p._touchRange=null;return{before,after,cancelled:p.getRowHeights('sample.md','uexisting')[1],cleanup:!!p._rowCleanup}});a.equal(state.after,state.before+20);a.equal(state.cancelled,'90px');a.equal(state.cleanup,false);
 });
 await check('touch toolbar actions preserve active embedded editor focus',async()=>{
  await page.evaluate(()=>{const input=document.createElement('input');input.id='focus-fixture';document.body.appendChild(input);input.focus();});
  await page.getByRole('button',{name:'选择区域',exact:true}).tap();a.equal(await page.evaluate(()=>document.activeElement.id),'focus-fixture');
  await page.getByRole('button',{name:'完成选择',exact:true}).tap();await page.evaluate(()=>document.getElementById('focus-fixture').remove());
 });
 await check('export reads active cell editor once rather than hidden rendered text',async()=>{
  const text=await page.evaluate(()=>{const cell=document.createElement('td');cell.innerHTML='<div class="table-cell-content" style="display:none">旧文本</div><div class="table-cell-wrapper"><div class="cm-content"><div class="cm-line">正在编辑的文本</div></div></div>';return p.cleanCellText(cell)});a.equal(text,'正在编辑的文本');
 });
 await check('export preserves active editor line breaks',async()=>{
  const text=await page.evaluate(()=>{const cell=document.createElement('td');cell.innerHTML='<div class="table-cell-wrapper"><div class="cm-content"><div class="cm-line">第一行</div><div class="cm-line">第二行</div></div></div>';return p.cleanCellText(cell)});a.equal(text,'第一行\n第二行');
 });
 await check('fixed header and first column stay pinned on both axes',async()=>{
  await action('固定','固定表头');await action('固定','固定首列');
  await page.evaluate(()=>{p.setWidths('sample.md','uexisting',Array(6).fill('220px'));p.reflowTable(document.getElementById('existing'));});
  await page.evaluate(()=>{const host=document.getElementById('existing').parentElement;host.scrollTop=220;host.scrollLeft=160;});await page.waitForTimeout(80);
  const rect=await page.evaluate(()=>{const t=document.getElementById('existing'),h=t.parentElement.getBoundingClientRect(),c=t.rows[0].cells[0].getBoundingClientRect();return {x:c.left-h.left,y:c.top-h.top}});a.ok(Math.abs(rect.x)<=3,JSON.stringify(rect));a.ok(Math.abs(rect.y)<=3,JSON.stringify(rect));
 });
 await check('other table layout is unchanged after edits',async()=>{a.deepEqual(await page.evaluate(()=>p.widths['sample.md'].uother),['120px','150px']);a.deepEqual(await page.evaluate(()=>p.tableOptions['sample.md'].uother||{}),{});});
 await check('reset clears row height but preserves contents styles and merges; undo restores height',async()=>{
  const state=await page.evaluate(()=>{const table=document.getElementById('other');p.clearMergeSelection();p.activateCell(table,table.rows[1].cells[0]);p.setRowHeights('sample.md','uother',[null,'95px']);p.reflowTable(table);p.setCellStyle('bg','green');const before=table.textContent;p.layoutAction('reset');return{height:table.rows[1].style.height,same:before===table.textContent,bg:table.rows[1].cells[0].dataset.ttBg}});
  a.equal(state.height,'');a.equal(state.same,true);a.equal(state.bg,'green');await page.getByRole('button',{name:'撤销',exact:true}).click();await page.waitForTimeout(80);a.equal(await page.locator('#other tr').nth(1).evaluate(r=>r.style.height),'95px');await page.evaluate(()=>p.activateCell(document.getElementById('existing'),document.getElementById('existing').rows[1].cells[0]));
 });
 await check('reading view keeps existing merged content and stored layout',async()=>{
  const state=await page.evaluate(()=>{const source=document.getElementById('existing'),preview=document.createElement('div');preview.className='markdown-preview-view';const t=document.createElement('table');t.dataset.fixtureUid='existing';
   for(let r=0;r<source.rows.length;r++){const row=(r===0?t.createTHead():t.tBodies[0]||t.createTBody()).insertRow();for(let c=0;c<source.rows[r].cells.length;c++){const cell=r===0?document.createElement('th'):document.createElement('td');cell.textContent=(r===0&&c===0?p.encodeInvisibleUid('existing'):'')+p.cleanCellText(source.rows[r].cells[c]);row.appendChild(cell)}}
   preview.appendChild(t);document.body.appendChild(preview);p.postProcess(preview,{sourcePath:'sample.md'});const out={rows:t.rows.length,merged:t.rows[2].cells[2].textContent,hidden:t.querySelectorAll('.tcr-merged-hidden').length,widths:p.currentWidths(t),text:editor.getValue()};preview.remove();return out;});
  a.equal(state.rows,30);a.equal(state.merged,'已有合并内容');a.equal(state.hidden,3);a.deepEqual(state.widths,await page.evaluate(()=>p.widths['sample.md'].uexisting));a.equal(state.text,await page.evaluate(()=>originalSource));
 });
 await check('toolbar stays inside split-pane and simulated keyboard viewport',async()=>{
  await page.evaluate(()=>{document.querySelector('.workspace-leaf-content').style.width='520px';Object.defineProperty(window,'visualViewport',{configurable:true,value:{width:1000,height:560,offsetTop:0,offsetLeft:0,addEventListener(){},removeEventListener(){}}});p._ttViewport();});
  const b=await page.locator('.tt-toolbar').boundingBox();a.ok(b.x>=0&&b.x+b.width<=550&&b.y+b.height<=560,JSON.stringify(b));
 });
 await check('HTML export preserves merge layout without changing the note',async()=>{
  await page.evaluate(()=>p.selectWhole(document.getElementById('existing')));const before=await page.evaluate(()=>editor.getValue());await action('复制/导出','导出 HTML');await action('复制/导出','导出 HTML');
  const files=await page.evaluate(()=>[...window.files.entries()].filter(([k])=>k.endsWith('.html')));a.equal(files.length,2);a.match(files[0][1],/rowspan="2" colspan="2"/);a.doesNotMatch(files[0][1],/tcr-handle|tt-row-handle|<script/);a.equal(await page.evaluate(()=>editor.getValue()),before);
 });
 await check('rich clipboard denial reports fallback without false success',async()=>{await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:async()=>{throw Error('denied')},writeText:async text=>window.copiedPlain=text}}));await action('复制/导出','复制到 Excel');a.match(await page.evaluate(()=>notices.at(-1)),/纯文本/);await action('复制/导出','复制纯文本');a.ok(await page.evaluate(()=>copiedPlain.includes('\t')));});
 await check('dark theme changes semantic cell colors',async()=>{await page.evaluate(()=>{document.body.classList.add('theme-dark');p.selectRect(document.getElementById('existing'),1,0,1,0,'sample.md','uexisting');p.setCellStyle('bg','blue')});a.equal(await cell(1,0).evaluate(c=>getComputedStyle(c).backgroundColor),'rgb(41, 66, 94)');});
 await page.evaluate(()=>{document.querySelector('.workspace-leaf-content').style.width='';document.getElementById('existing').parentElement.scrollTop=0;document.getElementById('existing').parentElement.scrollLeft=0;Object.defineProperty(window,'visualViewport',{configurable:true,value:{width:1000,height:1100,offsetTop:0,offsetLeft:0,addEventListener(){},removeEventListener(){}}});p._ttViewport();});
 await page.screenshot({path:path.join(out,'android-table-dark.png'),fullPage:true});
 await page.evaluate(()=>document.body.classList.remove('theme-dark'));await page.screenshot({path:path.join(out,'android-table-light.png'),fullPage:true});
 await check('unload reveals original cells and removes added controls',async()=>{await page.evaluate(()=>p.onunload());a.equal(await page.locator('.tt-open,.tt-row-handle,.tt-toolbar').count(),0);a.equal(await page.locator('#tables table').count(),2);a.equal(await page.evaluate(()=>JSON.stringify(testGrids())===originalGrids),true);a.equal(await page.locator('.tcr-merged-hidden').count(),0);});
 a.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'ui-results.json'),JSON.stringify({passed:results.length,results,errors},null,2));console.log('UI checks passed: '+results.length);
 }catch(e){fs.writeFileSync(path.join(out,'ui-results.json'),JSON.stringify({passed:results.length,results,errors,failure:e.stack},null,2));console.error(e);process.exitCode=1;}finally{await browser?.close();server.close();}})();
