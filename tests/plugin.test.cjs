const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 const cache={},notices=[],document={querySelectorAll:()=>[]};
 const api={Plugin:class{},MarkdownView:class{},Notice:class{constructor(t){notices.push(t)}},setIcon(){},Modal:class{},Menu:class{}};
 const load=name=>{const file=path.resolve(__dirname,'../src',name);if(cache[file])return cache[file].exports;
  const module={exports:{}};cache[file]=module;
  const require=id=>id==='obsidian'?api:id.startsWith('./')?load(id.slice(2)):id==='@codemirror/state'?{StateEffect:{define:()=>({of:x=>x})}}:id==='@codemirror/commands'?{invertedEffects:{of:x=>x}}:id==='@codemirror/view'?{EditorView:{updateListener:{of:x=>x}}}:null;
  vm.runInNewContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{console,document,requestAnimationFrame:f=>f(),setTimeout:()=>0,clearTimeout,Map,Set})(require,module,module.exports);return module.exports;};
 let P;try{P=load('plugin.cjs')}catch(e){if(e.code!=='ENOENT')throw e;P=class{};}
 const p=new P();for(const name of ['widths','rowHeights','merges','tableDims','alignments','cellStyles','tableOptions'])p[name]={};
 p._savedData={customFuture:{keep:true}};p.saveData=data=>{p.saved=data};p.currentPath=()=> 'note.md';p.activeEditor=()=>null;p.registerEditorExtension=()=>{};
 return {p,notices};
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('replacement uses original plugin ID and newer version',()=>{
 const m=require('../manifest.json');a.equal(m.id,'table-tune');a.equal(m.version,'2.1.0');a.equal(m.isDesktopOnly,false);
});
test('persist preserves unknown data and legacy table layout',async()=>{
 const {p}=fixture();p.widths={'note.md':{t:['100px','200px']}};p.merges={'note.md':{t:[{r:1,c:0,rowspan:1,colspan:2}]}};
 a.equal(typeof p.persist,'function');await p.persist();a.deepEqual(plain(p.saved.customFuture),{keep:true});a.deepEqual(plain(p.saved.widths),p.widths);a.deepEqual(plain(p.saved.merges),p.merges);
});
test('stable ID adoption retains styles and fixed options',()=>{
 const {p}=fixture(),table={rows:[{cells:[{textContent:'x'}]}]};p.cellStyles={'note.md':{old:{'0,0':{bg:'blue'}}}};p.tableOptions={'note.md':{old:{freezeFirst:true}}};
 a.equal(typeof p.adoptStableTableId,'function');p.adoptStableTableId(table,'note.md','old','unew');
 a.deepEqual(plain(p.cellStyles['note.md'].unew),{'0,0':{bg:'blue'}});a.deepEqual(plain(p.tableOptions['note.md'].unew),{freezeFirst:true});
});
test('native history snapshots include both new stores',()=>{
 const {p}=fixture();a.equal(typeof p.historySnapshot,'function');p._historyApi={invertedEffects:{}};p._historyInverse=()=>{};
 const editor={cm:{state:{facet:()=>[p._historyInverse]}}};p.activeEditor=()=>editor;p.cellStyles={'note.md':{t:{'0,0':{marked:true}}}};
 const snap=p.historySnapshot();a.deepEqual(plain(snap.data.cellStyles),p.cellStyles['note.md']);a.deepEqual(plain(snap.data.tableOptions),{});
});
test('frozen-boundary merge cancels before source rewrite',()=>{
 const {p,notices}=fixture();p.tableOptions={'note.md':{t:{freezeFirst:true}}};p._sel={path:'note.md',tid:'t',r1:1,r2:1,c1:0,c2:1};
 a.equal(typeof p.mergeSelectedCells,'function');p.mergeSelectedCells();a.ok(notices.some(t=>/固定/.test(t)));
});
test('new options default empty and do not change old table settings',()=>{
 const {p}=fixture();a.equal(typeof p.optionsFor,'function');a.deepEqual(plain(p.optionsFor('note.md','t')),{});a.deepEqual(p.tableOptions,{});
});
test('native dimension changes move styles without changing options',()=>{
 const {p}=fixture();p.tableDims={'note.md':{t:{rows:2,cols:2}}};p.cellStyles={'note.md':{t:{'1,1':{bg:'blue'}}}};p.tableOptions={'note.md':{t:{freezeFirst:true}}};
 p.dimensionChangeIndex=()=>1;a.equal(typeof p.reconcileTableDimensions,'function');
 p.reconcileTableDimensions({rows:[{}, {}, {}]},'note.md','t',2);
 a.deepEqual(plain(p.cellStyles['note.md'].t),{'2,1':{bg:'blue'}});a.equal(p.tableOptions['note.md'].t.freezeFirst,true);
});
module.exports={fixture};
test('merging styles changes only the actual table ID',()=>{
 const {p}=fixture();p.cellStyles={'note.md':{a:{'0,0':{bg:'blue'},'0,1':{bg:'pink'}},b:{'0,1':{bg:'yellow'}}}};
 a.equal(p.setMerge('note.md','a',{r:0,c:0,rowspan:1,colspan:2}),true);
 a.deepEqual(plain(p.cellStyles['note.md'].a),{'0,0':{bg:'blue'}});a.deepEqual(plain(p.cellStyles['note.md'].b),{'0,1':{bg:'yellow'}});
});
test('first option on legacy table uses final UID during batched source insertion',()=>{
 const {p}=fixture(),table={dataset:{},isConnected:true,closest:()=>({})},editor={};
 p.app={workspace:{}};p.activeEditor=()=>editor;p.tableId=()=> 'legacy';p.tableSourceInfo=()=>({uid:null,header:'| a | b |',from:0,toPos:i=>i});
 p.replaceTableRange=()=>{};p.currentWidths=()=>['100px','200px'];p.targetSelection=()=>({table,path:'note.md',tid:'legacy',r1:0,c1:0,r2:0,c2:0});p.effectiveMerges=()=>[];p.runTableHistory=run=>run();p.reflowTable=()=>{};p.refreshMergeToolbar=()=>{};
 p.toggleFreeze('freezeFirst');const keys=Object.keys(p.tableOptions['note.md']);a.equal(keys.length,1);a.match(keys[0],/^um/);a.equal(p.tableOptions['note.md'][keys[0]].freezeFirst,true);
});
