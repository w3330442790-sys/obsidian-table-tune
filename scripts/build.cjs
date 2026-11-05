const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),names=['base','core','icons','plugin'];
const modules=names.map(n=>JSON.stringify('./'+n+'.cjs')+':function(module,exports,require){\n'+fs.readFileSync(path.join(root,'src',n+'.cjs'),'utf8')+'\n}').join(',\n');
const bundle='// Personal Android edition of TableTune. Upstream MIT copyright retained in LICENSE.\n'+
 '(function(hostRequire){const modules={'+modules+'};const cache={};function load(id){if(!modules[id])return hostRequire(id);if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,load);return m.exports;}module.exports=load("./plugin.cjs");})(require);\n';
new vm.Script(bundle);fs.writeFileSync(path.join(root,'main.js'),bundle);
const out=path.join(root,'dist','table-tune');fs.mkdirSync(out,{recursive:true});
for(const file of ['main.js','manifest.json','styles.css','LICENSE','README.md','ACCEPTANCE.md'])if(fs.existsSync(path.join(root,file)))fs.copyFileSync(path.join(root,file),path.join(out,file));
console.log('Built dist/table-tune; user data.json is never packaged.');
