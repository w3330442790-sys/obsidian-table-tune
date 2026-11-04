// Read-only compatibility audit. No note content is read, no installed file is written.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const file=process.argv[2];if(!file)throw Error('Pass an existing TableTune data.json path');
const raw=fs.readFileSync(file),original=JSON.parse(raw),hash=x=>crypto.createHash('sha256').update(x).digest('hex');let saved;
const api={Plugin:class{async loadData(){return JSON.parse(JSON.stringify(original))}async saveData(v){saved=v}registerEvent(){}registerMarkdownPostProcessor(){}registerEditorExtension(){}addCommand(){}},MarkdownView:class{},Notice:class{},setIcon(){}};
const modules={'obsidian':api,'@codemirror/state':{StateEffect:{define:()=>({})}},'@codemirror/commands':{invertedEffects:{of:x=>x}},'@codemirror/view':{EditorView:{updateListener:{of:x=>x}}}};
const moduleFixture={exports:{}},window={addEventListener(){},removeEventListener(){}},document={body:{},addEventListener(){},removeEventListener(){},querySelectorAll:()=>[]};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../main.js'),'utf8'),{module:moduleFixture,require:id=>{if(!modules[id])throw Error(id);return modules[id]},window,document,MutationObserver:class{observe(){}disconnect(){}},console,setTimeout,clearTimeout,Promise});
(async()=>{const p=new moduleFixture.exports();p.app={workspace:{on:()=>({}),onLayoutReady(){},getActiveFile:()=>null}};await p.onload();await p.persist();
 for(const key of ['widths','rowHeights','merges','tableDims','alignments'])a.deepEqual(JSON.parse(JSON.stringify(saved[key])),original[key]||{});
 for(const key of Object.keys(original))a.deepEqual(JSON.parse(JSON.stringify(saved[key])),original[key]);
 a.equal(hash(fs.readFileSync(file)),hash(raw));
 console.log(JSON.stringify({readOnly:true,originalDataUnchanged:true,allExistingFieldsPreserved:true,widthNoteCount:Object.keys(original.widths||{}).length,mergeNoteCount:Object.keys(original.merges||{}).length},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
