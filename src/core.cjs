'use strict';
const PALETTE={yellow:'#fff1b8',green:'#d8f1d8',blue:'#dcecff',pink:'#f9dce9',purple:'#eaddfa'};
const MIN=64;
const validWidth=x=>{const v=typeof x==='number'?x:/^\d+(?:\.\d+)?(?:px)?$/.test(String(x))?parseFloat(x):0;return Number.isFinite(v)&&v>0?Math.min(v,100000):0;};
function fitWidths(widths,available){
 if(!widths.length)return [];
 const budget=Math.max(widths.length*MIN,Math.floor(Number(available)||0));
 const out=Array(widths.length).fill(0),remaining=new Set(widths.map((_,i)=>i));let left=budget;
 while(remaining.size){
  const total=[...remaining].reduce((s,i)=>s+(validWidth(widths[i])||MIN),0);
  const small=[...remaining].filter(i=>left*(validWidth(widths[i])||MIN)/total<MIN);
  if(small.length){for(const i of small){out[i]=MIN;left-=MIN;remaining.delete(i);}continue;}
  let assigned=0;const indexes=[...remaining];
  indexes.forEach((i,j)=>{out[i]=j===indexes.length-1?left-assigned:Math.floor(left*(validWidth(widths[i])||MIN)/total);assigned+=out[i];});break;
 }
 return out;
}
function equalWidths(widths,indices=widths.map((_,i)=>i)){
 const out=widths.map(w=>Math.max(MIN,validWidth(w)||MIN));
 indices=[...new Set(indices)].filter(i=>Number.isInteger(i)&&i>=0&&i<out.length);if(!indices.length)return out;
 const sum=indices.reduce((s,i)=>s+out[i],0),value=Math.floor(sum/indices.length);let rest=sum-value*indices.length;
 for(const i of indices)out[i]=value+(rest-->0?1:0);return out;
}
function contentWidths(rows,n){
 const out=Array(n).fill(MIN);
 for(const row of rows)row.forEach((cell,c)=>{if(!cell)return;const span=Math.max(1,Math.min(n-c,cell.colspan||1));
  const measured=validWidth(cell.width)||Math.max(...String(cell.text||'').split('\n').map(t=>[...t].reduce((s,ch)=>s+(ch.charCodeAt(0)>255?16:8),0)))+24;
  for(let i=c;i<c+span;i++)out[i]=Math.max(out[i],Math.min(480,Math.ceil(measured/span)));
 });return out;
}
const contains=(m,r,c)=>r>=m.r&&r<m.r+m.rowspan&&c>=m.c&&c<m.c+m.colspan;
function remapStyles(map,axis,transform,merges=[]){
 const source={...map},out={};
 for(const m of merges){const start=axis==='row'?m.r:m.c,span=axis==='row'?m.rowspan:m.colspan;
  if(transform(start)!==null)continue;
  const survivor=Array.from({length:span},(_,i)=>start+i).find(i=>transform(i)!==null);
  if(survivor!==undefined&&source[m.r+','+m.c])source[(axis==='row'?survivor:m.r)+','+(axis==='col'?survivor:m.c)]=source[m.r+','+m.c];
 }
 for(const [key,value] of Object.entries(source)){const [r,c]=key.split(',').map(Number),next=transform(axis==='row'?r:c);if(next!==null)out[(axis==='row'?next:r)+','+(axis==='col'?next:c)]={...value};}
 return out;
}
function mergeStyles(map,m){const out={...map};for(const key of Object.keys(out)){const [r,c]=key.split(',').map(Number);if(contains(m,r,c)&&(r!==m.r||c!==m.c))delete out[key];}return out;}
function splitStyles(map,m){const out={...map},style=map[m.r+','+m.c];if(style)for(let r=m.r;r<m.r+m.rowspan;r++)for(let c=m.c;c<m.c+m.colspan;c++)out[r+','+c]={...style};return out;}
function freezeConflict(merges,opts){return merges.some(m=>(opts.freezeHeader&&m.r===0&&m.rowspan>1)||(opts.freezeFirst&&m.c===0&&m.colspan>1));}
const escapeHtml=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function exportTable({rows,merges=[],widths=[],heights=[],styles={},alignments={},wrap=true}){
 const htmlRows=[],plainRows=[];
 rows.forEach((row,r)=>{
  const html=[],plain=[];
  row.forEach((text,c)=>{
   const m=merges.find(m=>contains(m,r,c));
   if(m&&(m.r!==r||m.c!==c)){plain.push('');return;}
   text=String(text??'');plain.push(/[\t\r\n"]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text);
   const style=styles[r+','+c]||{},alignment=alignments[r+','+c],horizontal=typeof alignment==='string'?alignment:alignment?.horizontal;
   const css=['border:1px solid #888','padding:6px 10px','vertical-align:top',wrap?'white-space:pre-wrap;overflow-wrap:anywhere':'white-space:pre'];
   if(PALETTE[style.bg])css.push('background-color:'+PALETTE[style.bg]);
   if(style.marked)css.push('border-left:4px solid #7755bb','font-weight:600');
   if(['left','center','right'].includes(horizontal))css.push('text-align:'+horizontal);
   if(['top','middle','bottom'].includes(alignment?.vertical))css.push('vertical-align:'+alignment.vertical);
   html.push('<td'+(m?' rowspan="'+m.rowspan+'" colspan="'+m.colspan+'"':'')+' style="'+css.join(';')+'">'+escapeHtml(text).replace(/\r?\n/g,'<br>')+'</td>');
  });
  const h=validWidth(heights[r]);htmlRows.push('<tr'+(h?' style="height:'+h+'px"':'')+'>'+html.join('')+'</tr>');plainRows.push(plain.join('\t'));
 });
 const cols=widths.map(w=>'<col'+(validWidth(w)?' style="width:'+validWidth(w)+'px"':'')+'>').join('');
 return {html:'<table style="border-collapse:collapse;table-layout:fixed">'+(cols?'<colgroup>'+cols+'</colgroup>':'')+'<tbody>'+htmlRows.join('')+'</tbody></table>',plain:plainRows.join('\n')};
}
function safeFilename(value){return String(value||'表格').replace(/^[.\s/\\]+/,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/[.\s]+$/,'').slice(0,80)||'表格';}
module.exports={PALETTE,MIN,fitWidths,equalWidths,contentWidths,remapStyles,mergeStyles,splitStyles,freezeConflict,exportTable,safeFilename,escapeHtml};
