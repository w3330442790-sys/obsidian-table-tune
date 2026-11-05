window.module={exports:{}};
window.notices=[];window.writes=[];window.files=new Map();window.savedData=null;window.extensions=[];window.commands=[];window.callbacks=[];
const data={widths:{'sample.md':{uexisting:['200px','210px','220px','230px','240px','250px'],uother:['120px','150px']}},rowHeights:{},merges:{'sample.md':{uexisting:[{r:2,c:2,rowspan:2,colspan:2}]}},tableDims:{'sample.md':{uexisting:{rows:30,cols:6},uother:{rows:3,cols:2}}},alignments:{'sample.md':{uexisting:{'1,1':'center'}}},future:{untouched:true}};
const api={
 Plugin:class{async loadData(){return JSON.parse(JSON.stringify(data))}async saveData(d){window.savedData=JSON.parse(JSON.stringify(d))}registerEvent(){}registerEditorExtension(e){extensions.push(...e)}registerMarkdownPostProcessor(f){this.postProcess=f}addCommand(c){commands.push(c)}},
 MarkdownView:class{},Notice:class{constructor(t){notices.push(t)}},setIcon(){},
 Menu:class{
  constructor(){this.items=[]}addItem(build){const item={setTitle:t=>{item.title=t;return item},setChecked:v=>{item.checked=v;return item},onClick:f=>{item.run=f;return item}};build(item);this.items.push(item);return this}
  showAtPosition(pos){document.querySelectorAll('.menu').forEach(m=>m.remove());const menu=document.createElement('div');menu.className='menu';
   for(const item of this.items){const b=document.createElement('button');b.textContent=(item.checked?'✓ ':'')+item.title;b.setAttribute('aria-label',item.title);b.addEventListener('click',()=>{menu.remove();item.run()});menu.appendChild(b)}
   menu.style.left=Math.min(pos.x,innerWidth-190)+'px';menu.style.bottom='85px';document.body.appendChild(menu);
  }
 }
};
window.require=id=>id==='obsidian'?api:id==='@codemirror/state'?TestCM.state:id==='@codemirror/view'?TestCM.view:id==='@codemirror/commands'?TestCM.commands:(()=>{throw Error('Unknown module '+id)})();
window.startFixture=async Plugin=>{
 const p=window.p=new Plugin(),events=new Map();
 p.app={workspace:{getActiveFile:()=>({path:'sample.md'}),on:(name,f)=>{events.set(name,f);return{}},onLayoutReady:f=>callbacks.push(f),getActiveViewOfType:()=>({editor:window.editor,getState:()=>({mode:'preview'}),leaf:{setViewState:async view=>{window.requestedViewState=view.state}}})},vault:{adapter:{exists:async path=>files.has(path)},createFolder:async path=>files.set(path,{folder:true}),create:async(path,text)=>{if(files.has(path))throw Error('exists');files.set(path,text);return{path}}}};
 const table=(id,n,m)=>{const t=document.createElement('table');t.id=id;t.dataset.fixtureUid=id==='existing'?'existing':'other';const head=t.createTHead().insertRow();for(let c=0;c<m;c++){const th=document.createElement('th');th.textContent=(c===0?p.encodeInvisibleUid(t.dataset.fixtureUid):'')+['项目名称','对比维度','说明','备注','关联','来源'][c];head.appendChild(th)}
  const body=t.createTBody();for(let r=1;r<n;r++){const row=body.insertRow();for(let c=0;c<m;c++){const cell=row.insertCell();cell.textContent=(r===2&&c===2)?'已有合并内容':(r===2||r===3)&&(c===2||c===3)?'':c===0?'项目 '+r:'第 '+r+' 行 · 第 '+c+' 列'}}
  const host=document.createElement('div');host.className='table-wrapper';host.appendChild(t);document.getElementById('tables').appendChild(host);return t;};
 const existing=table('existing',30,6),other=table('other',3,2);
 const grids=()=>Array.from(document.querySelectorAll('#tables table')).map(t=>Array.from(t.rows,row=>Array.from(row.cells,c=>p.stripTableIdentity(c.textContent))));
 window.originalGrids=JSON.stringify(grids());window.originalTexts=existing.textContent;
 const source=Array.from(existing.rows,row=>p.buildRow(Array.from(row.cells,c=>c.textContent)));source.splice(1,0,p.buildRow(Array(6).fill('---')));window.originalSource=source.join('\n');
 await p.onload();
 const cm=new TestCM.view.EditorView({state:TestCM.state.EditorState.create({doc:originalSource,extensions:[TestCM.commands.history(),...extensions]}),parent:document.getElementById('native-editor')});
 window.editor={cm,getLine:i=>cm.state.doc.line(i+1).text,lineCount:()=>cm.state.doc.lines,getValue:()=>cm.state.doc.toString(),getCursor:()=>({line:0,ch:0}),replaceRange:(text,from,to)=>{writes.push({text,from,to});cm.dispatch({changes:{from:from.line?cm.state.doc.line(from.line+1).from+from.ch:from.ch,to:to.line?cm.state.doc.line(to.line+1).from+to.ch:to.ch,insert:text}})}};
 // Fixture source mapping stands in for Obsidian's private widget mapping. The actual CodeMirror history is used.
 p.tableSourceInfo=(ed,t)=>{const grid=Array.from(t.rows,row=>Array.from(row.cells,c=>p.cleanCellText(c)));const uid=t.dataset.fixtureUid;grid[0][0]=p.encodeInvisibleUid(uid)+grid[0][0];return{uid,grid,header:p.buildRow(grid[0]),sep:p.buildRow(grid[0].map(()=> '---')),from:0,to:cm.state.doc.length,toPos:i=>({line:0,ch:i})};};
 for(const cb of callbacks)cb();await p._saveQueue;
 window.testGrids=grids;window.testEvents=events;window.ready=true;
};
