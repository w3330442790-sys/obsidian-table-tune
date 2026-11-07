'use strict';
const Base=require('./base.cjs');
const {Notice,Menu,MarkdownView}=require('obsidian');
const {renderIcon}=require('./icons.cjs');
const core=require('./core.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const TOOL_ICONS={
 '选择区域':'scan','完成选择':'check','选择行列':'table-properties','合并单元格':'combine','拆分单元格':'split',
 '左对齐':'align-left','居中对齐':'align-center','右对齐':'align-right','顶部对齐':'align-vertical-justify-start','垂直居中':'align-vertical-justify-center','底部对齐':'align-vertical-justify-end',
 '清空内容':'eraser','删除行':'rows-3','删除列':'columns-3','在上方插入行':'arrow-up-to-line','在下方插入行':'arrow-down-to-line','在左侧插入列':'arrow-left-to-line','在右侧插入列':'arrow-right-to-line',
 '固定':'pin','整理':'columns-3','样式':'palette','复制/导出':'copy','撤销':'undo-2','重做':'redo-2','更多':'ellipsis','自定义工具栏':'settings-2','关闭':'x','编辑表格':'pencil'
};

module.exports=class TabletTableTools extends Base{
 async onload(){
  this._savedData=(await this.loadData())||{};
  this.cellStyles=this._savedData.cellStyles||{};this.tableOptions=this._savedData.tableOptions||{};
  this._ttCleanups=new Map();this._ttLoaded=true;
  await super.onload();
  this.addCommand({id:'open-table-tools',name:'打开表格工具',callback:()=>{
   const cell=this.cellAtCursor();const table=cell?.closest?.('table');
   if(table)this.activateCell(table,cell);else if(this.targetSelection())this.refreshMergeToolbar();else new Notice('请先点击一个表格单元格');
  }});
  const viewport=()=>{this.positionMergeToolbar(this.targetSelection());this.updateScrollHeights();};
  document.addEventListener('scroll',viewport,true);
  window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);
  this._ttViewport=viewport;
  this._ttOutside=e=>{const sel=this.targetSelection();if(sel&&!sel.table.contains(e.target)&&!e.target.closest?.('.tcr-merge-toolbar,.menu,.tt-open,.tcr-axis-rail')){this._ttToolsOpen=false;this._activeCell=null;this._touchRange=null;this.hideMergeToolbar();}};
  document.addEventListener('pointerdown',this._ttOutside,true);
  this.registerEvent(this.app.workspace.on('active-leaf-change',()=>{this._activeCell=null;this._touchRange=null;this.hideMergeToolbar();}));
  this.app.workspace.onLayoutReady(()=>{if(this._ttLoaded){this.processActive();this.scanEdit();this.reflow();}});
 }
 persist(){
  const data={...this._savedData,widths:this.widths,rowHeights:this.rowHeights,merges:this.merges,tableDims:this.tableDims,alignments:this.alignments||{},cellStyles:this.cellStyles||{},tableOptions:this.tableOptions||{}};
  // Retain fields written by newer/other editions. Never replace the note content here.
  this._savedData=data;const snapshot=clone(data);this._saveQueue=(this._saveQueue||Promise.resolve()).catch(()=>{}).then(()=>this.saveData(snapshot)).catch(e=>{console.error('Table tools save failed',e);new Notice('表格设置保存失败，请检查存储空间');});return this._saveQueue;
 }
 optionsFor(path,tid){return this.tableOptions?.[path]?.[tid]||{};}
 targetSelection(){
  const target=this._sel||this._activeCell;
  if(!target||target.table.isConnected===false||target.path!==this.currentPath())return null;
  return {...target,tid:this.tableId(target.table)};
 }
 rememberToolbarAnchor(table,cell,event){
  const rect=cell.getBoundingClientRect();
  this._toolbarAnchor={table,cell,x:Number.isFinite(event?.clientX)?event.clientX-rect.left:rect.width/2,y:Number.isFinite(event?.clientY)?event.clientY-rect.top:0};
 }
 isCellEdge(event,cell){
  const r=cell.getBoundingClientRect(),x=event.clientX-r.left,y=event.clientY-r.top;
  return Math.min(x,r.width-x,y,r.height-y)<=10;
 }
 activateCell(table,cell){
  if(this._sel&&this._sel.table!==table)this.clearMergeSelection();
  const path=table.dataset.tcrPath||this.currentPath(),tid=this.tableId(table),r=this.cellRow(cell),c=this.cellCol(cell);
  if(this._toolbarAnchor?.table!==table||this._toolbarAnchor.cell!==cell)this.rememberToolbarAnchor(table,cell);
  const merge=this.effectiveMerges(table,path,tid).find(m=>this.regionContains(m,r,c));
  this._ttToolsOpen=true;this._activeCell={table,path,tid,r1:merge?.r??r,r2:merge?merge.r+merge.rowspan-1:r,c1:merge?.c??c,c2:merge?merge.c+merge.colspan-1:c};this.refreshMergeToolbar();
 }
 startCellDrag(e,table,cell,path,tid){
  this.rememberToolbarAnchor(table,cell,e);
  if(this._touchRange?.table===table){
   // A selection gesture uses two taps, never a scrolling drag.
   e.preventDefault();e.stopImmediatePropagation();
   this._tapCleanup?.();const x=e.clientX,y=e.clientY,id=e.pointerId;
   const clear=()=>{window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',clear,true);if(this._tapCleanup===clear)this._tapCleanup=null;};
   const up=ev=>{if(ev.pointerId!==id)return;clear();if(Math.hypot(ev.clientX-x,ev.clientY-y)>12)return;
    const r=this.cellRow(cell),c=this.cellCol(cell),mode=this._touchRange,anchor=mode?.anchor;
    if(!mode||mode.table!==table)return;
    if(mode.axis)this.selectTableAxis(table,{dataset:{tcrAxis:mode.axis,tcrIndex:String(mode.axis==='row'?r:c)},closest:()=>null},{shiftKey:!!anchor});
    else this.selectRect(table,anchor?anchor.r:r,anchor?anchor.c:c,r,c,path,this.tableId(table));
    if(anchor)this._touchRange=null;else this._touchRange={table,axis:mode.axis,anchor:{r,c}};
    this.refreshMergeToolbar();
   };
   window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',clear,true);this._tapCleanup=clear;return;
  }
  if(!e.shiftKey&&this.isCellEdge(e,cell)){
   e.preventDefault();e.stopImmediatePropagation();this.rememberToolbarAnchor(table,cell,e);this._ttToolsOpen=true;
   this.selectRect(table,this.cellRow(cell),this.cellCol(cell),this.cellRow(cell),this.cellCol(cell),path,this.tableId(table));return;
  }
  if(e.pointerType==='touch'||e.pointerType==='pen'){
   this._ttToolsOpen=false;
   this.clearMergeSelection();this.resetNativeCellSelection(table);table.classList.add('tcr-cell-editing');
   const r=this.cellRow(cell),c=this.cellCol(cell);this._activeCell={table,path,tid,r1:r,r2:r,c1:c,c2:c};return;
  }
  this._ttToolsOpen=false;
  this._activeCell={table,path,tid,r1:this.cellRow(cell),r2:this.cellRow(cell),c1:this.cellCol(cell),c2:this.cellCol(cell)};
  super.startCellDrag(e,table,cell,path,tid);
  this.refreshMergeToolbar();
 }
 clearMergeSelection(preserveNative=false){super.clearMergeSelection(preserveNative);}
 startDrag(e,colgroup,i,path,tid){
  const cell=e.currentTarget?.closest('td,th'),table=cell?.closest('table');
  if(cell&&table){this.clearMergeSelection();this.rememberToolbarAnchor(table,cell,e);this.activateCell(table,cell);}
  return super.startDrag(e,colgroup,i,path,tid);
 }
 selectTableAxis(table,handle,event={},context=false){
  if(Number.isFinite(event.clientX)){
   const axis=handle.dataset.tcrAxis,index=Number(handle.dataset.tcrIndex||0),cell=handle.closest('td,th')||(axis==='row'?table.rows[index]?.cells[0]:table.rows[0]?.cells[index]);
   if(cell)this.rememberToolbarAnchor(table,cell,event);
  }
  this._ttToolsOpen=true;return super.selectTableAxis(table,handle,event,context);
 }
 enhance(table,ctx,allowDrag){super.enhance(table,ctx,allowDrag);if(table.dataset.tcr)this.applyExtras(table);}
 reflowTable(table){super.reflowTable(table);if(table.dataset.tcr)this.applyExtras(table);}
 applyCellAlignments(table,path,tid){super.applyCellAlignments(table,path,tid);this.paintStyles(table,path,tid);}
 paintStyles(table,path,tid){
  const styles=this.cellStyles?.[path]?.[tid]||{};
  Array.from(table.rows).forEach((row,r)=>Array.from(row.cells).forEach((cell,c)=>{
   const style=styles[r+','+c]||{};
   if(core.PALETTE[style.bg])cell.dataset.ttBg=style.bg;else delete cell.dataset.ttBg;
   if(style.marked)cell.dataset.ttMarked='true';else delete cell.dataset.ttMarked;
  }));
 }
 applyRowHeights(table,path,tid){
  const saved=this.getRowHeights(path,tid)||[];
  Array.from(table.rows).forEach((row,r)=>{if(parseFloat(saved[r])>0)row.dataset.ttRowHeight='true';else if(row.dataset.ttRowHeight){row.style.height='';delete row.dataset.ttRowHeight;}});
  super.applyRowHeights(table,path,tid);
 }
 applyExtras(table){
  if(!this._ttLoaded)return;
  const path=table.dataset.tcrPath,tid=this.tableId(table),opts=this.optionsFor(path,tid);
  this.paintStyles(table,path,tid);
  table.classList.toggle('tt-nowrap',opts.wrap===false);
  const merges=this.effectiveMerges(table,path,tid),header=!!opts.freezeHeader&&!core.freezeConflict(merges,{freezeHeader:true}),first=!!opts.freezeFirst&&!core.freezeConflict(merges,{freezeFirst:true});
  table.classList.toggle('tt-freeze-header',header);table.classList.toggle('tt-freeze-first',first);
  Array.from(table.rows).forEach((row,r)=>Array.from(row.cells).forEach((cell,c)=>{
   cell.classList.toggle('tt-fixed-header',header&&r===0);cell.classList.toggle('tt-fixed-first',first&&c===0);
  }));
  const host=table.parentElement;if(!host)return;
  const frozen=host.querySelector('table.tt-freeze-header');host.classList.toggle('tt-scroll',!!frozen||first);
  host.classList.toggle('tt-scroll-vertical',!!frozen);
  if(header)this.setScrollHeight(host);
  const edit=!!table.closest('.cm-content');
  if(edit)this.attachRowHandles(table);
  if(this._ttCleanups?.has(table))return;
  const open=document.createElement('button');open.type='button';open.className='tt-open';open.title='表格工具';open.setAttribute('aria-label','打开此表格工具');renderIcon(open,'table-2');
  open.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();});
  open.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();this.rememberToolbarAnchor(table,table.rows[0].cells[0],e);this._ttToolsOpen=true;this.selectWhole(table);});
  const activate=e=>{
   const cell=e.target.closest?.('td,th');
   if(cell?.closest('table')!==table)return;
   if(table.closest('.cm-content')){
    // The editor handles edges and drags on pointer events. A mouse click can
    // open the tools after the native caret has been placed.
    if(e.pointerType!=='mouse'||this._sel||this._textRange||e.target.closest('.tcr-handle,.tt-row-handle'))return;
   }else if(e.pointerType!=='mouse'&&!this.isCellEdge(e,cell)){
    this._ttToolsOpen=false;this.hideMergeToolbar();return;
   }
   this.rememberToolbarAnchor(table,cell,e);this.activateCell(table,cell);
  };
  table.addEventListener('click',activate);
  // Sibling controls never enter table.rows or the Markdown source.
  host.insertBefore(open,table);
  const scroll=()=>{if(this._sel?.table===table)this.positionSelectionOverlay();};host.addEventListener('scroll',scroll,{passive:true});
  let observer;
  if(typeof ResizeObserver!=='undefined'){let pending=0;observer=new ResizeObserver(()=>{
   if(pending)return;pending=requestAnimationFrame(()=>{pending=0;if(!table.isConnected)return;this.setScrollHeight(host);this.positionMergeToolbar(this.targetSelection());if(this._sel?.table===table)this.positionSelectionOverlay();});
  });observer.observe(host);}
  this._ttCleanups?.set(table,()=>{open.remove();table.removeEventListener('click',activate);host.removeEventListener('scroll',scroll);observer?.disconnect();host.classList.remove('tt-scroll','tt-scroll-vertical');host.style.removeProperty('--tt-scroll-height');});
 }
 scanEdit(){super.scanEdit();if(this._ttCleanups)for(const [table,cleanup]of this._ttCleanups)if(!table.isConnected){cleanup();this._ttCleanups.delete(table);}}
 setScrollHeight(host){
  const viewport=window.visualViewport,height=viewport?.height||window.innerHeight;
  const pane=host.closest('.workspace-leaf-content,.markdown-source-view,.markdown-preview-view'),paneHeight=pane?.getBoundingClientRect().height||height;
  const value=Math.round(Math.max(120,Math.min(height,paneHeight)*.6))+'px';
  if(host.style.getPropertyValue('--tt-scroll-height')!==value)host.style.setProperty('--tt-scroll-height',value);
 }
 updateScrollHeights(){document.querySelectorAll('.tt-scroll-vertical').forEach(h=>this.setScrollHeight(h));}
 attachRowHandles(table){
  Array.from(table.rows).forEach((row,r)=>{
   const cell=Array.from(row.cells).find(c=>!c.classList.contains('tcr-merged-hidden'));if(!cell||cell.querySelector('.tt-row-handle'))return;
   const handle=document.createElement('span');handle.className='tt-row-handle';handle.setAttribute('aria-label','拖动调整行高');
   handle.addEventListener('pointerdown',e=>this.startSafeRowDrag(e,table,cell,r));cell.appendChild(handle);
  });
 }
 startSafeRowDrag(e,table,cell,r){
  if(e.button!=null&&e.button!==0)return;e.preventDefault();e.stopImmediatePropagation();this._rowCleanup?.();
  this.clearMergeSelection();this.rememberToolbarAnchor(table,cell,e);this.activateCell(table,cell);
  const path=table.dataset.tcrPath,tid=this.tableId(table),before=clone(this.getRowHeights(path,tid)||[]),snapshot=this.historySnapshot();
  if(cell.dataset.tcrMerge)r=this.cellRow(cell)+cell.rowSpan-1;
  const tracks=table.classList.contains('tcr-grid-table')?getComputedStyle(table).gridTemplateRows.split(' ').map(parseFloat):[];
  const height=tracks[r]||parseFloat(before[r])||table.rows[r].getBoundingClientRect().height||32;
  let final=height;const y=e.clientY,id=e.pointerId,handle=e.currentTarget;try{handle.setPointerCapture(id)}catch(_){}
  const move=ev=>{if(ev.pointerId!==id)return;ev.preventDefault();final=Math.max(24,Math.round(height+ev.clientY-y));const next=before.slice();next[r]=final+'px';this.setRowHeights(path,tid,next);this.applyRowHeights(table,path,tid);this.applyMerges(table,path,tid);};
  const cleanup=()=>{window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',cancel,true);handle.removeEventListener('lostpointercapture',cancel);try{handle.releasePointerCapture(id)}catch(_){}this._rowCleanup=null;};
  const cancel=()=>{cleanup();this.setRowHeights(path,tid,before);this.reflowTable(table);};
  const up=ev=>{if(ev.pointerId!==id)return;cleanup();this.setRowHeights(path,tid,before);this.runTableHistory(()=>{const next=before.slice();next[r]=final+'px';const finalTid=this.commitColumnWidths(table,path,this.currentWidths(table));if(!finalTid)return;this.setRowHeights(path,finalTid,next);this.persist();},snapshot);this.reflowTable(table);};
  this._rowCleanup=cancel;window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',cancel,true);handle.addEventListener('lostpointercapture',cancel);
 }
 currentWidths(table){return Array.from(table.querySelector('colgroup')?.children||[],c=>c.style.width||'80px');}
 selectWhole(table){
  if(!table.rows.length)return;const path=table.dataset.tcrPath,tid=this.tableId(table);
  if(table.closest('.cm-content'))this.selectRect(table,0,0,table.rows.length-1,table.rows[0].cells.length-1,path,tid);
  else{this._sel=null;this._activeCell={table,path,tid,r1:0,c1:0,r2:table.rows.length-1,c2:table.rows[0].cells.length-1};this.refreshMergeToolbar();}
 }
 withSelection(action){
  const sel=this.targetSelection();if(!sel)return;
  if(!sel.table.closest('.cm-content')){new Notice('请切换到实时预览后编辑表格');return;}
  const info=this.tableSourceInfo(this.activeEditor(),sel.table);if(!info){new Notice('无法定位表格源码，操作已取消，原表格未更改');return;}
  return this.runTableHistory(()=>{
   const finalTid=this.commitColumnWidths(sel.table,sel.path,this.currentWidths(sel.table));
   if(!finalTid){new Notice('无法安全保存表格设置，操作已取消');return;}sel.tid=finalTid;
   action(sel);this.persist();this.reflowTable(sel.table);this.refreshMergeToolbar();
  });
 }
 layoutAction(kind){return this.withSelection(sel=>{
  const {table,path,tid}=sel,widths=this.currentWidths(table).map(parseFloat),opts={...this.optionsFor(path,tid)};
  if(kind==='wrap'){opts.wrap=opts.wrap===false;this.tableOptions[path]||={};this.tableOptions[path][tid]=opts;return;}
  if(kind==='reset'){this.setWidths(path,tid,this.autoFitWidths(table,widths.length).map(w=>w+'px'));delete this.rowHeights[path]?.[tid];delete opts.wrap;this.tableOptions[path]||={};this.tableOptions[path][tid]=opts;return;}
  let next;
  if(kind==='fit')next=core.fitWidths(widths,table.parentElement.clientWidth-8);
  if(kind==='equal'){const indices=this._sel?Array.from({length:sel.c2-sel.c1+1},(_,i)=>sel.c1+i):undefined;next=core.equalWidths(widths,indices);}
  if(kind==='content'){
   const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
   const rows=Array.from(table.rows,row=>Array.from(row.cells,cell=>{
    if(cell.classList.contains('tcr-merged-hidden'))return null;
    const css=getComputedStyle(cell);if(context)context.font=css.font;
    const text=this.cleanCellText(cell),width=Math.max(...text.split('\n').map(t=>context?context.measureText(t).width:t.length*16))+24;
    return {text,width,colspan:cell.colSpan};
   }));next=core.contentWidths(rows,widths.length);
  }
  if(next)this.setWidths(path,tid,next.map(w=>w+'px'));
 });}
 toggleFreeze(key){return this.withSelection(sel=>{
  const opts={...this.optionsFor(sel.path,sel.tid)},next=!opts[key];
  if(next&&core.freezeConflict(this.effectiveMerges(sel.table,sel.path,sel.tid),{[key]:true})){new Notice('合并单元格跨过固定边界，请先拆分对应合并格');return;}
  this.tableOptions[sel.path]||={};this.tableOptions[sel.path][sel.tid]={...opts,[key]:next};
 });}
 setCellStyle(kind,value){return this.withSelection(sel=>{
  const map={...(this.cellStyles[sel.path]?.[sel.tid]||{})},keys=this.alignmentSelectionCells(sel);
  for(const key of keys){const [r,c]=key.split(',').map(Number),m=this.effectiveMerges(sel.table,sel.path,sel.tid).find(m=>this.regionContains(m,r,c)),owner=m?m.r+','+m.c:key;
   if(kind==='clear'){delete map[owner];continue;}
   const style={...(map[owner]||{})};if(kind==='bg'){if(core.PALETTE[value])style.bg=value;else delete style.bg;}else style.marked=!!value;
   if(!style.bg&&!style.marked)delete map[owner];else map[owner]=style;
  }
  this.cellStyles[sel.path]||={};this.cellStyles[sel.path][sel.tid]=map;
 });}
 mergeSelectedCells(){
  const sel=this._sel;if(!sel)return;
  const reg={r:sel.r1,c:sel.c1,rowspan:sel.r2-sel.r1+1,colspan:sel.c2-sel.c1+1};
  if(core.freezeConflict([reg],this.optionsFor(sel.path,sel.tid))){new Notice('合并区域跨过固定边界，请先关闭对应固定选项');return;}
  super.mergeSelectedCells();
 }
 setMerge(path,tid,reg){
  const changed=super.setMerge(path,tid,reg);
  if(changed&&this.cellStyles[path]?.[tid])this.cellStyles[path][tid]=core.mergeStyles(this.cellStyles[path][tid],reg);
  return changed;
 }
 splitRegion(path,tid,reg){
  const map=this.cellStyles[path]?.[tid];if(map)this.cellStyles[path][tid]=core.splitStyles(map,reg);
  super.splitRegion(path,tid,reg);this.reflow();
 }
 reconcileTableDimensions(table,path,tid,cols){
  const previous=this.tableDims?.[path]?.[tid];let map=this.cellStyles?.[path]?.[tid];
  if(previous&&map){for(const [axis,next,old]of [['row',table.rows.length,previous.rows],['col',cols,previous.cols]])if(next!==old){const at=this.dimensionChangeIndex(path,tid,axis,old,next),delta=next-old;map=core.remapStyles(map,axis,i=>delta>0?(i>=at?i+delta:i):(i>=at&&i<at-delta?null:i>=at-delta?i+delta:i),this.getMerges(path,tid));}this.cellStyles[path][tid]=map;}
  return super.reconcileTableDimensions(table,path,tid,cols);
 }
 insertTableAxis(table,axis,at){
  const path=table.dataset.tcrPath||this.currentPath(),oldTid=this.tableId(table),map=this.cellStyles[path]?.[oldTid],opts=this.tableOptions[path]?.[oldTid];
  const tid=super.insertTableAxis(table,axis,at);if(!tid)return;
  if(map){this.cellStyles[path]||={};this.cellStyles[path][tid]=core.remapStyles(map,axis,i=>i>=at?i+1:i);}
  if(opts){this.tableOptions[path]||={};this.tableOptions[path][tid]=clone(opts);}this.persist();
 }
 deleteSelectionAxis(axis){
  const sel=this._sel;if(!sel)return;
  const map=this.cellStyles[sel.path]?.[sel.tid],regions=this.getMerges(sel.path,sel.tid).map(m=>({...m}));
  const indices=sel.axis&&sel.indices?[...sel.indices]:Array.from({length:(axis==='row'?sel.r2-sel.r1:sel.c2-sel.c1)+1},(_,i)=>(axis==='row'?sel.r1:sel.c1)+i);
  const before=JSON.stringify(this.tableDims[sel.path]);super.deleteSelectionAxis(axis);
  if(map&&this.tableDims[sel.path]?.[sel.tid]&&JSON.stringify(this.tableDims[sel.path])!==before){this.cellStyles[sel.path]||={};this.cellStyles[sel.path][sel.tid]=core.remapStyles(map,axis,i=>indices.includes(i)?null:i-indices.filter(j=>j<i).length,regions);this.persist();}
 }
 cleanCellText(cell){
  const content=cell.querySelector('.table-cell-wrapper .cm-content')||cell.querySelector('.table-cell-content')||cell;
  const copy=content.cloneNode(true);copy.querySelectorAll('.tcr-handle,.tcr-row-handle,.tt-row-handle,script,style').forEach(e=>e.remove());
  const lines=copy.matches('.cm-content')?Array.from(copy.children).filter(e=>e.classList.contains('cm-line')):[];
  if(lines.length)return this.stripTableIdentity(lines.map(line=>{line.querySelectorAll('br').forEach(e=>e.replaceWith(''));return line.textContent||'';}).join('\n'));
  copy.querySelectorAll('br').forEach(e=>e.replaceWith('\n'));return this.stripTableIdentity(copy.textContent||'');
 }
 exportSelection(){
  const sel=this.targetSelection();if(!sel)return null;
  const rows=sel.axis==='row'?[...sel.indices].sort((a,b)=>a-b):Array.from({length:sel.r2-sel.r1+1},(_,i)=>sel.r1+i);
  const cols=sel.axis==='column'?[...sel.indices].sort((a,b)=>a-b):Array.from({length:sel.c2-sel.c1+1},(_,i)=>sel.c1+i);
  const regions=this.effectiveMerges(sel.table,sel.path,sel.tid).filter(m=>Array.from({length:m.rowspan},(_,i)=>m.r+i).every(r=>rows.includes(r))&&Array.from({length:m.colspan},(_,i)=>m.c+i).every(c=>cols.includes(c))).map(m=>({...m,r:rows.indexOf(m.r),c:cols.indexOf(m.c)}));
  const styles={},alignments={};rows.forEach((r,rr)=>cols.forEach((c,cc)=>{styles[rr+','+cc]=this.cellStyles[sel.path]?.[sel.tid]?.[r+','+c];alignments[rr+','+cc]=this.alignments[sel.path]?.[sel.tid]?.[r+','+c];}));
  const widths=this.currentWidths(sel.table),heights=this.getRowHeights(sel.path,sel.tid)||[];
  return core.exportTable({rows:rows.map(r=>cols.map(c=>this.cleanCellText(sel.table.rows[r].cells[c]))),merges:regions,widths:cols.map(c=>widths[c]),heights:rows.map(r=>heights[r]),styles,alignments,wrap:this.optionsFor(sel.path,sel.tid).wrap!==false});
 }
 handleTableCopy(e){
  // Keep native text selection copy untouched; an explicit cell range owns table copy.
  if(!this._sel)return super.handleTableCopy(e);
  const out=this.exportSelection();if(!out)return false;
  const result=super.handleTableCopy(e);if(result){e.clipboardData.setData('text/html',out.html);e.clipboardData.setData('text/plain',out.plain);}return result;
 }
 async copyTable(plain=false){
  const out=this.exportSelection();if(!out)return;
  try{
   if(plain){await navigator.clipboard.writeText(out.plain);new Notice('已复制纯文本表格，可粘贴到 Excel');}
   else{
    if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw new Error('Rich clipboard unavailable');
    await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([out.html],{type:'text/html'}),'text/plain':new Blob([out.plain],{type:'text/plain'})})]);new Notice('已复制表格，请在 Excel 中粘贴');
   }
  }catch(e){new Notice(plain?'复制失败，请使用 HTML 导出':'系统未允许表格格式复制，请选“复制纯文本”或“导出 HTML”');}
 }
 async exportHtml(){
  const out=this.exportSelection(),sel=this.targetSelection();if(!out||!sel)return;
  try{
   const folder='表格导出',vault=this.app.vault;
   if(!await vault.adapter.exists(folder)){try{await vault.createFolder(folder)}catch(e){if(!await vault.adapter.exists(folder))throw e;}}
   const base=folder+'/'+core.safeFilename(sel.path.split('/').pop().replace(/\.md$/i,''))+'-表格';
   let index=0,file;
   const html='<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>表格导出</title></head><body>'+out.html+'</body></html>';
   while(true){file=base+(index?'-'+index:'')+'.html';if(await vault.adapter.exists(file)){index++;continue;}try{await vault.create(file,html);break}catch(e){if(await vault.adapter.exists(file)){index++;continue;}throw e;}}
   new Notice('已导出：'+file);
  }catch(e){console.error(e);new Notice('HTML 导出失败，原表格未改动');}
 }
 menu(button,items){
  const menu=new Menu();for(const [title,run,checked]of items)menu.addItem(item=>{item.setTitle(title);if(checked!==undefined)item.setChecked(checked);item.onClick(()=>{run();this.refreshMergeToolbar();});});
  const rect=button.getBoundingClientRect();menu.showAtPosition({x:rect.left,y:rect.top});
 }
 ensureToolbarSelection(){
  const sel=this.targetSelection();if(!sel)return null;
  if(!this._sel)this.selectRect(sel.table,sel.r1,sel.c1,sel.r2,sel.c2,sel.path,sel.tid);
  return this._sel;
 }
 customizeToolbar(button){
  const hidden=new Set(Array.isArray(this._savedData.toolbarHidden)?this._savedData.toolbarHidden:[]);
  this.menu(button,[...this._toolbarActions.map(action=>['显示：'+action.label,()=>{
   if(hidden.has(action.id))hidden.delete(action.id);else hidden.add(action.id);
   this._savedData.toolbarHidden=[...hidden];this.persist();
  },!hidden.has(action.id)]),['恢复默认图标',()=>{this._savedData.toolbarHidden=[];this.persist();}]]);
 }
 refreshMergeToolbar(){
  if(!this._ttLoaded)return super.refreshMergeToolbar();
  const sel=this.targetSelection();if(!sel||(!this._sel&&!this._ttToolsOpen)||this._drag?.active){this.hideMergeToolbar();return;}
  this.showMergeToolbar(true);const bar=this._toolbar;bar.replaceChildren();bar.classList.add('tt-toolbar');
  const edit=!!sel.table.closest('.cm-content'),opts=this.optionsFor(sel.path,sel.tid);
  const hidden=new Set(Array.isArray(this._savedData.toolbarHidden)?this._savedData.toolbarHidden:[]);this._toolbarActions=[];
  const controls=document.createElement('div');controls.className='tt-toolbar-actions';bar.appendChild(controls);
  const add=(label,action,pressed,options={})=>{
   const id=options.id||label;if(!options.fixed)this._toolbarActions.push({id,label,action,disabled:!!options.disabled});
   if(!options.fixed&&hidden.has(id))return;
   const b=document.createElement('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.dataset.icon=TOOL_ICONS[label]||'table-2';renderIcon(b,b.dataset.icon);b.disabled=!!options.disabled;
   if(pressed!==undefined)b.setAttribute('aria-pressed',String(pressed));b.addEventListener('click',e=>{e.stopPropagation();action(b);});(options.fixed?bar:controls).appendChild(b);return b;
  };
  if(!edit)add('编辑表格',async()=>{
   const view=this.app.workspace.getActiveViewOfType(MarkdownView);if(!view)return;
   try{await view.leaf.setViewState({type:'markdown',state:{...view.getState(),mode:'source',source:false}});new Notice('已切换到实时预览，轻点表格即可显示全部编辑功能');}
   catch(e){console.error('Table tools view switch failed',e);new Notice('请切换到实时预览后轻点表格');}
  });
  if(edit){
   add(this._touchRange?'完成选择':'选择区域',()=>{if(this._touchRange)this._touchRange=null;else this._touchRange={table:sel.table,anchor:null};this.refreshMergeToolbar();},!!this._touchRange,{id:'选择区域'});
   add('选择行列',b=>{
    const axis=(kind,range)=>{this.ensureToolbarSelection();if(range)this._touchRange={table:sel.table,axis:kind,anchor:null};else this.selectTableAxis(sel.table,{dataset:{tcrAxis:kind,tcrIndex:String(kind==='row'?sel.r1:sel.c1)},closest:()=>null});this.refreshMergeToolbar();};
    this.menu(b,[['选择当前行',()=>axis('row',false)],['选择当前列',()=>axis('column',false)],['点选多行',()=>axis('row',true)],['点选多列',()=>axis('column',true)],['选择整张表',()=>this.selectWhole(sel.table)]]);
   });
   const original=run=>()=>{const selection=this.ensureToolbarSelection();if(!selection)return;run(selection);this.refreshMergeToolbar();};
   const region=this.isMergeRegion(sel);
   add('合并单元格',original(()=>this.mergeSelectedCells()),undefined,{disabled:!!sel.axis||this.selectionCells(sel).size<2||region||!this.selectionIsRectangle(sel)});
   add('拆分单元格',original(()=>this.splitSelectedCell()),undefined,{disabled:!!sel.axis||!region});
   for(const [value,label,axis]of [['left','左对齐','horizontal'],['center','居中对齐','horizontal'],['right','右对齐','horizontal'],['top','顶部对齐','vertical'],['middle','垂直居中','vertical'],['bottom','底部对齐','vertical']])
    add(label,original(()=>this.setSelectionAlignment(value,axis)),this._sel?this.selectionAlignment(axis)===value:undefined);
   for(const [label,axis,after]of [['在上方插入行','row',false],['在下方插入行','row',true],['在左侧插入列','col',false],['在右侧插入列','col',true]])
    add(label,original(s=>this.insertTableAxis(s.table,axis,axis==='row'?(after?s.r2+1:s.r1):(after?s.c2+1:s.c1))),undefined,{disabled:!!sel.axis&&(sel.axis==='row')!==(axis==='row')});
   for(const [label,run]of [['清空内容',()=>this.clearSelectedCellContents()],['删除行',()=>this.deleteSelectedRows()],['删除列',()=>this.deleteSelectedColumns()]])
    add(label,b=>this.menu(b,[['确认'+label,original(run)],['取消',()=>{}]]),undefined,{disabled:(sel.axis==='row'&&label==='删除列')||(sel.axis==='column'&&label==='删除行')});
   add('固定',b=>this.menu(b,[['固定表头',()=>this.toggleFreeze('freezeHeader'),!!opts.freezeHeader],['固定首列',()=>this.toggleFreeze('freezeFirst'),!!opts.freezeFirst]]));
   add('整理',b=>this.menu(b,[['适应屏幕',()=>this.layoutAction('fit')],['按内容调整',()=>this.layoutAction('content')],['平均列宽',()=>this.layoutAction('equal')],['自动换行',()=>this.layoutAction('wrap'),opts.wrap!==false],['重置布局',()=>this.layoutAction('reset')]]));
   add('样式',b=>{const marked=!!this.cellStyles[sel.path]?.[sel.tid]?.[sel.r1+','+sel.c1]?.marked;this.menu(b,[...Object.entries({yellow:'浅黄',green:'浅绿',blue:'浅蓝',pink:'浅粉',purple:'浅紫'}).map(([key,label])=>[label+'底色',()=>this.setCellStyle('bg',key)]),['默认底色',()=>this.setCellStyle('bg',null)],['重点标记',()=>this.setCellStyle('marked',!marked),marked],['清除样式',()=>this.setCellStyle('clear')]]);});
  }
  add('复制/导出',b=>this.menu(b,[['复制到 Excel',()=>this.copyTable()],['复制纯文本',()=>this.copyTable(true)],['导出 HTML',()=>this.exportHtml()],['选择整张表',()=>this.selectWhole(sel.table)]]));
  if(edit){
   add('撤销',()=>this._historyApi?.undo(this.activeEditor()?.cm));add('重做',()=>this._historyApi?.redo(this.activeEditor()?.cm));
  }
  add('更多',b=>this.menu(b,this._toolbarActions.filter(v=>!v.disabled).map(v=>[v.label,()=>v.action(b)])),undefined,{fixed:true});
  add('自定义工具栏',b=>this.customizeToolbar(b),undefined,{fixed:true});
  add('关闭',()=>{this._touchRange=null;this._activeCell=null;this._ttToolsOpen=false;this._toolbarAnchor=null;this.clearMergeSelection();},undefined,{fixed:true});this.positionMergeToolbar(sel);
 }
 showMergeToolbar(show){
  const exists=!!this._toolbar;super.showMergeToolbar(show);
  if(!exists){
   // Prevent focus stealing, but let a finger scroll a long toolbar.
   const fresh=this._toolbar.cloneNode(false);this._toolbar.replaceWith(fresh);this._toolbar=fresh;
   this._toolbar.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')e.preventDefault();e.stopPropagation();});
   this._toolbar.addEventListener('mousedown',e=>e.preventDefault());
  }
 }
 positionMergeToolbar(sel){
  if(!sel||!this._toolbar||this._toolbar.style.display==='none')return;
  const vp=window.visualViewport,offsetX=vp?.offsetLeft||0,offsetY=vp?.offsetTop||0,w=vp?.width||window.innerWidth,h=vp?.height||window.innerHeight;
  const pane=sel.table.closest('.workspace-leaf-content,.markdown-source-view,.markdown-preview-view'),rect=pane?.getBoundingClientRect()||{left:offsetX,right:offsetX+w,top:offsetY,bottom:offsetY+h};
  const left=Math.max(offsetX+4,rect.left+4),right=Math.min(offsetX+w-4,rect.right-4);
  const top=Math.max(offsetY+4,rect.top+4);let bottom=Math.min(offsetY+h-4,rect.bottom-4);
  document.querySelectorAll('.mobile-navbar,.mobile-toolbar').forEach(control=>{
   const css=getComputedStyle(control),r=control.getBoundingClientRect();
   if(css.display!=='none'&&css.visibility!=='hidden'&&Number(css.opacity)!==0&&r.width>0&&r.height>0&&r.right>left&&r.left<right&&r.bottom>offsetY&&r.top<offsetY+h)
    bottom=Math.min(bottom,r.top-4);
  });
  const anchor=this._toolbarAnchor?.table===sel.table&&this._toolbarAnchor.cell.isConnected?this._toolbarAnchor:null;
  const cell=anchor?.cell||sel.table.rows[sel.r1]?.cells[sel.c1];if(!cell)return;
  const r=cell.getBoundingClientRect(),x=r.left+Math.max(0,Math.min(r.width,anchor?.x??r.width/2)),y=r.top+Math.max(0,Math.min(r.height,anchor?.y??0));
  if(right<=left||bottom<=top||y<top-12||y>bottom+12||r.right<left||r.left>right){this._toolbar.style.visibility='hidden';return;}
  this._toolbar.style.maxWidth=Math.min(600,Math.max(0,right-left))+'px';
  const width=this._toolbar.offsetWidth,height=this._toolbar.offsetHeight;
  this._toolbar.style.left=Math.max(left,Math.min(x-width/2,right-width))+'px';
  const above=y-height-8,below=y+8;
  this._toolbar.style.top=Math.max(top,Math.min(above>=top?above:below,bottom-height))+'px';this._toolbar.style.visibility='';
 }
 onunload(){
  this._ttLoaded=false;this._tapCleanup?.();this._rowCleanup?.();
  window.visualViewport?.removeEventListener('resize',this._ttViewport);window.visualViewport?.removeEventListener('scroll',this._ttViewport);
  document.removeEventListener('scroll',this._ttViewport,true);
  document.removeEventListener('pointerdown',this._ttOutside,true);
  for(const cleanup of this._ttCleanups?.values()||[])cleanup();this._ttCleanups?.clear();
  document.querySelectorAll('table[data-tcr]').forEach(table=>{table.classList.remove('tt-nowrap','tt-freeze-header','tt-freeze-first');table.querySelectorAll('.tt-row-handle').forEach(h=>h.remove());table.querySelectorAll('td,th').forEach(cell=>{cell.classList.remove('tt-fixed-header','tt-fixed-first');delete cell.dataset.ttBg;delete cell.dataset.ttMarked;});});
  window.removeEventListener('resize',this._onResize);if(this._editRaf)cancelAnimationFrame(this._editRaf);
  super.onunload();
 }
};
