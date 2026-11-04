const {test}=require('node:test');
const a=require('node:assert/strict');
let core={};try{core=require('../src/core.cjs')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('fit uses container width and never shrinks below 64px',()=>{
 a.deepEqual(core.fitWidths([100,200],300),[100,200]);
 a.deepEqual(core.fitWidths([10,10,10],100),[64,64,64]);
 const widths=core.fitWidths([64,1000,100],600);a.equal(widths.reduce((a,b)=>a+b),600);a.ok(widths.every(w=>w>=64));
});
test('equalize selected columns only preserves total',()=>a.deepEqual(core.equalWidths([80,160,200],[0,1]),[120,120,200]));
test('content width distributes merged content and caps wide cells',()=>{
 a.deepEqual(core.contentWidths([[{text:'x',colspan:2,width:300},null]],2),[150,150]);
 a.deepEqual(core.contentWidths([[{text:'x',width:4000}]],1),[480]);
});
test('delete merge anchor transfers style to surviving anchor',()=>{
 const map={'0,0':{bg:'yellow',marked:true},'2,1':{bg:'blue'}};
 a.deepEqual(core.remapStyles(map,'row',i=>i===0?null:i-1,[{r:0,c:0,rowspan:2,colspan:1}]),{'0,0':map['0,0'],'1,1':map['2,1']});
});
test('merge keeps top-left style and split inherits it',()=>{
 const m={r:0,c:0,rowspan:1,colspan:2};
 const merged=core.mergeStyles({'0,0':{bg:'green'},'0,1':{bg:'pink'}},m);
 a.deepEqual(merged,{'0,0':{bg:'green'}});
 a.deepEqual(core.splitStyles(merged,m),{'0,0':{bg:'green'},'0,1':{bg:'green'}});
});
test('freeze rejects only merged regions crossing the frozen boundary',()=>{
 a.equal(core.freezeConflict([{r:0,c:0,rowspan:2,colspan:1}],{freezeHeader:true}),true);
 a.equal(core.freezeConflict([{r:1,c:1,rowspan:2,colspan:2}],{freezeHeader:true,freezeFirst:true}),false);
});
test('HTML export preserves merges sizes colors and safely escapes text',()=>{
 const out=core.exportTable({rows:[['<script>x</script>',''],['a\nb','"quoted"']],merges:[{r:0,c:0,rowspan:1,colspan:2}],widths:[100,200],styles:{'0,0':{bg:'yellow',marked:true}},alignments:{'0,0':{horizontal:'center',vertical:'middle'}}});
 a.match(out.html,/colspan="2"/);a.equal((out.html.match(/<td\b/g)||[]).length,3);a.match(out.html,/width:100px/);
 a.match(out.html,/background-color:/);a.match(out.html,/text-align:center/);a.doesNotMatch(out.html,/<script>/);a.match(out.html,/&lt;script&gt;/);a.match(out.html,/a<br>b/);
 a.match(out.plain,/"a\nb"/);a.match(out.plain,/""quoted""/);
});
test('TSV clears covered merge values and preserves tabs and quotes',()=>{
 const out=core.exportTable({rows:[['a\tb','stale'],['x','y']],merges:[{r:0,c:0,rowspan:1,colspan:2}]});
 a.equal(out.plain,'"a\tb"\t\nx\ty');
});
test('export uses only safe finite sizes and known style values',()=>{
 const out=core.exportTable({rows:[['x']],widths:['1px;position:fixed'],styles:{'0,0':{bg:'red;bad'}},alignments:{'0,0':'left;bad'}});
 a.doesNotMatch(out.html,/position:fixed|red;bad|left;bad|NaN/);
});
test('export filename cannot escape export folder',()=>{
 a.equal(core.safeFilename('../a:b\\c?'),'a-b-c-');
 a.ok(!core.safeFilename('..').includes('..'));
});
