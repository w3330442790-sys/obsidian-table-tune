// excel tool, a personal edition of TableTune. Upstream MIT copyright retained in LICENSE.
(function(hostRequire){const modules={"./base.cjs":function(module,exports,require){
const { Plugin, MarkdownView, Notice, setIcon } = require('obsidian');

module.exports = class TableColumnResize extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    // Data shape:
    //   { widths:     { [notePath]: { [tableId]: [px,...] } },
    //     rowHeights: { [notePath]: { [tableId]: [px|null,...] } },
    //     merges:     { [notePath]: { [tableId]: [{r,c,rowspan,colspan},...] } } }
    // Legacy shapes (per-note flat arrays, and the old widths-only map) are
    // migrated lazily on first enhance of each table.
    if (data && data.widths !== undefined) {
      this.widths = data.widths || {};
      this.rowHeights = data.rowHeights || {};
      this.merges = data.merges || {};
      this.tableDims = data.tableDims || {};
    } else {
      this.widths = data || {};
      this.rowHeights = {};
      this.merges = {};
      this.tableDims = {};
    }
    this._resizeRaf = 0;
    this.alignments = data.alignments || {};
    this._editRaf = 0;
    this.installTableHistory();

    // READING VIEW: post processor applies stored widths + a full-pane wrap
    // (scrollable), but NO drag handles (resizing is edit-mode only).
    this.registerMarkdownPostProcessor((el, ctx) => {
      el.querySelectorAll('table').forEach((table) => this.enhance(table, ctx, false));
    });

    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.processActive();
      this.scanEdit();
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      setTimeout(() => { this.processActive(); this.scanEdit(); this.reflow(); }, 80);
    }));

    // Both modes render tables as real <table> nodes we must keep in sync.
    // Observe the whole document: when the editor (Live Preview, .cm-content)
    // OR the reading view (.markdown-preview-view) appears or mutates — e.g. on
    // a mode toggle within the same note — re-enhance so widths are applied
    // immediately. (Toggling edit/reading does NOT fire file-open / leaf-change,
    // which is why this observer is required for the "switch and it refreshes"
    // behavior.)
    this._mo = new MutationObserver((records) => {
      if (this._editRaf || !this.tableMutationsNeedScan(records)) return;
      this._editRaf = requestAnimationFrame(() => {
        this._editRaf = 0;
        this.scanEdit();
        this.processActive();
      });
    });
    this._mo.observe(document.body, { childList: true, subtree: true });

    this.addCommand({
      id: 'merge-selected-cells',
      name: 'Merge selected cells',
      callback: () => this.mergeSelectedCells(),
    });
    this.addCommand({
      id: 'split-cell',
      name: 'Split merged cell',
      callback: () => this.splitSelectedCell(),
    });
    this.addCommand({
      id: 'delete-selected-rows',
      name: 'Delete selected table rows',
      callback: () => this.deleteSelectedRows(),
    });
    this.addCommand({
      id: 'delete-selected-columns',
      name: 'Delete selected table columns',
      callback: () => this.deleteSelectedColumns(),
    });
    this._docPointer = (e) => {
      if (
        this._sel &&
        !(e.target.closest && e.target.closest('.tcr-axis-rail')?._tcrTable === this._sel.table) &&
        !(e.target.closest && e.target.closest('.menu')) &&
        !(e.target.closest && e.target.closest('.tcr-merge-toolbar')) &&
        !(e.target.closest && e.target.closest('table') === this._sel.table)
      ) {
        this.clearMergeSelection();
      }
    };
    document.addEventListener('pointerdown', this._docPointer, true);
    this._onKey = (e) => { if (!this.handleSelectedCellKey(e) && !this.handleTableHistoryKey(e) && !this.handleCellEnter(e)) this.handleCellSelectAll(e); };
    document.addEventListener('keydown', this._onKey, true);
    this.installSelectedCellCommands();
    this.registerEvent(this.app.workspace.on('editor-menu', (menu) => this.populateEditorMenu(menu)));

    this._onResize = () => {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = 0;
        this.reflow();
      });
    };
    window.addEventListener('resize', this._onResize);
    this._toolbarViewport=()=>{if(this._sel)this.positionMergeToolbar(this._sel);};
    document.addEventListener('scroll',this._toolbarViewport,true);
    window.addEventListener('resize',this._toolbarViewport);
    this._toolbarKey=e=>{if(e.key==='Escape')this.hideMergeToolbar();};
    document.addEventListener('keydown',this._toolbarKey);
    this._tableCopy=e=>this.handleTableCopy(e);
    this._tablePaste=e=>this.handleTablePaste(e);
    document.addEventListener('copy',this._tableCopy,true);
    document.addEventListener('paste',this._tablePaste,true);
  }

  onunload() {
    if(this._cellDragCleanup)this._cellDragCleanup();
    this.uninstallSelectedCellCommands();
    if(this._historyOriginals)for(const [name,method] of this._historyOriginals)this[name]=method;
    if(this._columnDragCleanup)this._columnDragCleanup();
    if(this._tableCopy)document.removeEventListener('copy',this._tableCopy,true);
    if(this._tablePaste)document.removeEventListener('paste',this._tablePaste,true);
    if(this._toolbarViewport){document.removeEventListener('scroll',this._toolbarViewport,true);window.removeEventListener('resize',this._toolbarViewport);}
    if(this._toolbarKey)document.removeEventListener('keydown',this._toolbarKey);
    this.clearMergeSelection();
    if (this._axisRails) this._axisRails.forEach(rail => this.removeAxisRail(rail));
    if (this._selectionTables) this._selectionTables.forEach(t => {
      if (t._tcrSelectionCleanup) t._tcrSelectionCleanup();
      delete t._tcrAxisRails;
    });
    if (this._mo) this._mo.disconnect();
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    if (this._docPointer) document.removeEventListener('pointerdown', this._docPointer, true);
    if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
    if (this._toolbar) { this._toolbar.remove(); this._toolbar = null; }
    if (this._layoutStyles) {this._layoutStyles.forEach(style=>style.remove());this._layoutStyles.clear();}
    this._sel = null;
    document.querySelectorAll('table[data-tcr]').forEach((t) => {
      t.querySelectorAll('.tcr-sel').forEach((c) => c.classList.remove('tcr-sel'));
      // Older 1.1.6 builds drew the purple selection outline with child spans.
      // Remove any such nodes that survived a hot reload of the plugin.
      t.querySelectorAll('.tcr-sel-edge').forEach((edge) => edge.remove());
      t.querySelectorAll('.tcr-handle, .tcr-row-handle').forEach((h) => h.remove());
      this.resetMerges(t);
      t.querySelectorAll('[data-tcr-align]').forEach(c=>{delete c.dataset.tcrAlign;c.style.textAlign='';});
      t.querySelectorAll('[data-tcr-valign]').forEach(c=>{delete c.dataset.tcrValign;c.style.verticalAlign='';});
      const wrapper = t.parentElement;
      if (wrapper && wrapper.classList.contains('tcr-wrap')) {
        const view = wrapper.closest('.markdown-preview-view');
        wrapper.parentNode.insertBefore(t, wrapper);
        wrapper.remove();
        // Remove the tcr-has-wrap marker from ancestors up to the view, but
        // only where no tcr-wrap remains in that subtree.
        const chain = [];
        let anc = t.parentElement;
        while (anc && anc !== view) { chain.push(anc); anc = anc.parentElement; }
        if (view) chain.push(view);
        chain.forEach((el) => {
          if (el && el.classList.contains('tcr-has-wrap') && !el.querySelector('.tcr-wrap')) {
            el.classList.remove('tcr-has-wrap');
          }
        });
      }
      delete t.dataset.tcr;
      delete t.dataset.tcrLayout;
      t.classList.remove('tcr-cell-editing');
    });
  }

  processActive() {
    const file = this.app.workspace.getActiveFile();
    const path = file ? file.path : 'unknown';
    document
      .querySelectorAll('.markdown-preview-view table')
      .forEach((table) => this.enhance(table, { sourcePath: path }, false));
  }

  tableMutationsNeedScan(records) {
    // Cursor blinks, toolbar icons and our own selection/resize controls must
    // not cause a full pass over every table in the workspace. Keep observing
    // actual cell edits and table mounts/removals, including hidden panes.
    const controls='.tcr-handle,.tcr-row-handle,.tcr-axis-rail,.tcr-selection-rect,.tcr-merge-toolbar,.tcr-sel-edge,.cm-cursorLayer,.cm-selectionLayer';
    return records.some(record=>{
      const target=record.target.nodeType===1?record.target:record.target.parentElement;
      if(target?.closest(controls))return false;
      const nodes=[...record.addedNodes,...record.removedNodes].filter(node=>
        !(node.nodeType===1 && node.matches(controls)));
      if(!nodes.length)return false;
      if(target?.closest('table'))return true;
      return nodes.some(node=>node.nodeType===1 && (node.matches('table') || node.querySelector('table')));
    });
  }

  scanEdit() {
    if (this._layoutStyles) for (const [table,style] of this._layoutStyles) if (!table.isConnected) {
      style.remove();this._layoutStyles.delete(table);
    }
    if (this._sel && !this._sel.table.isConnected) this.clearMergeSelection();
    if (this._selectionTables) for (const table of this._selectionTables) {
      if (table.isConnected) continue;
      if (table._tcrSelectionCleanup) table._tcrSelectionCleanup();
      this._selectionTables.delete(table);
    }
    if (this._axisRails) this._axisRails = this._axisRails.filter(rail => {
      if (rail._tcrTable.isConnected) return true;
      this.removeAxisRail(rail); return false;
    });
    const file = this.app.workspace.getActiveFile();
    const path = file ? file.path : 'unknown';
    document
      .querySelectorAll('.cm-content table')
      .forEach((table) => this.enhance(table, { sourcePath: path }, true));
  }

  // ---- per-table identity ------------------------------------------------
  // Tables are keyed by a stable id derived from their header row, so a note
  // with several tables remembers each table's widths/heights independently
  // (the old per-note single array made tables overwrite each other).
  // Base identity from the header row (stable across edit/reading renders).
  baseTableId(table) {
    const cells = table.querySelectorAll('thead th, thead td');
    let key = '';
    for (const c of cells) {
      // A live header may contain both the hidden rendered text and its editor.
      const content = c.querySelector?.('.table-cell-wrapper .cm-content') || c.querySelector?.('.table-cell-content') || c;
      key += (content.textContent || '').trim() + '\u0001';
    }
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    return 't' + (h >>> 0).toString(36);
  }

  // Stable per-table id within a note. Tables with identical headers get
  // "t<base>", "t<base>#2", ... in document order so they stay independent
  // instead of sharing (and fighting over) one width entry.
  tableId(table) {
    const uid = this.tableUid(table);
    if (uid) return 'u' + uid;
    const base = this.baseTableId(table);
    const container =
      table.closest('.markdown-preview-section, .cm-content, .markdown-rendered') ||
      table.parentElement;
    const all = container ? Array.from(container.querySelectorAll('table')) : [table];
    const idx = all.indexOf(table);
    let n = 0;
    for (let i = 0; i <= idx && i < all.length; i++) {
      if (this.baseTableId(all[i]) === base) n++;
    }
    return n > 1 ? base + '#' + n : base;
  }

  tableUid(table) {
    if (!table) return null;
    const oldMarker = table.querySelector && table.querySelector('[data-table-tune-id]');
    let uid = oldMarker && oldMarker.getAttribute('data-table-tune-id');
    if (!uid && table.querySelector) {
      const firstHeader = table.querySelector('thead th, thead td');
      uid = firstHeader && this.decodeInvisibleUid(firstHeader.textContent || '');
    }
    if (!uid) {
      const editor = this.app && this.app.workspace ? this.activeEditor() : null;
      const info = editor && this.tableSourceInfo(editor, table);
      uid = info && (info.uid || this.uidFromGrid(info.grid));
    }
    if (table.dataset) {
      if (uid) table.dataset.tableTuneUid = uid;
      else delete table.dataset.tableTuneUid;
    }
    return uid || null;
  }

  tablePeers(table) {
    const root = table.closest?.('.cm-content, .markdown-preview-view');
    return Array.from((root || document).querySelectorAll(root ? 'table' : '.cm-content table, .markdown-preview-view table'));
  }

  uidFromGrid(grid) {
    const text = grid && grid[0] ? grid[0].join(' ') : '';
    const invisible = this.decodeInvisibleUid(text);
    if (invisible) return invisible;
    const comment = text.match(/%%table-tune-id:([a-z0-9_-]+)%%/i);
    if (comment) return comment[1];
    const oldSpan = text.match(/<span\s+data-table-tune-id=["']([^"']+)["']\s*><\/span>/i);
    return oldSpan ? oldSpan[1] : null;
  }

  encodeInvisibleUid(uid) {
    const start = '\u2063\u200d\u2063', end = '\u2063\u200c\u2063';
    let bits = '';
    for (const ch of uid) bits += ch.charCodeAt(0).toString(2).padStart(8, '0');
    return start + bits.replace(/0/g, '\u200b').replace(/1/g, '\u200c') + end;
  }

  decodeInvisibleUid(text) {
    const start = '\u2063\u200d\u2063', end = '\u2063\u200c\u2063';
    const a = (text || '').indexOf(start);
    if (a < 0) return null;
    const b = text.indexOf(end, a + start.length);
    if (b < 0) return null;
    const raw = text.slice(a + start.length, b);
    if (!raw || /[^\u200b\u200c]/.test(raw) || raw.length % 8) return null;
    let out = '';
    for (let i = 0; i < raw.length; i += 8) {
      const bits = raw.slice(i, i + 8).replace(/\u200b/g, '0').replace(/\u200c/g, '1');
      out += String.fromCharCode(parseInt(bits, 2));
    }
    return out;
  }

  stripInvisibleUid(text) {
    const start = '\u2063\u200d\u2063', end = '\u2063\u200c\u2063';
    let value = text || '';
    let a = value.indexOf(start);
    while (a >= 0) {
      const b = value.indexOf(end, a + start.length);
      if (b < 0) break;
      value = value.slice(0, a) + value.slice(b + end.length);
      a = value.indexOf(start);
    }
    return value;
  }

  stripTableIdentity(text) {
    return this.stripInvisibleUid(text || '')
      .replace(/<span\s+data-table-tune-id=["'][^"']+["']\s*><\/span>/ig, '')
      .replace(/%%table-tune-id:[a-z0-9_-]+%%/ig, '');
  }

  // Ensure a note's store is a { tableId: [...] } map (not a legacy flat array).
  normalizeStore(store) {
    if (Array.isArray(store)) return { __legacy: store };
    return store;
  }

  // Read saved widths for one table. Adopts the legacy per-note array when it
  // is the first table in the note whose column count matches.
  getWidths(path, tid, n) {
    if (!this.widths[path]) return undefined;
    this.widths[path] = this.normalizeStore(this.widths[path]);
    const store = this.widths[path];
    if (store[tid]) return store[tid];
    if (store.__legacy && store.__legacy.length === n) {
      const arr = store.__legacy;
      delete store.__legacy;
      store[tid] = arr;
      return arr;
    }
    return undefined;
  }

  setWidths(path, tid, arr) {
    if (!this.widths[path]) this.widths[path] = {};
    this.widths[path][tid] = arr;
  }

  // Read saved row heights for one table (adopts legacy per-note array on the
  // first table of the note that asks for it).
  getRowHeights(path, tid) {
    if (!this.rowHeights[path]) return undefined;
    this.rowHeights[path] = this.normalizeStore(this.rowHeights[path]);
    const store = this.rowHeights[path];
    if (store[tid]) return store[tid];
    if (store.__legacy) {
      const arr = store.__legacy;
      delete store.__legacy;
      store[tid] = arr;
      return arr;
    }
    return undefined;
  }

  setRowHeights(path, tid, arr) {
    if (!this.rowHeights[path]) this.rowHeights[path] = {};
    this.rowHeights[path][tid] = arr;
  }


  toPx(raw, tablePx) {
    if (!raw) return null;
    if (raw.endsWith('px')) return parseFloat(raw);
    if (raw.endsWith('%')) return (parseFloat(raw) / 100) * tablePx;
    return null;
  }

  // Table width = sum of its column widths (so resizing one column grows the
  // table instead of stealing space from neighbours).
  syncTableWidth(table, colgroup) {
    let sum = 0;
    let ok = true;
    for (const c of colgroup.children) {
      const w = parseFloat(c.style.width);
      if (isNaN(w)) { ok = false; break; }
      sum += w;
    }
    if (ok && sum > 0) table.style.width = Math.round(sum) + 'px';
    if (table.classList.contains('tcr-grid-table')) {
      table.style.gridTemplateColumns = Array.from(colgroup.children,
        (col) => col.style.width || '80px').join(' ');
      table._tcrGridCols=table.style.gridTemplateColumns;
      this.updateLayoutStyle(table);
    }
    if (table._tcrAxisRails) this.positionAxisRails(table);
    if (this._sel?.table === table) this.positionSelectionOverlay();
  }

  // Always left-align the table at the wrapper's left edge (requirement:
  // the table must sit at the leftmost in reading mode). No centering, even
  // when the table is narrower than the wrapper.
  alignTableLeft(table) {
    table.style.marginLeft = '0';
    table.style.marginRight = '0';
  }

  // Persist column widths, row heights and cell merges together as one object.
  persist() {
    this.saveData({
      widths: this.widths,
      rowHeights: this.rowHeights,
      merges: this.merges,
      tableDims: this.tableDims,
      alignments: this.alignments || {},
    });
  }

  // Attach layout metadata to the SAME native history event as its cell/source
  // edits. No document snapshots, parallel undo stack or text-history guessing.
  installTableHistory() {
    try {
      const {StateEffect}=require('@codemirror/state');
      const commands=require('@codemirror/commands');
      const {EditorView}=require('@codemirror/view');
      const effect=StateEffect.define();
      this._historyApi={...commands,effect};
      this._historyInverse=tr=>tr.effects.filter(e=>e.is(effect)).map(e=>effect.of({path:e.value.path,entries:e.value.entries.map(v=>({...v,before:v.after,after:v.before}))}));
      this.registerEditorExtension([
        commands.invertedEffects.of(this._historyInverse),
        EditorView.updateListener.of(update=>{
          const anchors=this._widthAnchors?.get(update.view);
          if(anchors)for(const tr of update.transactions)if(tr.docChanged){
            for(const entry of anchors){
              let removed=false;
              tr.changes.iterChangedRanges((a,b)=>{if(a<=entry.from && b>=entry.to && b>a)removed=true;});
              entry.from=tr.changes.mapPos(entry.from,-1);
              entry.to=tr.changes.mapPos(entry.to,1);
              if(removed)entry.invalid=true;
            }
          }
          for(const tr of update.transactions)for(const e of tr.effects)if(e.is(effect)){
            this.applyTableHistory(e.value);
            if(tr.isUserEvent('undo') || tr.isUserEvent('redo'))this.clearMergeSelection();
            requestAnimationFrame(()=>{
              document.querySelectorAll('table[data-tcr]').forEach(t=>{if(t.dataset.tcrPath===e.value.path && t.isConnected)this.reflowTable(t)});
            });
          }
        }),
      ]);
      this._historyOriginals=new Map();
      for(const name of ['mergeSelectedCells','splitRegion','insertTableAxis','deleteSelectionAxis','setSelectionAlignment','handleTablePaste','clearSelectedCellContents']){
        const original=this[name];this._historyOriginals.set(name,original);
        this[name]=(...args)=>this.runTableHistory(()=>original.apply(this,args));
      }
    }catch(error){
      this._historyApi=null;
      console.warn('TableTune: native history integration unavailable',error);
      new Notice('TableTune: 原生撤销组件不可用，请更新 Obsidian 后重载插件');
    }
  }

  historySnapshot(editor=null,path=null) {
    const api=this._historyApi;
    if(!api)return null;
    editor=editor || this.activeEditor();path=path || this.currentPath();
    const cm=editor?.cm;
    if(!api || !cm?.state?.facet || !cm.state.facet(api.invertedEffects).includes(this._historyInverse))return null;
    const data={};
    for(const name of ['widths','rowHeights','merges','tableDims','alignments','cellStyles','tableOptions'])data[name]=JSON.parse(JSON.stringify(this.normalizeStore(this[name]?.[path] || {})));
    return {editor,path,data};
  }

  applyTableHistory(patch) {
    for(const entry of patch.entries){
      const store=this[entry.store] || (this[entry.store]={});
      store[patch.path]=this.normalizeStore(store[patch.path] || {});
      if(entry.after===null)delete store[patch.path][entry.key];
      else store[patch.path][entry.key]=JSON.parse(JSON.stringify(entry.after));
    }
    this.persist();
  }

  runTableHistory(action,before=null) {
    if(this._historyBatch)return action();
    const snapshot=before || this.historySnapshot();
    if(!snapshot || snapshot.editor!==this.activeEditor() || snapshot.path!==this.currentPath())return action();
    const batch={...snapshot,changes:[]};this._historyBatch=batch;
    let result;
    try { result=action(); }
    catch(error){
      for(const [name,data] of Object.entries(snapshot.data))this[name][snapshot.path]=data;
      throw error;
    }finally{this._historyBatch=null;}
    const entries=[];
    for(const [store,previous] of Object.entries(snapshot.data)){
      const next=this.normalizeStore(this[store]?.[snapshot.path] || {});
      for(const key of new Set([...Object.keys(previous),...Object.keys(next)])){
        const a=previous[key]??null,b=next[key]??null;
        if(JSON.stringify(a)!==JSON.stringify(b))entries.push({store,key,before:a,after:b===null?null:JSON.parse(JSON.stringify(b))});
      }
    }
    if(!entries.length && !batch.changes.length)return result;
    const api=this._historyApi;
    try {
      batch.editor.cm.dispatch({changes:batch.changes.sort((a,b)=>a.from-b.from),effects:api.effect.of({path:snapshot.path,entries}),annotations:api.isolateHistory.of('full'),userEvent:'input.table-tune'});
    }catch(error){
      this.applyTableHistory({path:snapshot.path,entries:entries.map(v=>({...v,after:v.before}))});
      this.clearMergeSelection();
      new Notice('TableTune: 操作未能安全写入，已取消');
      console.error('TableTune transaction failed',error);
    }
    return result;
  }

  replaceTableRange(editor,text,from,to) {
    const batch=this._historyBatch;
    if(!batch || batch.editor!==editor)return editor.replaceRange(text,from,to);
    const offset=pos=>typeof pos==='number'?pos:editor.cm.state.doc.line(pos.line+1).from+pos.ch;
    batch.changes.push({from:offset(from),to:offset(to),insert:text});
  }

  dispatchTableChanges(editor,changes,toPos=null) {
    if(this._historyBatch?.editor===editor){this._historyBatch.changes.push(...changes);return;}
    if(editor.cm?.dispatch && editor.cm.state?.doc)editor.cm.dispatch({changes,userEvent:'input'});
    else for(const c of changes.slice().reverse())editor.replaceRange(c.insert,toPos?toPos(c.from):this.tableOffsetPosition(editor,c.from),toPos?toPos(c.to):this.tableOffsetPosition(editor,c.to));
  }

  tableOffsetPosition(editor,offset) {
    if(editor.offsetToPos)return editor.offsetToPos(offset);
    const line=editor.cm.state.doc.lineAt(offset);return {line:line.number-1,ch:offset-line.from};
  }

  handleTableHistoryKey(e) {
    if(!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing || !['z','y'].includes(e.key?.toLowerCase()))return false;
    if(e.target.closest?.('input,textarea,.modal'))return false;
    const editor=this.activeEditor(),cm=editor?.cm,session=editor?.editorComponent?.tableCell;
    if(!this._historyApi || !cm || !(cm.dom?.contains(e.target) || session?.cm?.contentDOM?.contains(e.target) || (this._sel?.path===this.currentPath() && e.target.closest?.('.tcr-merge-toolbar'))))return false;
    const redo=e.key.toLowerCase()==='y' || e.shiftKey;
    if(!(redo?this._historyApi.redo:this._historyApi.undo)(cm))return false;
    e.preventDefault();e.stopImmediatePropagation();return true;
  }

  // Apply stored row heights (Reading mirrors Edit; re-renders keep them).
  applyRowHeights(table, path, tid) {
    const rows = table.querySelectorAll('tr');
    const rowSaved = this.getRowHeights(path, tid);
    if (!rowSaved) return;
    rows.forEach((tr, i) => {
      const h = rowSaved[i];
      if (h && parseFloat(h) > 0) tr.style.height = h;
    });
    if (table.classList.contains('tcr-grid-table')) this.updateMergeGridRows(table, path, tid);
  }

  reconcileTableDimensions(table, path, tid, cols) {
    if (!this.tableDims[path]) this.tableDims[path] = {};
    const rows = table.rows.length;
    const previous = this.tableDims[path][tid];
    if (!previous) {
      this.tableDims[path][tid] = { rows, cols };
      this.persist();
      return;
    }
    if (previous.rows === rows && previous.cols === cols) return;

    let merges = (this.merges[path] && this.merges[path][tid]) || [];
    let alignments=this.alignments?.[path]?.[tid];
    if (previous.rows !== rows) {
      const at = this.dimensionChangeIndex(path, tid, 'row', previous.rows, rows);
      merges = this.adjustMergesForDimension(merges, 'row', previous.rows, rows, at);
      const delta=rows-previous.rows;
      if(alignments)alignments=this.remapAlignments(alignments,'row',i=>delta>0?(i>=at?i+delta:i):(i>=at&&i<at-delta?null:i>=at-delta?i+delta:i));
      const heights = (this.getRowHeights(path, tid) || []).slice();
      while (heights.length < previous.rows) heights.push(null);
      if (rows > previous.rows) heights.splice(at, 0, ...new Array(rows - previous.rows).fill(null));
      else heights.splice(at, previous.rows - rows);
      this.setRowHeights(path, tid, heights.slice(0, rows));
    }
    if (previous.cols !== cols) {
      const at = this.dimensionChangeIndex(path, tid, 'col', previous.cols, cols);
      merges = this.adjustMergesForDimension(merges, 'col', previous.cols, cols, at);
      const delta=cols-previous.cols;
      if(alignments)alignments=this.remapAlignments(alignments,'col',i=>delta>0?(i>=at?i+delta:i):(i>=at&&i<at-delta?null:i>=at-delta?i+delta:i));
    }
    if (!this.merges[path]) this.merges[path] = {};
    this.merges[path][tid] = merges;
    if(alignments)this.alignments[path][tid]=alignments;
    this.tableDims[path][tid] = { rows, cols };
    this.persist();
  }

  adjustMergesForDimension(regions, axis, oldCount, newCount, at) {
    const key = axis === 'row' ? 'r' : 'c';
    const spanKey = axis === 'row' ? 'rowspan' : 'colspan';
    const otherSpan = axis === 'row' ? 'colspan' : 'rowspan';
    const delta = newCount - oldCount;
    if (delta > 0) {
      return regions.map((original) => {
        const reg = { ...original };
        if (at <= reg[key]) reg[key] += delta;
        else if (at < reg[key] + reg[spanKey]) {
          // Only insertion strictly inside a merge belongs to that merge.
          // At either outer boundary, leave the new axis independent.
          reg[spanKey] += delta;
        }
        if (axis === 'row') delete reg.height;
        return reg;
      });
    }
    const removeCount = -delta;
    const end = at + removeCount;
    const result = [];
    for (const original of regions) {
      const reg = { ...original };
      const surviving = [];
      for (let i = reg[key]; i < reg[key] + reg[spanKey]; i++) if (i < at || i >= end) surviving.push(i);
      if (!surviving.length) continue;
      reg[key] = surviving[0] >= end ? surviving[0] - removeCount : surviving[0];
      reg[spanKey] = surviving.length;
      if (axis === 'row') delete reg.height;
      if (reg[spanKey] > 1 || reg[otherSpan] > 1) result.push(reg);
    }
    return result;
  }

  // Ensure a colgroup with one <col> per header column exists.
  ensureColgroup(table, n) {
    let colgroup = table.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.prepend(colgroup);
    }
    while (colgroup.children.length < n) colgroup.appendChild(document.createElement('col'));
    while (colgroup.children.length > n) colgroup.lastElementChild.remove();
    return colgroup;
  }

  dimensionChangeIndex(path, tid, axis, oldCount, newCount) {
    // Native append buttons must not inherit a stale selection/cursor position.
    // Our explicit boundary insertion writes dimensions/metadata atomically.
    if (newCount > oldCount) return oldCount;
    const sel = this._sel;
    if (sel && sel.path === path && sel.tid === tid) {
      const edge = axis === 'row' ? sel.r2 : sel.c2;
      const start = axis === 'row' ? sel.r1 : sel.c1;
      return newCount > oldCount
        ? Math.max(0, Math.min(oldCount, edge + 1))
        : Math.max(0, Math.min(newCount, start));
    }
    const recent = this._lastTableCell;
    if (recent && recent.path === path && recent.tid === tid && Date.now() - recent.time < 15000) {
      const point = axis === 'row' ? recent.r : recent.c;
      return newCount > oldCount
        ? Math.max(0, Math.min(oldCount, point + 1))
        : Math.max(0, Math.min(newCount, point));
    }
    return Math.min(oldCount, newCount);
  }

  adaptSavedWidths(saved, fit, n, path, tid) {
    const out = saved.slice();
    if (out.length < n) {
      const add = n - out.length;
      const at = this.dimensionChangeIndex(path, tid, 'col', out.length, n);
      out.splice(at, 0, ...fit.slice(at, at + add).map((v) => v + 'px'));
    } else if (out.length > n) {
      const remove = out.length - n;
      const at = this.dimensionChangeIndex(path, tid, 'col', out.length, n);
      out.splice(at, remove);
    }
    while (out.length < n) out.push(fit[out.length] + 'px');
    if (out.length > n) out.length = n;
    for (let i = 0; i < n; i++) if (!(parseFloat(out[i]) > 0)) out[i] = fit[i] + 'px';
    return out;
  }

  // Apply saved (or freshly computed default) column widths to a table.
  applyWidths(table, colgroup, path, tid, preview) {
    // Native editor mutations can trigger a reflow between pointer moves.
    // Keep the live drag authoritative until the release has been committed.
    if (table._tcrColumnDrag) {
      table._tcrColumnDrag.forEach((width, i) => {
        if (colgroup.children[i]) colgroup.children[i].style.width = width;
      });
      this.syncTableWidth(table, colgroup);
      return colgroup.children.length;
    }
    const headCols = table.querySelectorAll('thead th, thead td');
    const n = headCols.length;
    // Header text is not an identity: before a table has a source UID, typing
    // changes its legacy hash. Keep width tracks tied to its source range (and
    // map that range through native edits), including replacement widget DOM.
    let anchor=null;
    try {
      const editor=this.activeEditor();
      const info=editor && this.currentPath()===path && this.tableSourceInfo(editor,table);
      if(info && editor.cm){
        if(!this._widthAnchors)this._widthAnchors=new WeakMap();
        let entries=this._widthAnchors.get(editor.cm);
        if(!entries){entries=[];this._widthAnchors.set(editor.cm,entries);}
        anchor=entries.find(e=>!e.invalid && e.path===path && e.from===info.from);
        if(!anchor){anchor={path,from:info.from,to:info.to};entries.push(anchor);}
        anchor.to=info.to;
      }
    }catch(_) { /* Reading mode or a temporarily unavailable source mapping. */ }
    const fixed=anchor?.widths || table._tcrFixedWidths;
    const previousTid=anchor?.tid || table._tcrFixedTid;
    const stored=this.getWidths(path,tid,n);
    const saved = (!tid.startsWith('u') && previousTid && previousTid!==tid && fixed?.length===n)
      ? fixed : stored || (fixed?.length===n ? fixed : null);
    let shouldPersist = false;
    let effective = saved;
    if (saved && saved.length !== n) {
      effective = this.adaptSavedWidths(saved, this.autoFitWidths(table, n), n, path, tid);
      this.setWidths(path, tid, effective);
      shouldPersist = true;
    }
    if (effective && effective.length === n) {
      const tablePx = table.getBoundingClientRect().width || 1;
      for (let i = 0; i < n; i++) {
        const px = this.toPx(effective[i], tablePx);
        colgroup.children[i].style.width = (px && px > 0 ? Math.round(px) : 80) + 'px';
      }
    } else {
      // No stored widths yet: fit each column to its content (capped) so wide,
      // text-heavy tables are readable without manual dragging. This also
      // avoids the old equal-split default persisting tiny "40px" values when
      // the table had not laid out yet (a table hidden/loading reports width 0,
      // which used to produce min-width defaults that clobbered real ones).
      // Freeze the displayed initial tracks, not their text's natural width.
      // Hidden/loading tables have no geometry and use the normal fallback.
      const measured=Array.from(headCols,c=>c.getBoundingClientRect().width);
      const fit = measured.every(w=>w>=40) && !table.classList.contains('tcr-grid-table')
        ? measured.map(Math.round) : this.autoFitWidths(table, n);
      for (let i = 0; i < n; i++) colgroup.children[i].style.width = fit[i] + 'px';
      shouldPersist = true;
    }
    this.syncTableWidth(table, colgroup);
    table._tcrFixedWidths=Array.from(colgroup.children,c=>c.style.width);
    table._tcrFixedTid=tid;
    if(anchor){anchor.widths=table._tcrFixedWidths.slice();anchor.tid=tid;}
    if(saved && saved!==stored){this.setWidths(path,tid,table._tcrFixedWidths.slice());shouldPersist=true;}
    // Persist the freshly computed default so the other mode mirrors it
    // exactly (Reading column widths == Edit column widths). Only this
    // table's entry is touched; other tables in the note keep their own.
    if (shouldPersist) {
      const arr = [];
      for (const c of colgroup.children) arr.push(c.style.width || '');
      this.setWidths(path, tid, arr);
      this.persist();
    }
    return n;
  }

  // Content-aware default column widths: each column is sized to fit its
  // longest line of text (per cell, including <br>-separated lines), capped so
  // one huge paragraph cannot blow the table up to a silly width. Used only
  // when a table has no saved widths.
  autoFitWidths(table, n) {
    const MIN = 80;
    const CAP = 460;
    const ctxCache = new Map();
    const ctxFor = (font) => {
      if (!ctxCache.has(font)) {
        const c = document.createElement('canvas');
        c.width = 4096;
        c.height = 64;
        ctxCache.set(font, c.getContext('2d'));
      }
      return ctxCache.get(font);
    };
    const cellLines = (cell) => {
      const clone = cell.cloneNode(true);
      clone.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
      return (clone.textContent || '').split('\n');
    };
    const cellNatural = (cell) => {
      const cs = getComputedStyle(cell);
      const font = cs.font || (cs.fontSize + ' ' + cs.fontFamily);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 2;
      const ctx = ctxFor(font);
      ctx.font = font;
      let w = 0;
      for (const ln of cellLines(cell)) w = Math.max(w, ctx.measureText(ln).width);
      return w + pad;
    };
    const colIndex = (cell) => {
      const row = cell.parentElement;
      if (!row) return -1;
      const kids = row.children;
      for (let i = 0; i < kids.length; i++) if (kids[i] === cell) return i;
      return -1;
    };
    const widths = new Array(n).fill(0);
    for (const cell of table.querySelectorAll('th, td')) {
      const ci = colIndex(cell);
      if (ci < 0 || ci >= n) continue;
      widths[ci] = Math.max(widths[ci], cellNatural(cell));
    }
    for (let i = 0; i < n; i++) {
      widths[i] = Math.max(MIN, Math.min(Math.round(widths[i]), CAP));
    }
    return widths;
  }

  reflowTable(table) {
    const file = this.app.workspace.getActiveFile();
    const path = table.dataset.tcrPath || (file ? file.path : 'unknown');
    const preview = table.closest('.markdown-preview-view');
    const allowDrag = !preview; // edit (Live Preview) => drag handles
    const headCols = table.querySelectorAll('thead th, thead td');
    const n = headCols.length;
    if (!n) return;
    const tid = this.tableId(table);
    this.reconcileTableDimensions(table, path, tid, n);

    // Live Preview (and other renderers) may wipe our <col> widths / handles on
    // re-render. Re-apply the stored widths, and rebuild anything missing, so the
    // table always matches the saved state (and therefore matches Reading view).
    const colgroup = this.ensureColgroup(table, n);
    this.applyWidths(table, colgroup, path, tid, preview);
    this.applyRowHeights(table, path, tid);
    this.applyMerges(table, path, tid);
    this.applyCellAlignments(table,path,tid);

    // Re-add drag handles in edit mode if Live Preview dropped them.
    if (allowDrag) {
      headCols.forEach((th, i) => {
        if (th.querySelector('.tcr-handle')) return;
        th.style.position = 'relative';
        const handle = document.createElement('div');
        handle.className = 'tcr-handle';
        handle.addEventListener('pointerdown', (e) => this.startDrag(e, colgroup, i, path, tid));
        th.appendChild(handle);
      });
      table.querySelectorAll('.tcr-row-handle').forEach(h => h.remove());
    }

    // Reading: keep the wrap at the full pane width (no centering clip) and
    // left-align the table. The view clips horizontally (.tcr-has-wrap), and
    // every ancestor between wrap and view is left overflow:visible, so the
    // wrap is the SOLE horizontal scroll container (one scrollbar, full width).
    if (preview) {
      // Reading: wrap the table in its own horizontal scroll container. The
      // wrap fills its natural containing block (works in any Obsidian
      // version/theme, centered or full-width), so it never overflows an
      // ancestor and the table can never be clipped/cut. Wide tables scroll
      // inside the wrap only (one scrollbar, no view-level scrollbar).
      let wrapper = table.parentElement;
      if (!wrapper || !wrapper.classList.contains('tcr-wrap')) {
        wrapper = document.createElement('div');
        wrapper.className = 'tcr-wrap';
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      }
      this.markWrapChain(wrapper, preview);
      this.alignTableLeft(table);
    }
    if (allowDrag) {
      // Live Preview can cache and reattach an already-marked table after its
      // listeners were cleaned up while detached. Restore interaction too.
      this.setupCellSelection(table,path,tid);
      this.setupAxisRails(table);
      this.positionAxisRails(table);
    }
    if (this._sel?.table === table) this.positionSelectionOverlay();
  }

  // Add .tcr-has-wrap to the view and every ancestor of the wrap up to it, so
  // CSS can clip only at the scroll container and keep the chain un-clipped.
  markWrapChain(wrapper, preview) {
    let anc = wrapper.parentElement;
    while (anc && anc !== preview) {
      anc.classList.add('tcr-has-wrap');
      anc = anc.parentElement;
    }
    if (preview) preview.classList.add('tcr-has-wrap');
  }

  reflow() {
    document.querySelectorAll('table[data-tcr]').forEach((t) => this.reflowTable(t));
    if (this._sel && !this._sel.table.isConnected) this.clearMergeSelection();
    else this.positionSelectionOverlay();
  }

  enhance(table, ctx, allowDrag) {
    if (table.dataset.tcr) { this.reflowTable(table); return; }

    const path =
      (ctx && ctx.sourcePath) ||
      (this.app.workspace.getActiveFile() && this.app.workspace.getActiveFile().path) ||
      'unknown';
    const preview = table.closest('.markdown-preview-view');
    const headCols = table.querySelectorAll('thead th, thead td');
    const n = headCols.length;
    if (!n) return;
    const tid = this.tableId(table);
    this.reconcileTableDimensions(table, path, tid, n);

    table.dataset.tcr = '1';
    table.dataset.tcrPath = path;
    table.style.tableLayout = 'fixed';
    table.style.maxWidth = 'none';

    const colgroup = this.ensureColgroup(table, n);
    this.applyWidths(table, colgroup, path, tid, preview);
    this.applyRowHeights(table, path, tid);
    this.applyMerges(table, path, tid);
    this.applyCellAlignments(table,path,tid);

    if (preview) {
      // Reading: wrap the table in its own horizontal scroll container (see
      // reflowTable). The wrap fills its containing block — no breakout, no
      // geometry assumptions — so it is robust across vaults/themes and the
      // table is never clipped or cut.
      const wrapper = document.createElement('div');
      wrapper.className = 'tcr-wrap';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
      this.markWrapChain(wrapper, preview);
      this.alignTableLeft(table);
    }
    // Edit mode: no wrap — the editor's own horizontal scroll handles overflow.

    // Drag handles ONLY in edit mode (requirement: resize is edit-mode only).
    if (allowDrag) {
      // Column handles on EVERY cell of each column: dragging the right edge of
      // any cell (header or body) resizes the whole column.
      const rows = table.querySelectorAll('tr');
      rows.forEach((tr) => {
        const cells = tr.querySelectorAll('th, td');
        cells.forEach((cell, i) => {
          if (i >= n) return; // safety: more cells than header columns
          if (cell.querySelector('.tcr-handle')) return;
          cell.style.position = 'relative';
          const handle = document.createElement('div');
          handle.className = 'tcr-handle';
          handle.addEventListener('pointerdown', (e) => this.startDrag(e, colgroup, i, path, tid));
          cell.appendChild(handle);
        });
      });
      this.setupCellSelection(table, path, tid);
    }
  }

  // ---- cell merge (Excel-style) ----------------------------------------
  // Merge info is stored per table in data.json:
  //   merges[path][tid] = [{ r, c, rowspan, colspan }, ...]
  // On merge the source is rewritten like Excel: the top-left cell keeps all
  // inherited content (same-row cells first, then following rows; joined with
  // <br>), and the other cells in the range are emptied. Splitting restores
  // the grid; the content stays consolidated in the top-left cell.

  currentPath() {
    const file = this.app.workspace.getActiveFile();
    return file ? file.path : 'unknown';
  }

  activeEditor() {
    const view = this.app?.workspace?.getActiveViewOfType?.(MarkdownView);
    return view && view.editor ? view.editor : null;
  }

  cellRow(cell) {
    const tr = cell.closest('tr');
    const table = tr && tr.closest('table');
    if (!table) return -1;
    return Array.from(table.rows).indexOf(tr);
  }

  cellCol(cell) {
    const tr = cell.closest('tr');
    if (!tr) return -1;
    return Array.from(tr.children).indexOf(cell);
  }

  getMerges(path, tid) {
    if (!this.merges[path]) this.merges[path] = {};
    if (!Array.isArray(this.merges[path][tid])) this.merges[path][tid] = [];
    return this.merges[path][tid];
  }

  effectiveMerges(table, path, tid) {
    const list = (this.merges[path] && this.merges[path][tid]) || [];
    const valid = this.validMergeRegions(table, list);
    const stable = !!this.tableUid(table);
    if (stable) return valid;
    const grid = table ? Array.from(table.rows).map((row) => Array.from(row.cells)) : [];
    return valid.filter((reg) => {
      const anchor = grid[reg.r] && grid[reg.r][reg.c];
      return !!(anchor && (anchor.textContent || '').trim());
    });
  }

  validMergeRegions(table, regions) {
    const rows = table && table.rows;
    const occupied = new Set();
    return regions.filter((m) => {
      if (!m || ![m.r, m.c, m.rowspan, m.colspan].every(Number.isInteger) ||
          m.r < 0 || m.c < 0 || m.rowspan < 1 || m.colspan < 1) return false;
      if (!rows) return true;
      if (m.r + m.rowspan > rows.length) return false;
      const keys = [];
      for (let r = m.r; r < m.r + m.rowspan; r++) {
        if (m.c + m.colspan > rows[r].cells.length) return false;
        for (let c = m.c; c < m.c + m.colspan; c++) {
          const key = r + ',' + c;
          if (occupied.has(key)) return false;
          keys.push(key);
        }
      }
      keys.forEach((key) => occupied.add(key));
      return true;
    });
  }

  regionContains(reg, r, c) {
    return r >= reg.r && r < reg.r + reg.rowspan && c >= reg.c && c < reg.c + reg.colspan;
  }

  resetMerges(table, keepStyles = false) {
    table.classList.remove('tcr-grid-table');
    table.style.gridTemplateColumns = '';
    table.style.gridTemplateRows = '';
    table.querySelectorAll('th, td').forEach((cell) => {
      if (cell.dataset.tcrMerge) cell.style.height = '';
      cell.colSpan = 1;
      cell.rowSpan = 1;
      cell.style.display = '';
      cell.classList.remove('tcr-merged', 'tcr-merged-hidden');
      delete cell.dataset.tcrMerge;
      cell.style.gridRow = '';
      cell.style.gridColumn = '';
    });
    if (!keepStyles && this._layoutStyles?.has(table)) {
      this._layoutStyles.get(table).remove();this._layoutStyles.delete(table);
    }
  }

  updateMergeGridRows(table, path, tid) {
    const heights = this.getRowHeights(path, tid) || [];
    table.style.gridTemplateRows = Array.from(table.rows, (_, r) =>
      'minmax(' + Math.max(24, parseFloat(heights[r]) || 30) + 'px, auto)').join(' ');
    table._tcrGridRows = table.style.gridTemplateRows;
    this.updateLayoutStyle(table);
  }

  prepareMergeGrid(table, path, tid, grid) {
    // Native rowspan stops at THEAD/TBODY boundaries. Preserve those DOM nodes
    // for Obsidian's editor, but lay out every logical cell in one CSS grid.
    table.classList.add('tcr-grid-table');
    const colgroup = table.querySelector('colgroup');
    const widths = this.getWidths(path, tid, grid[0].length) || [];
    table.style.gridTemplateColumns = grid[0].map((_, c) =>
      (colgroup && colgroup.children[c] && colgroup.children[c].style.width) ||
      widths[c] || '80px').join(' ');
    table._tcrGridCols = table.style.gridTemplateColumns;
    this.updateMergeGridRows(table, path, tid);
    grid.forEach((row, r) => row.forEach((cell, c) => {
      cell.style.gridRow = String(r + 1);
      cell.style.gridColumn = String(c + 1);
      cell.dataset.tcrCell = r+','+c;
    }));
  }

  applyMerges(table, path, tid) {
    const regions = this.effectiveMerges(table, path, tid);
    table._tcrRegions = regions;
    this.resetMerges(table,true);
    if (!regions.length) {this.updateLayoutStyle(table);return;}
    // Snapshot the physical grid before assigning rowspan/colspan. Never index
    // the live HTMLTableRowElement.cells collection after structure changes.
    const grid = Array.from(table.rows).map((row) => Array.from(row.cells));
    this.prepareMergeGrid(table, path, tid, grid);
    // Legacy tables had no persistent identity, so a newly created empty table
    // could inherit merges from an older table with the same blank header. Only
    // trust a legacy region when its anchor still contains content. Every new
    // merge receives an invisible persistent id and is not subject to this rule.
    const occupied = new Set();
    regions.forEach((reg) => {
      if (!reg || reg.r < 0 || reg.c < 0 || reg.rowspan < 1 || reg.colspan < 1) return;
      const cells = [];
      for (let rr = reg.r; rr < reg.r + reg.rowspan; rr++) {
        for (let cc = reg.c; cc < reg.c + reg.colspan; cc++) {
          const cell = grid[rr] && grid[rr][cc];
          const key = rr + ',' + cc;
          // Ignore stale, out-of-bounds or overlapping records as a whole so a
          // damaged record can never hide only part of the visible table.
          if (!cell || occupied.has(key)) return;
          cells.push({ rr, cc, cell, key });
        }
      }
      const anchor = grid[reg.r][reg.c];
      anchor.colSpan = reg.colspan;
      anchor.rowSpan = reg.rowspan;
      anchor.classList.add('tcr-merged');
      anchor.dataset.tcrMerge = reg.r + ',' + reg.c;
      anchor.style.gridRow = (reg.r + 1) + ' / span ' + reg.rowspan;
      anchor.style.gridColumn = (reg.c + 1) + ' / span ' + reg.colspan;
      // Row tracks own heights; a summed cell height must not inflate row one.
      anchor.style.height = '';
      cells.forEach(({ rr, cc, cell, key }) => {
        occupied.add(key);
        if (rr === reg.r && cc === reg.c) return;
        cell.classList.add('tcr-merged-hidden');
        cell.style.display = 'none';
        cell.dataset.tcrMerge = reg.r + ',' + reg.c;
      });
    });
    this.updateLayoutStyle(table);
  }

  // Cell editors temporarily remove the entire style attribute. Keep the
  // presentation outside their DOM, indexed by persistent data attributes.
  updateLayoutStyle(table) {
    if (typeof document.createElement !== 'function') return;
    if (!this._layoutStyles) this._layoutStyles = new Map();
    const grid = table.classList.contains('tcr-grid-table');
    const aligned = Array.from(table.querySelectorAll('[data-tcr-align], [data-tcr-valign]'));
    if (!grid && !aligned.length && !this._layoutStyles.has(table)) return;
    if (!table.dataset.tcrLayout) {
      this._layoutSequence=(this._layoutSequence||0)+1;
      table.dataset.tcrLayout='l'+this._layoutSequence;
    }
    const selector='table[data-tcr-layout="'+table.dataset.tcrLayout+'"]';
    const rules=[];
    if (grid) {
      const widths=(table._tcrGridCols || '').split(' ').map(parseFloat);
      const width=widths.every(Number.isFinite)?'width:'+widths.reduce((a,b)=>a+b,0)+'px!important;':'';
      rules.push(selector+'{'+width+'grid-template-columns:'+table._tcrGridCols+'!important;grid-template-rows:'+table._tcrGridRows+'!important;}');
      const regions=table._tcrRegions || [];
      Array.from(table.rows).forEach((row,r)=>Array.from(row.cells).forEach((cell,c)=>{
        cell.dataset.tcrCell=r+','+c;
        const m=regions.find(m=>m.r===r&&m.c===c);
        rules.push(selector+' [data-tcr-cell="'+r+','+c+'"]{grid-row:'+(r+1)+(m?' / span '+m.rowspan:'')+'!important;grid-column:'+(c+1)+(m?' / span '+m.colspan:'')+'!important;}');
      }));
    }
    for (const cell of aligned) {
      const target=selector+' [data-tcr-cell="'+cell.dataset.tcrCell+'"]';
      if(cell.dataset.tcrAlign)rules.push(target+'{text-align:'+cell.dataset.tcrAlign+'!important;}');
      if(cell.dataset.tcrValign){
        const value=cell.dataset.tcrValign,content={top:'start',middle:'center',bottom:'end'}[value];
        rules.push(target+'{vertical-align:'+value+'!important;}');
        rules.push(target+' > .table-cell-wrapper{height:auto!important;}');
        // Grid items are blockified: vertical-align alone has no effect. Block
        // content alignment preserves inline markup and the native editor DOM.
        if(grid)rules.push(target+'{align-content:'+content+'!important;}');
      }
    }
    let style=this._layoutStyles.get(table);
    if (!style) {style=document.createElement('style');style.className='tcr-layout-style';document.head.appendChild(style);this._layoutStyles.set(table,style);}
    const text=rules.join('\n');if(style.textContent!==text)style.textContent=text;
  }

  applyCellAlignments(table,path,tid) {
    const map=this.alignments?.[path]?.[tid] || {};
    Array.from(table.rows).forEach((row,r)=>Array.from(row.cells).forEach((cell,c)=>{
      cell.dataset.tcrCell=r+','+c;
      const value=map[r+','+c],alignment=typeof value==='string'?value:value?.horizontal,vertical=value?.vertical;
      if (['left','center','right'].includes(alignment)) {cell.dataset.tcrAlign=alignment;cell.style.textAlign=alignment;}
      else if (cell.dataset.tcrAlign) {delete cell.dataset.tcrAlign;cell.style.textAlign='';}
      if(['top','middle','bottom'].includes(vertical)){cell.dataset.tcrValign=vertical;cell.style.verticalAlign=vertical;}
      else if(cell.dataset.tcrValign){delete cell.dataset.tcrValign;cell.style.verticalAlign='';}
    }));
    this.updateLayoutStyle(table);
  }

  remapAlignments(map, axis, transform) {
    const next={};
    for(const [key,value] of Object.entries(map || {})) {
      const [r,c]=key.split(',').map(Number), index=transform(axis==='row'?r:c);
      if(index!==null)next[(axis==='row'?index:r)+','+(axis==='col'?index:c)]=value;
    }
    return next;
  }

  alignmentSelectionCells(sel) {
    if (!sel.axis) return this.selectionCells(sel);
    const selected=new Set(), merges=this.effectiveMerges(sel.table,sel.path,sel.tid);
    for(let r=0;r<sel.table.rows.length;r++)for(let c=0;c<sel.table.rows[r].cells.length;c++){
      const m=merges.find(m=>this.regionContains(m,r,c));
      const start=sel.axis==='row'?(m?m.r:r):(m?m.c:c),span=m?(sel.axis==='row'?m.rowspan:m.colspan):1;
      if(Array.from({length:span},(_,i)=>start+i).every(i=>sel.indices.has(i)))selected.add(r+','+c);
    }
    return selected;
  }

  setSelectionAlignment(alignment, axis='horizontal') {
    const sel=this._sel, editor=this.activeEditor();
    const allowed=axis==='horizontal'?['left','center','right']:axis==='vertical'?['top','middle','bottom']:[];
    if(!sel || !editor || !allowed.includes(alignment))return;
    if(sel.table.isConnected===false || this.currentPath()!==sel.path)return;
    const cells=this.alignmentSelectionCells(sel),info=this.tableSourceInfo(editor,sel.table);
    if(!info){new Notice('TableTune: 无法定位表格源码，对齐已取消');return;}
    if(!cells.size)return;
    const uid=info.uid || this.uidFromGrid(info.grid) || ('m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8)),tid='u'+uid;
    const oldTid=info.uid?tid:sel.tid;
    if(!info.uid){
      // Alignment changes metadata only. Replacing the entire source table
      // forces native Live Preview to rebuild its active header editor. Insert
      // just the missing identity inside the first cell, preserving all text,
      // padding, escapes and the active cell's incremental update path.
      if(typeof info.header!=='string'){new Notice('TableTune: 无法安全保存表格标识，对齐已取消');return;}
      const prefix=info.header.match(/^\s*\|?\s*/)[0].length;
      const at=info.toPos(info.from+prefix);
      try{this.replaceTableRange(editor,this.encodeInvisibleUid(uid),at,at);}
      catch(e){new Notice('TableTune: 对齐保存失败');return;}
      for(const store of [this.widths,this.rowHeights,this.merges,this.tableDims,this.alignments || {},this.cellStyles || {},this.tableOptions || {}]) {
        if(store?.[sel.path]?.[oldTid]!==undefined)store[sel.path][tid]=store[sel.path][oldTid];
      }
      sel.table.dataset.tableTuneUid=uid;
    }
    if(!this.alignments)this.alignments={};if(!this.alignments[sel.path])this.alignments[sel.path]={};
    const map={...(this.alignments[sel.path][tid] || {})};
    for(const key of cells){
      const previous=map[key];
      // Keep legacy horizontal strings readable; add the second axis without
      // overwriting an existing horizontal or vertical setting.
      if(axis==='horizontal' && (!previous || typeof previous==='string'))map[key]=alignment;
      else map[key]={...(typeof previous==='string'?{horizontal:previous}:previous),[axis]:alignment};
    }
    this.alignments[sel.path][tid]=map;sel.tid=tid;
    this.applyCellAlignments(sel.table,sel.path,tid);this.persist();
    // The insertion is reconciled by the native cell editor. Do not schedule
    // another table enhancement/rebuild while that editor is still active.
  }

  addAlignmentMenu(menu) {
    if(!this._sel)return;
    for(const [value,title] of [['left','左对齐'],['center','居中对齐'],['right','右对齐']])menu.addItem(item=>{
      item.setTitle(title);item.onClick(()=>this.setSelectionAlignment(value));
      item.setChecked?.(this.selectionAlignment('horizontal')===value);
    });
    for(const [value,title] of [['top','顶部对齐'],['middle','垂直居中'],['bottom','底部对齐']])menu.addItem(item=>{
      item.setTitle(title);item.onClick(()=>this.setSelectionAlignment(value,'vertical'));
      item.setChecked?.(this.selectionAlignment('vertical')===value);
    });
  }

  selectionAlignment(axis) {
    const sel=this._sel;
    if(!sel)return null;
    const map=this.alignments?.[sel.path]?.[sel.tid] || {},values=new Set();
    for(const key of this.alignmentSelectionCells(sel)){
      const entry=map[key];
      values.add((typeof entry==='string'?(axis==='horizontal'?entry:null):entry?.[axis]) || (axis==='vertical'?'top':'left'));
    }
    return values.size===1?values.values().next().value:null;
  }

  setMerge(path, tid, reg) {
    const list = this.getMerges(path, tid);
    // Never discard an intersected merge unless the new rectangle contains it
    // completely. Callers must close their selection before changing content.
    const partial = list.some((m) => {
      const overlaps = reg.r < m.r + m.rowspan && m.r < reg.r + reg.rowspan &&
        reg.c < m.c + m.colspan && m.c < reg.c + reg.colspan;
      const contains = reg.r <= m.r && reg.c <= m.c &&
        reg.r + reg.rowspan >= m.r + m.rowspan && reg.c + reg.colspan >= m.c + m.colspan;
      return overlaps && !contains;
    });
    if (partial) return false;
    const kept = list.filter((m) => {
      return !(
        reg.r < m.r + m.rowspan &&
        m.r < reg.r + reg.rowspan &&
        reg.c < m.c + m.colspan &&
        m.c < reg.c + reg.colspan
      );
    });
    kept.push(reg);
    this.merges[path][tid] = kept;
    return true;
  }

  // ---- source-level table parsing --------------------------------------
  isTableRowLine(line) {
    const s = (line || '').trim();
    return s.includes('|') && !/^```/.test(s);
  }
  isSepLine(line) {
    const s = (line || '').trim();
    if (!s.includes('|')) return false;
    return this.splitRow(s).every((c) => /^\s*:?-+:?\s*$/.test(c));
  }
  splitRow(line) {
    let s = (line || '').trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
      if (ch === '|') { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }
  buildRow(cells) {
    return '| ' + cells.join(' | ') + ' |';
  }
  tableSourceInfo(editor, table) {
    const doc = editor.getDoc();
    const cm = editor.cm;
    const cmDoc = cm && cm.state && cm.state.doc;
    const useCM = cmDoc && Number.isInteger(cmDoc.lines) && typeof cmDoc.line === 'function';
    const lineCount = useCM ? cmDoc.lines : typeof doc.lineCount === 'function' ? doc.lineCount() :
      Array.isArray(doc.lines) ? doc.lines.length : Number.isInteger(doc.lines) ? doc.lines : 0;
    const getLine = i => useCM ? cmDoc.line(i+1).text : typeof doc.getLine === 'function' ? doc.getLine(i) :
      typeof doc.line === 'function' ? doc.line(i+1).text : doc.lines[i];
    const starts = new Array(lineCount);
    let acc = 0;
    for (let i = 0; i < lineCount; i++) { starts[i] = acc; acc += (getLine(i) || '').length + 1; }
    const blocks = [];
    for (let i = 0; i + 1 < lineCount; i++) {
      const header = getLine(i) || '';
      const sep = getLine(i + 1) || '';
      if (!this.isTableRowLine(header) || !this.isSepLine(sep)) continue;
      const grid = [this.splitRow(header)];
      let endLine = i + 1;
      for (let j = i + 2; j < lineCount; j++) {
        const line = getLine(j) || '';
        if (!this.isTableRowLine(line)) break;
        grid.push(this.splitRow(line));
        endLine = j;
      }
      let markerLine = -1, marker = null;
      const directlyAbove = i > 0 ? (getLine(i - 1) || '').trim() : '';
      const twoLinesAbove = i > 1 ? (getLine(i - 2) || '').trim() : '';
      marker = directlyAbove.match(/^%%table-tune-id:([a-z0-9_-]+)%%$/i) ||
        directlyAbove.match(/^<!--\s*table-tune-id:([a-z0-9_-]+)\s*-->$/i);
      if (marker) markerLine = i - 1;
      if (!marker && directlyAbove === '') {
        marker = twoLinesAbove.match(/^<!--\s*table-tune-id:([a-z0-9_-]+)\s*-->$/i) ||
          twoLinesAbove.match(/^%%table-tune-id:([a-z0-9_-]+)%%$/i);
        if (marker) markerLine = i - 2;
      }
      blocks.push({
        grid, sep, startLine: i, endLine,
        uid: marker ? marker[1] : this.uidFromGrid(grid), markerLine,
      });
      i = endLine;
    }
    if (!blocks.length) return null;

    // Prefer CodeMirror's source position when available, but use a cell rather
    // than the synthetic table wrapper. During Live Preview re-render this call
    // can legitimately fail, so two deterministic fallbacks follow.
    const head = table.querySelector('thead th, thead td');
    const liveUid = head && this.decodeInvisibleUid(head.textContent || '');
    const uid = liveUid || (table.dataset && table.dataset.tableTuneUid);
    const uidMatches = uid ? blocks.filter(b => b.uid === uid) : [];
    let block = liveUid && uidMatches.length === 1 ? uidMatches[0] : null;
    const domHead = Array.from(table.querySelectorAll('thead th, thead td'))
      .map(c => {
        const content = c.querySelector && (c.querySelector('.table-cell-wrapper .cm-content') || c.querySelector('.table-cell-content'));
        return this.sourceCellText((content || c).textContent || '');
      });
    const sameShapeAndHeader = b => (!table.rows || b.grid.length === table.rows.length) &&
      b.grid[0].length === domHead.length && b.grid[0].every((v, i) => this.sourceCellText(v) === domHead[i]);
    if (!liveUid && block && table.rows && !sameShapeAndHeader(block)) block = null;
    try {
      const probe = table.querySelector('th,td') || table;
      const off = cm ? cm.posAtDOM(probe) : null;
      if (!block && typeof off === 'number') {
        const mapped = blocks.find((b) => off >= starts[b.startLine] && off <= starts[b.endLine] + (getLine(b.endLine) || '').length);
        // A header edit/undo may remove or change the invisible id while the
        // editor keeps the same DOM node. Recover only with a verified position
        // AND matching dimensions/header, never a stale ordinal alone.
        if (mapped && sameShapeAndHeader(mapped)) block = mapped;
      }
    } catch (e) { /* Keep an identity match when DOM mapping is unavailable. */ }
    const domTables = this.tablePeers(table);
    const ordinal = domTables.indexOf(table);
    if (!block && !uid && domTables.length === blocks.length && ordinal >= 0 && ordinal < blocks.length &&
      sameShapeAndHeader(blocks[ordinal])) block = blocks[ordinal];
    // Cached DOM identity is only a last resort: CodeMirror may reuse a node
    // previously belonging to a different table during a document rerender.
    if (!block && uidMatches.length === 1 && sameShapeAndHeader(uidMatches[0])) block = uidMatches[0];
    if (!block) {
      const matches = blocks.filter(b => (!uid || sameShapeAndHeader(b)) && b.grid[0].length === domHead.length &&
        b.grid[0].every((v, i) => this.sourceCellText(v) === domHead[i]));
      if (matches.length === 1) block = matches[0];
    }
    if (!block) return null;
    const { grid, sep, startLine, endLine, uid: blockUid, markerLine } = block;
    const from = starts[markerLine >= 0 ? markerLine : startLine];
    const to = starts[endLine] + (getLine(endLine) || '').length;
    return {
      grid,
      header: getLine(startLine),
      rowSources: grid.map((_, r) => {
        const line = startLine + r + (r ? 1 : 0);
        return { text: getLine(line), from: starts[line] };
      }),
      sep,
      startLine,
      endLine,
      uid: blockUid,
      markerLine,
      from,
      to,
      toPos: (off) => {
        if (typeof editor.offsetToPos === 'function') return editor.offsetToPos(off);
        const l = cm.state.doc.lineAt(off);
        return { line: l.number - 1, ch: off - l.from };
      },
    };
  }

  sourceCellText(value) {
    return this.stripTableIdentity(value || '')
      .replace(/<br\s*\/?>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/!??\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2')
      .replace(/[*_`~]/g, '')
      .replace(/\\\|/g, '|')
      .trim();
  }

  rowCellRanges(line) {
    const start = line.length - line.trimStart().length;
    const end = line.trimEnd().length;
    let from = start + (line[start] === '|' ? 1 : 0), stop = end;
    const pipes = [];
    for (let i = from; i < end; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === '|') pipes.push(i);
    }
    if (pipes[pipes.length - 1] === end - 1) { stop--; pipes.pop(); }
    const ranges = [];
    for (const to of [...pipes, stop]) {
      const raw = line.slice(from, to), text = raw.trim();
      const at = from + raw.length - raw.trimStart().length;
      ranges.push({ from: at, to: at + text.length, text });
      from = to + 1;
    }
    return ranges;
  }
  rewriteSourceMerge(editor, table, r1, c1, r2, c2) {
    const info = this.tableSourceInfo(editor, table);
    if (!info) return false;
    const { grid } = info;
    if (![r1, c1, r2, c2].every(Number.isInteger) || r1 < 0 || c1 < 0 ||
        r2 < r1 || c2 < c1 || r2 >= grid.length) return false;
    for (let r = r1; r <= r2; r++) if (!grid[r] || c2 >= grid[r].length) return false;
    const parts = [grid[r1][c1]];
    for (let cc = c1 + 1; cc <= c2; cc++) parts.push(grid[r1][cc]);
    for (let rr = r1 + 1; rr <= r2; rr++)
      for (let cc = c1; cc <= c2; cc++) parts.push(grid[rr][cc]);
    const combined = parts.map((p) => this.stripTableIdentity(p))
      .filter((p) => p && p.trim() !== '').join('<br>');
    const ng = grid.map((row) => row.slice());
    for (let rr = r1; rr <= r2; rr++)
      for (let cc = c1; cc <= c2; cc++) ng[rr][cc] = '';
    ng[r1][c1] = combined;
    // Give every actively merged table a zero-width persistent id. Earlier
    // builds used visible HTML/comment markers; remove them during this rewrite.
    const uid = info.uid || this.uidFromGrid(ng) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    for (let c = 0; c < ng[0].length; c++) {
      ng[0][c] = this.stripTableIdentity(ng[0][c]);
    }
    ng[0][0] = this.encodeInvisibleUid(uid) + (ng[0][0] || '');
    // Keep every change inside ONE native cell. Replacing a whole table (or
    // even a range spanning two header cells) bypasses Obsidian's incremental
    // cell updates and tears down the live header editor, losing its content.
    if (!info.rowSources || info.rowSources.length !== grid.length) return false;
    const changes = [];
    for (let r = 0; r < grid.length; r++) {
      const row = info.rowSources[r], ranges = this.rowCellRanges(row.text);
      if (ranges.length !== grid[r].length || ranges.some((range,c) => range.text !== grid[r][c])) return false;
      for (let c = 0; c < grid[r].length; c++) {
        if (ng[r][c] === grid[r][c]) continue;
        const range = ranges[c], before = range.text, after = ng[r][c];
        let prefix = 0, suffix = 0;
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
        while (suffix < before.length-prefix && suffix < after.length-prefix && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++;
        changes.push({from:row.from+range.from+prefix,to:row.from+range.to-suffix,insert:after.slice(prefix,after.length-suffix)});
      }
    }
    try {
      // One atomic CodeMirror transaction lets the native table reconcile all
      // changed cells without replacing any editor or table DOM.
      this.dispatchTableChanges(editor,changes,info.toPos);
    } catch (e) { return null; }
    return { tid: 'u' + uid };
  }

  mergeSelectedCells() {
    let sel = this._sel;
    if (!sel || sel.axis) return;
    if (sel.table.isConnected === false || (this.app && this.currentPath() !== sel.path)) {
      this.clearMergeSelection();
      new Notice('TableTune: 表格已刷新或笔记已切换，请重新框选');
      return;
    }
    this.selectRect(sel.table, sel.r1, sel.c1, sel.r2, sel.c2, sel.path, sel.tid);
    sel = this._sel;
    if (this.selectionCells(sel).size < 2) return;
    if (this.isMergeRegion(sel)) return;
    const editor = this.activeEditor();
    if (!editor) { new Notice('TableTune: merge cells is available in Edit mode only'); return; }
    if (!this.selectionIsRectangle(sel)) {
      new Notice('TableTune: 当前选区包含完整合并格后不是连续矩形，请调整拖拽范围');
      return;
    }
    const previousRegions = this.effectiveMerges(sel.table, sel.path, sel.tid)
      .map((m) => ({ ...m }));
    const priorHeights = this.getRowHeights(sel.path, sel.tid);
    const mergedHeight = this.preserveSelectedRowHeights(sel.table, sel.path, sel.tid, sel.r1, sel.r2);
    const editTables = Array.from(document.querySelectorAll('.cm-content table'));
    const tableOrdinal = Math.max(0, editTables.indexOf(sel.table));
    const result = this.rewriteSourceMerge(editor, sel.table, sel.r1, sel.c1, sel.r2, sel.c2);
    if (!result) {
      if (priorHeights) this.setRowHeights(sel.path, sel.tid, priorHeights);
      else if (this.rowHeights[sel.path]) delete this.rowHeights[sel.path][sel.tid];
      new Notice('TableTune: 无法定位完整表格，合并已取消'); return;
    }
    const oldTid = sel.tid;
    const newTid = result.tid;
    if (newTid !== oldTid) this.adoptStableTableId(sel.table, sel.path, oldTid, newTid);
    if (!this.merges[sel.path]) this.merges[sel.path] = {};
    this.merges[sel.path][newTid] = previousRegions;
    const reg = {
      r: sel.r1, c: sel.c1,
      rowspan: sel.r2 - sel.r1 + 1, colspan: sel.c2 - sel.c1 + 1,
      height: mergedHeight > 0 ? Math.round(mergedHeight) + 'px' : undefined,
    };
    this.setMerge(sel.path, newTid, reg);
    this.persist();
    this.clearMergeSelection();
    // The source edit invalidates the current Live Preview DOM. Do not mutate
    // that stale table: wait for the new node, migrate a changed header-based
    // id if needed, and enhance only the fresh render.
    this.rekeyAfterSourceChange(sel.path, newTid, tableOrdinal, sel.table);
  }

  preserveSelectedRowHeights(table, path, tid, r1, r2) {
    const previous = this.getRowHeights(path, tid) || [];
    const heights = previous.slice();
    const tracks = table.classList && table.classList.contains('tcr-grid-table') &&
      typeof getComputedStyle === 'function'
      ? getComputedStyle(table).gridTemplateRows.split(' ').map(parseFloat) : [];
    let total = 0;
    for (let r = r1; r <= r2; r++) {
      const row = table.rows[r];
      const measured = row && row.getBoundingClientRect ? row.getBoundingClientRect().height : 0;
      const px = Math.max(measured, tracks[r] || 0, parseFloat(heights[r]) || 0, 24);
      heights[r] = Math.ceil(px) + 'px';
      total += px;
    }
    this.setRowHeights(path, tid, heights);
    return total;
  }

  adoptStableTableId(table, path, oldTid, newTid) {
    for (const store of [this.widths, this.rowHeights, this.tableDims, this.alignments || {},this.cellStyles || {},this.tableOptions || {}]) {
      if (!store[path] || store[path][oldTid] === undefined) continue;
      store[path][newTid] = store[path][oldTid];
    }
    if (!this.merges[path]) this.merges[path] = {};
    // Carry forward only legacy merges that visibly still have a non-empty
    // anchor. This discards stale empty-table records that caused missing cells.
    const grid = Array.from(table.rows).map((row) => Array.from(row.cells));
    const legacy = (this.merges[path][oldTid] || []).filter((reg) => {
      const anchor = grid[reg.r] && grid[reg.r][reg.c];
      return !!(anchor && (anchor.textContent || '').trim());
    });
    this.merges[path][newTid] = legacy;
  }

  deleteSelectedRows() { this.deleteSelectionAxis('row'); }
  deleteSelectedColumns() { this.deleteSelectionAxis('col'); }

  insertTableAxis(table, axis, at) {
    const editor = this.activeEditor(), path = table.dataset.tcrPath || this.currentPath();
    if (!editor || table.isConnected === false || path !== this.currentPath()) return;
    const info = this.tableSourceInfo(editor, table);
    if (!info) { new Notice('TableTune: 无法定位表格源码，插入已取消'); return; }
    const grid = info.grid.map(row => row.slice()), oldRows = grid.length, oldCols = grid[0].length;
    const total = axis === 'row' ? oldRows : oldCols;
    if (!Number.isInteger(at) || at < 0 || at > total || grid.some(row => row.length !== oldCols)) return;
    const oldTid = info.uid ? 'u'+info.uid : this.tableId(table), uid = info.uid || this.uidFromGrid(grid) || ('m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8));
    const tid = 'u'+uid;
    const regions = this.validMergeRegions({rows:grid.map(cells=>({cells}))}, (this.merges[path]?.[oldTid] || [])).map(m=>({...m}));
    grid[0] = grid[0].map(v => this.stripTableIdentity(v));
    const sep = this.splitRow(info.sep);
    if (axis === 'row') grid.splice(at,0,Array(oldCols).fill(''));
    else { grid.forEach(row=>row.splice(at,0,'')); sep.splice(at,0,'---'); }
    grid[0][0] = this.encodeInvisibleUid(uid)+grid[0][0];
    const lines = [this.buildRow(grid[0]),this.buildRow(sep),...grid.slice(1).map(row=>this.buildRow(row))];
    const widths = (this.getWidths(path,oldTid,oldCols) || Array.from(table.querySelector('colgroup')?.children || [], c=>c.style.width)).slice();
    while (widths.length < oldCols) widths.push('80px');
    const heights = (this.getRowHeights(path,oldTid) || Array(oldRows).fill(null)).slice();
    while (heights.length < oldRows) heights.push(null);
    if (axis === 'col') widths.splice(at,0,'80px'); else heights.splice(at,0,null);
    try { this.replaceTableRange(editor,lines.join('\n'),info.toPos(info.from),info.toPos(info.to)); }
    catch (e) { new Notice('TableTune: 插入失败'); return; }
    this.setWidths(path,tid,widths); this.setRowHeights(path,tid,heights);
    if (!this.merges[path]) this.merges[path]={};
    this.merges[path][tid]=this.adjustMergesForDimension(regions,axis,total,total+1,at);
    if(this.alignments?.[path]?.[oldTid])this.alignments[path][tid]=this.remapAlignments(this.alignments[path][oldTid],axis,i=>i>=at?i+1:i);
    if (!this.tableDims[path]) this.tableDims[path]={};
    this.tableDims[path][tid]={rows:grid.length,cols:grid[0].length};
    const ordinal=Array.from(document.querySelectorAll('.cm-content table')).indexOf(table);
    this.clearMergeSelection(); this.persist();
    this.rekeyAfterSourceChange(path,tid,Math.max(0,ordinal),table);
    return tid;
  }

  // Delete complete rows/columns only; individual cells are deliberately not
  // deletable. Merge anchors move to the first surviving cell, spans shrink,
  // and a 1x1 remainder automatically becomes a normal cell.
  deleteSelectionAxis(axis) {
    const sel = this._sel;
    const editor = this.activeEditor();
    if (!sel || !editor) {
      new Notice('TableTune: 请先在编辑模式中框选表格单元格');
      return;
    }
    if (sel.axis && ((axis === 'row') !== (sel.axis === 'row'))) return;
    if (sel.table.isConnected === false || (this.app && this.currentPath() !== sel.path)) {
      this.clearMergeSelection();
      new Notice('TableTune: 表格已刷新或笔记已切换，请重新选择');
      return;
    }
    const editTables = Array.from(document.querySelectorAll('.cm-content table'));
    const tableOrdinal = Math.max(0, editTables.indexOf(sel.table));
    const info = this.tableSourceInfo(editor, sel.table);
    if (!info) {
      new Notice('TableTune: 无法定位表格源码，删除已取消');
      return;
    }
    // Source identity wins over a cached id from before a header edit/undo.
    if (info.uid) sel.tid = 'u' + info.uid;
    const oldGrid = info.grid.map((row) => row.slice());
    const rowCount = oldGrid.length;
    const colCount = oldGrid.reduce((n, row) => Math.max(n, row.length), 0);
    const total = axis === 'row' ? rowCount : colCount;
    const first = axis === 'row' ? sel.r1 : sel.c1, last = axis === 'row' ? sel.r2 : sel.c2;
    const indices = sel.axis && sel.indices ? Array.from(sel.indices) :
      Array.from({ length: last-first+1 }, (_, i) => first+i);
    if (!indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= total)) return;
    const deleted = new Set(indices);
    if (deleted.size === total) {
      try { this.replaceTableRange(editor,'', info.toPos(info.from), info.toPos(info.to)); }
      catch (e) { new Notice('TableTune: 表格删除失败'); return; }
      for (const store of [this.widths, this.rowHeights, this.merges, this.tableDims, this.alignments || {},this.cellStyles || {},this.tableOptions || {}])
        if (store[sel.path]) delete store[sel.path][sel.tid];
      this.clearMergeSelection(); this.persist();
      return;
    }

    while (oldGrid.some((row) => row.length < colCount)) {
      oldGrid.forEach((row) => { while (row.length < colCount) row.push(''); });
    }
    const removed = (i) => deleted.has(i);
    const regions = this.validMergeRegions({rows: oldGrid.map(cells => ({cells}))},
      ((this.merges[sel.path] && this.merges[sel.path][sel.tid]) || []))
      .map((m) => ({ ...m }));
    const alignmentMap=this.alignments?.[sel.path]?.[sel.tid] ? {...this.alignments[sel.path][sel.tid]} : null;

    // If an anchor is removed while part of its merge survives, carry its full
    // content to the new top-left anchor before deleting the source row/column.
    for (const m of regions) {
      const rows = [];
      const cols = [];
      for (let r = m.r; r < m.r + m.rowspan; r++) if (axis !== 'row' || !removed(r)) rows.push(r);
      for (let c = m.c; c < m.c + m.colspan; c++) if (axis !== 'col' || !removed(c)) cols.push(c);
      if (!rows.length || !cols.length) continue;
      if ((axis === 'row' && removed(m.r)) || (axis === 'col' && removed(m.c))) {
        oldGrid[rows[0]][cols[0]] = oldGrid[m.r][m.c];
        if(alignmentMap?.[m.r+','+m.c])alignmentMap[rows[0]+','+cols[0]]=alignmentMap[m.r+','+m.c];
      }
    }

    const newGrid = axis === 'row'
      ? oldGrid.filter((_, r) => !removed(r))
      : oldGrid.map((row) => row.filter((_, c) => !removed(c)));
    const stableUid = info.uid || this.uidFromGrid(newGrid);
    if (newGrid[0]) {
      newGrid[0] = newGrid[0].map((v) => this.stripTableIdentity(v));
      if (stableUid) newGrid[0][0] = this.encodeInvisibleUid(stableUid) + (newGrid[0][0] || '');
    }
    const sepCells = this.splitRow(info.sep);
    while (sepCells.length < colCount) sepCells.push('---');
    const newSep = axis === 'col' ? sepCells.filter((_, c) => !removed(c)) : sepCells;
    const lines = [this.buildRow(newGrid[0]), this.buildRow(newSep)];
    for (let r = 1; r < newGrid.length; r++) lines.push(this.buildRow(newGrid[r]));
    try {
      this.replaceTableRange(editor,lines.join('\n'), info.toPos(info.from), info.toPos(info.to));
    } catch (e) {
      new Notice('TableTune: 表格删除失败');
      return;
    }

    const before = (i) => i - indices.filter(index => index < i).length;
    if(alignmentMap)this.alignments[sel.path][sel.tid]=this.remapAlignments(alignmentMap,axis,i=>removed(i)?null:before(i));
    const nextRegions = [];
    for (const m of regions) {
      const rows = [], cols = [];
      for (let r = m.r; r < m.r + m.rowspan; r++) if (axis !== 'row' || !removed(r)) rows.push(r);
      for (let c = m.c; c < m.c + m.colspan; c++) if (axis !== 'col' || !removed(c)) cols.push(c);
      if (!rows.length || !cols.length) continue;
      const reg = {
        r: axis === 'row' ? before(rows[0]) : rows[0],
        c: axis === 'col' ? before(cols[0]) : cols[0],
        rowspan: rows.length,
        colspan: cols.length,
      };
      if (reg.rowspan > 1 || reg.colspan > 1) nextRegions.push(reg);
    }
    if (!this.merges[sel.path]) this.merges[sel.path] = {};
    this.merges[sel.path][sel.tid] = nextRegions;

    if (axis === 'row') {
      const heights = this.getRowHeights(sel.path, sel.tid);
      if (heights) this.setRowHeights(sel.path, sel.tid, heights.filter((_, r) => !removed(r)));
    } else {
      const widths = this.getWidths(sel.path, sel.tid, colCount);
      if (widths) this.setWidths(sel.path, sel.tid, widths.filter((_, c) => !removed(c)));
    }
    if (!this.tableDims[sel.path]) this.tableDims[sel.path] = {};
    this.tableDims[sel.path][sel.tid] = {
      rows: newGrid.length,
      cols: newGrid[0] ? newGrid[0].length : 0,
    };
    this.clearMergeSelection();
    this.persist();
    this.rekeyAfterSourceChange(sel.path, sel.tid, tableOrdinal, sel.table);
  }

  // A table id is derived from its header. Deleting the header or a column can
  // therefore change that id. Once Live Preview has rendered the edited source,
  // move all saved state to the new id of the same table in document order.
  rekeyAfterSourceChange(path, oldTid, tableOrdinal, sourceTable) {
    const root = sourceTable?.closest?.('.cm-content, .markdown-preview-view');
    setTimeout(() => {
      if (path !== this.currentPath()) return;
      const tables = Array.from((root || document).querySelectorAll(root ? 'table' : '.cm-content table'));
      const stable = oldTid.startsWith('u');
      // Never transfer a stable table's metadata to a positional neighbour.
      // Partial rendering/virtualization can change both table count and order.
      const matching = stable ? tables.filter(t => {
        const head = t.querySelector('thead th, thead td');
        const marker = t.querySelector('[data-table-tune-id]');
        const uid = (head && this.decodeInvisibleUid(head.textContent || '')) || marker?.getAttribute('data-table-tune-id');
        return uid && 'u'+uid === oldTid;
      }) : [];
      const table = stable ? (matching.length === 1 ? matching[0] : null) : tables[tableOrdinal];
      if (!table) return;
      const newTid = this.tableId(table);
      if (newTid !== oldTid && !stable) {
        for (const store of [this.widths, this.rowHeights, this.merges, this.tableDims, this.alignments || {},this.cellStyles || {},this.tableOptions || {}]) {
          if (!store[path] || store[path][oldTid] === undefined) continue;
          store[path][newTid] = store[path][oldTid];
          delete store[path][oldTid];
        }
        this.persist();
      }
      delete table.dataset.tcr;
      this.enhance(table, { sourcePath: path }, true);
      this.processActive();
    }, 120);
  }

  splitRegion(path, tid, reg) {
    const list = this.getMerges(path, tid);
    const idx = list.findIndex((m) => m.r === reg.r && m.c === reg.c && m.rowspan === reg.rowspan && m.colspan === reg.colspan);
    if (idx < 0) return;
    list.splice(idx, 1);
    this.clearMergeSelection();
    this.persist();
    document.querySelectorAll('table[data-tcr]').forEach((t) => {
      if (t.dataset.tcrPath === path && this.tableId(t) === tid) {
        this.applyRowHeights(t, path, tid);
        this.applyMerges(t, path, tid);
      }
    });
  }

  installSelectedCellCommands() {
    const commands=this.app?.commands;
    if(this._selectedCommandBinding || typeof commands?.executeCommand!=='function')return;
    const plugin=this,original=commands.executeCommand;
    const wrapped=function(command,event,...args){
      // Obsidian's hotkey scope executes at window capture, before our document
      // key listener. Intercept only bold's command, not the global keymap.
      if(command?.id==='editor:toggle-bold' && plugin.handleSelectedCellKey({
        key:'b',ctrlKey:true,isComposing:event?.isComposing,
        target:event?.target || document.activeElement || document.body,
        preventDefault:()=>event?.preventDefault?.(),
        stopImmediatePropagation:()=>event?.stopImmediatePropagation?.(),
      }))return true;
      return original.call(this,command,event,...args);
    };
    commands.executeCommand=wrapped;
    this._selectedCommandBinding={commands,original,wrapped};
  }

  uninstallSelectedCellCommands() {
    const binding=this._selectedCommandBinding;
    if(binding && binding.commands.executeCommand===binding.wrapped)binding.commands.executeCommand=binding.original;
    this._selectedCommandBinding=null;
  }

  handleSelectedCellKey(e) {
    const key=e.key?.toLowerCase(),bold=(e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key==='b';
    const clear=key==='delete' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if((!bold && !clear) || e.isComposing || e.target.closest?.('input,textarea,.modal'))return false;
    const sel=this._sel,editor=this.activeEditor(),session=editor?.editorComponent?.tableCell;
    if(!sel || !sel.table.isConnected || this.currentPath()!==sel.path || !editor)return false;
    if(!(editor.cm?.dom?.contains(e.target) || session?.cm?.contentDOM?.contains(e.target) ||
      sel.table.contains(e.target) || e.target.closest?.('.tcr-merge-toolbar,.tcr-axis-rail') ||
      e.target===document.body))return false;
    e.preventDefault();e.stopImmediatePropagation();
    this.clearSelectedCellContents(bold?'bold':'clear');
    return true;
  }

  clearSelectedCellContents(mode='clear') {
    const sel=this._sel,editor=this.activeEditor();
    if(!sel || !editor || !sel.table.isConnected || this.currentPath()!==sel.path)return;
    const info=this.tableSourceInfo(editor,sel.table);
    if(!info?.rowSources)return new Notice('TableTune: 无法定位表格，清空已取消');
    const selected=this.alignmentSelectionCells(sel),changes=[];
    const texts=info.grid.flatMap((row,r)=>row.filter((text,c)=>selected.has(r+','+c))
      .map(text=>this.stripTableIdentity(text).trim())).filter(Boolean);
    const unbold=mode==='bold' && texts.length>0 && texts.every(text=>/^\*\*[\s\S]*\*\*$/.test(text));
    const needsId=Array.from(selected).some(k=>k.startsWith('0,'));
    const uid=info.uid || (needsId?'m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8):null);
    for(let r=0;r<info.grid.length;r++){
      const row=info.rowSources[r],ranges=this.rowCellRanges(row.text);
      if(ranges.length!==info.grid[r].length)return new Notice('TableTune: 表格结构不完整，清空已取消');
      for(let c=0;c<ranges.length;c++){
        const range=ranges[c];
        let after=range.text;
        if(selected.has(r+','+c)){
          after='';
          if(mode==='bold'){
            const text=this.stripTableIdentity(range.text).trim(),already=/^\*\*[\s\S]*\*\*$/.test(text);
            after=!text?range.text:unbold?text.slice(2,-2):already?text:'**'+text+'**';
          }
        }
        if(r===0 && c===0 && uid)after=this.encodeInvisibleUid(uid)+this.stripTableIdentity(after);
        if(after!==range.text)changes.push({from:row.from+range.from,to:row.from+range.to,insert:after});
      }
    }
    if(!changes.length)return;
    this.dispatchTableChanges(editor,changes,info.toPos);
    const tid=uid?'u'+uid:sel.tid;
    if(tid!==sel.tid)this.adoptStableTableId(sel.table,sel.path,sel.tid,tid);
    const ordinal=this.tablePeers(sel.table).indexOf(sel.table);
    this.clearMergeSelection();
    this.persist();
    this.rekeyAfterSourceChange(sel.path,tid,ordinal,sel.table);
  }

  splitSelectedCell() {
    const sel = this._sel;
    if (!sel || sel.axis || !this.isMergeRegion(sel)) return;
    this.splitRegion(sel.path, sel.tid, {
      r: sel.r1, c: sel.c1, rowspan: sel.r2 - sel.r1 + 1, colspan: sel.c2 - sel.c1 + 1,
    });
  }

  // ---- table clipboard (separate from ordinary text editing) ----------
  clipboardSize(value) {
    if(typeof value!=='number' && (typeof value!=='string' || !/^\d+(?:\.\d+)?(?:px)?$/.test(value.trim())))return null;
    const size=parseFloat(value);
    return Number.isFinite(size) && size>0 && size<=100000 ? size+'px' : null;
  }

  clipboardLayout(table,path,tid,rows,cols) {
    const savedWidths=this.getWidths(path,tid,table.rows[0]?.cells.length || 0) || [];
    const savedHeights=this.getRowHeights(path,tid) || [];
    const tracks=table.classList.contains('tcr-grid-table') ? getComputedStyle(table).gridTemplateRows.split(' ') : [];
    const columns=Array.from(table.querySelector('colgroup')?.children || []);
    return {
      columnWidths:cols.map(c=>this.clipboardSize(columns[c]?.getBoundingClientRect().width) ||
        this.clipboardSize(columns[c]?.style.width) || this.clipboardSize(savedWidths[c]) ||
        this.clipboardSize(Array.from(table.rows).map(row=>row.cells[c]).find(cell=>cell && !cell.classList.contains('tcr-merged-hidden') && cell.colSpan===1)?.getBoundingClientRect().width)),
      rowHeights:rows.map(r=>this.clipboardSize(tracks[r]) || this.clipboardSize(table.rows[r]?.getBoundingClientRect().height) || this.clipboardSize(savedHeights[r])),
    };
  }

  handleTableCopy(e) {
    const editor=this.activeEditor();
    const whole=editor?.cm?.dom?.querySelector('.cm-table-widget.is-selected table[data-tcr]');
    const sel=this._sel || (whole && {table:whole,path:whole.dataset.tcrPath,tid:this.tableId(whole),r1:0,c1:0,r2:whole.rows.length-1,c2:whole.rows[0].cells.length-1});
    if(!sel || !sel.table.isConnected || sel.path!==this.currentPath() || !e.clipboardData ||
      e.target?.closest?.('input,textarea,.modal'))return false;
    const root=sel.table.closest('.cm-content'),targetRoot=e.target?.closest?.('.cm-content');
    if(root&&targetRoot&&!root.contains(e.target))return false;
    const info=editor && this.tableSourceInfo(editor,sel.table);
    if(!info)return false;
    const rows=sel.axis==='row'?[...sel.indices].sort((a,b)=>a-b):Array.from({length:sel.r2-sel.r1+1},(_,i)=>sel.r1+i);
    const cols=sel.axis==='column'?[...sel.indices].sort((a,b)=>a-b):Array.from({length:sel.c2-sel.c1+1},(_,i)=>sel.c1+i);
    const regions=this.effectiveMerges(sel.table,sel.path,sel.tid);
    const complete=regions.filter(m=>
      Array.from({length:m.rowspan},(_,i)=>m.r+i).every(r=>rows.includes(r)) &&
      Array.from({length:m.colspan},(_,i)=>m.c+i).every(c=>cols.includes(c)));
    const grid=rows.map(r=>cols.map(c=>{
      const m=regions.find(m=>this.regionContains(m,r,c));
      return m&&!complete.includes(m)?'':this.stripTableIdentity(info.grid[r]?.[c] || '');
    }));
    const merges=complete
      .map(m=>({r:rows.indexOf(m.r),c:cols.indexOf(m.c),rowspan:m.rowspan,colspan:m.colspan}));
    const layout=this.clipboardLayout(sel.table,sel.path,sel.tid,rows,cols);
    const alignment=cols.map(()=>null),payload={version:2,rows:grid,merges,...layout};
    const plain=grid.map(row=>row.map(v=>{
      const text=this.sourceCellText(v.replace(/<br\s*\/?>/gi,'\n'));
      return /[\t\n"]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
    }).join('\t')).join('\n');
    const html=document.createElement('table');
    html.style.tableLayout='fixed';html.style.borderCollapse='collapse';
    const colgroup=html.appendChild(document.createElement('colgroup'));
    layout.columnWidths.forEach(width=>{const col=colgroup.appendChild(document.createElement('col'));if(width)col.style.width=width;});
    if(layout.columnWidths.every(Boolean))html.style.width=layout.columnWidths.reduce((sum,w)=>sum+parseFloat(w),0)+'px';
    grid.forEach((row,r)=>{const tr=html.insertRow();if(layout.rowHeights[r])tr.style.height=layout.rowHeights[r];row.forEach((value,c)=>{
      const m=merges.find(m=>this.regionContains(m,r,c));if(m&&(m.r!==r||m.c!==c))return;
      const td=tr.insertCell();if(m){td.rowSpan=m.rowspan;td.colSpan=m.colspan;}
      value.split(/<br\s*\/?>/gi).forEach((part,i)=>{if(i)td.appendChild(document.createElement('br'));td.appendChild(document.createTextNode(this.sourceCellText(part)));});
    });});
    try {
      e.clipboardData.setData('text/plain',plain);
      e.clipboardData.setData('text/html',html.outerHTML);
      e.clipboardData.setData('obsidian/table',JSON.stringify({rows:grid,alignment}));
      e.clipboardData.setData('application/x-table-tune',JSON.stringify(payload));
    }catch(error){return false;}
    e.preventDefault();e.stopImmediatePropagation();return true;
  }

  clipboardTable(data,allowSingle=false) {
    const valid=payload=>{
      const rows=payload?.rows;
      if(!Array.isArray(rows)||!rows.length||rows.length>1000)return null;
      const width=Math.max(...rows.map(row=>Array.isArray(row)?row.length:0));
      if(!width||width>1000||width*rows.length>100000||rows.some(row=>!Array.isArray(row)||row.some(v=>typeof v!=='string')))return null;
      const grid=rows.map(row=>Array.from({length:width},(_,c)=>this.stripTableIdentity(row[c] || '').replace(/\r?\n/g,'<br>')));
      const merges=this.validMergeRegions({rows:grid.map(cells=>({cells}))},Array.isArray(payload.merges)?payload.merges.slice(0,grid.length*width):[]);
      const sizes=(values,count)=>Array.from({length:count},(_,i)=>this.clipboardSize(Array.isArray(values)?values[i]:null));
      return {rows:grid,merges,columnWidths:sizes(payload.columnWidths,width),rowHeights:sizes(payload.rowHeights,grid.length)};
    };
    for(const type of ['application/x-table-tune','obsidian/table']){
      const raw=data.getData(type);if(raw)try{const parsed=valid(JSON.parse(raw));if(parsed)return parsed;}catch(error){}
    }
    const html=data.getData('text/html');
    if(html){
      const doc=new DOMParser().parseFromString(html,'text/html'),table=doc.querySelector('table');
      if(table){
        const rows=[],merges=[],columnWidths=[],rowHeights=[];let invalid=false;
        table.querySelectorAll('colgroup > col').forEach(col=>{
          if(col.closest('table')!==table)return;
          const size=this.clipboardSize(col.style.width || col.getAttribute('width'));
          for(let i=0;i<Math.min(1000,col.span||1) && columnWidths.length<1000;i++)columnWidths.push(size);
        });
        Array.from(table.rows).filter(tr=>tr.closest('table')===table).forEach((tr,r)=>{
          if(r>=1000){invalid=true;return;}rows[r] ||= [];let c=0;
          rowHeights[r]=this.clipboardSize(tr.style.height || tr.getAttribute('height'));
          Array.from(tr.cells).forEach(cell=>{
            while(rows[r][c]!==undefined)c++;
            const rs=Math.min(1000,cell.rowSpan||1),cs=Math.min(1000,cell.colSpan||1);
            if(c+cs>1000||r+rs>1000||(r+rs)*(c+cs)>100000){invalid=true;return;}
            const cellWidth=this.clipboardSize(cell.style.width || cell.getAttribute('width'));
            if(cellWidth && cs===1 && !columnWidths[c])columnWidths[c]=cellWidth;
            if(rs===1 && !rowHeights[r])rowHeights[r]=this.clipboardSize(cell.style.height || cell.getAttribute('height'));
            const copy=cell.cloneNode(true);copy.querySelectorAll('script,style').forEach(n=>n.remove());
            copy.querySelectorAll('br').forEach(br=>br.replaceWith('\n'));
            copy.querySelectorAll('p,div,li').forEach(block=>block.appendChild(doc.createTextNode('\n')));
            rows[r][c]=copy.textContent.trim().replace(/\r?\n/g,'<br>');
            if(rs>1||cs>1)merges.push({r,c,rowspan:rs,colspan:cs});
            for(let rr=r;rr<r+rs;rr++){rows[rr] ||= [];for(let cc=c;cc<c+cs;cc++)if(rr!==r||cc!==c)rows[rr][cc]='';}
            c+=cs;
          });
        });
        if(!invalid)return valid({rows,merges,columnWidths,rowHeights});return null;
      }
    }
    const text=data.getData('text/plain');
    const markdown=data.getData('text/markdown') || text;
    if(markdown){
      const lines=markdown.trim().split(/\r?\n/);
      if(lines.length>=2&&this.isTableRowLine(lines[0])&&this.isSepLine(lines[1])&&lines.slice(2).every(line=>this.isTableRowLine(line)))
        return valid({rows:[this.splitRow(lines[0]),...lines.slice(2).map(line=>this.splitRow(line))]});
    }
    if(!text || (!allowSingle&&!text.includes('\t')))return null;
    // Quoted TSV preserves spreadsheet cells containing line breaks/tabs.
    const rows=[[]];let value='',quoted=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i];
      if(ch==='"' && (quoted || value==='')){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&(ch==='\t'||ch==='\n'||ch==='\r')){
        rows.at(-1).push(value);value='';if(ch!=='\t'){if(ch==='\r'&&text[i+1]==='\n')i++;rows.push([]);}
      }else value+=ch;
    }
    if(quoted)return null;
    rows.at(-1).push(value);if(rows.length>1&&rows.at(-1).length===1&&rows.at(-1)[0]==='')rows.pop();
    return valid({rows});
  }

  handleTablePaste(e) {
    if(!e.clipboardData||e.target?.closest?.('input,textarea,.modal'))return false;
    const cell=e.target?.closest?.('td,th'),targetTable=cell?.closest('table[data-tcr]');
    const sel=this._sel&&(!targetTable||targetTable===this._sel.table)?this._sel:null,table=targetTable || sel?.table;
    if(!table)return this.pasteNewClipboardTable(e);
    if(!table.isConnected || table.closest('.cm-table-widget.is-selected'))return false;
    const root=table.closest('.cm-content'),targetRoot=e.target?.closest?.('.cm-content');
    if(root&&targetRoot&&!root.contains(e.target))return false;
    const path=table.dataset.tcrPath || this.currentPath(),editor=this.activeEditor();
    if(!editor || path!==this.currentPath())return false;
    const payload=this.clipboardTable(e.clipboardData,!!sel);if(!payload)return false;
    // Once identified as a matrix, never fall through to native single-cell
    // text paste if source verification or merge checks fail.
    e.preventDefault();e.stopImmediatePropagation();
    const info=this.tableSourceInfo(editor,table);
    if(!info){new Notice('TableTune: 无法定位表格源码，粘贴已取消');return true;}
    const r=sel?sel.r1:this.cellRow(cell),c=sel?sel.c1:this.cellCol(cell);
    if(r<0||c<0)return true;
    const height=payload.rows.length,width=payload.rows[0].length,oldTid=info.uid?'u'+info.uid:(sel?.tid || this.tableId(table));
    const regions=this.effectiveMerges(table,path,oldTid).map(m=>({...m}));
    const overlaps=m=>m.r<r+height&&m.r+m.rowspan>r&&m.c<c+width&&m.c+m.colspan>c;
    if(regions.some(m=>overlaps(m)&&!(r<=m.r&&c<=m.c&&r+height>=m.r+m.rowspan&&c+width>=m.c+m.colspan))){
      new Notice('TableTune: 粘贴范围只覆盖了部分合并单元格，请先拆分或选择完整区域');return true;
    }
    const grid=info.grid.map(row=>row.slice()),cols=Math.max(grid[0].length,c+width),rows=Math.max(grid.length,r+height);
    if(rows*cols>100000){new Notice('TableTune: 粘贴范围过大');return true;}
    while(grid.length<rows)grid.push([]);grid.forEach(row=>{while(row.length<cols)row.push('');});
    const escape=value=>value.replace(/(?<!\\)\|/g,'\\|');
    payload.rows.forEach((row,rr)=>row.forEach((value,cc)=>grid[r+rr][c+cc]=escape(value)));
    grid[0]=grid[0].map(value=>this.stripTableIdentity(value));
    const uid=info.uid || ('m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8)),tid='u'+uid;
    grid[0][0]=this.encodeInvisibleUid(uid)+grid[0][0];
    const sep=this.splitRow(info.sep);while(sep.length<cols)sep.push('---');
    const text=[this.buildRow(grid[0]),this.buildRow(sep),...grid.slice(1).map(row=>this.buildRow(row))].join('\n');
    try{this.replaceTableRange(editor,text,info.toPos(info.from),info.toPos(info.to));}
    catch(error){new Notice('TableTune: 表格粘贴失败');return true;}
    for(const store of [this.widths,this.rowHeights,this.alignments,this.cellStyles,this.tableOptions])if(store?.[path]?.[oldTid]!==undefined){store[path][tid]=JSON.parse(JSON.stringify(store[path][oldTid]));}
    this.merges[path] ||= {};this.merges[path][tid]=regions.filter(m=>!overlaps(m)).concat(payload.merges.map(m=>({...m,r:r+m.r,c:c+m.c})));
    this.tableDims[path] ||= {};this.tableDims[path][tid]={rows,cols};
    const widths=(this.getWidths(path,tid,cols)||[]).slice();while(widths.length<cols)widths.push('80px');
    payload.columnWidths.forEach((size,i)=>{if(size)widths[c+i]=size;});this.setWidths(path,tid,widths);
    const heights=(this.getRowHeights(path,tid)||[]).slice();while(heights.length<rows)heights.push(null);
    payload.rowHeights.forEach((size,i)=>{if(size)heights[r+i]=size;});this.setRowHeights(path,tid,heights);
    this.clearMergeSelection();this.persist();
    this.rekeyAfterSourceChange(path,tid,Math.max(0,this.tablePeers(table).indexOf(table)),table);
    return true;
  }

  pasteNewClipboardTable(e) {
    const editor=this.activeEditor(),root=e.target?.closest?.('.cm-content');
    if(!editor?.getCursor || !root || !editor.cm?.dom?.contains(e.target))return false;
    const payload=this.clipboardTable(e.clipboardData);if(!payload)return false;
    const from=editor.getCursor('from'),to=editor.getCursor('to'),path=this.currentPath();
    // Never replace an ordinary text selection spanning existing tables.
    const doc=editor.getDoc(),line=i=>doc.getLine(i);
    for(let i=from.line;i<=to.line;i++)if(this.isTableRowLine(line(i)))return false;
    e.preventDefault();e.stopImmediatePropagation();
    const uid='m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8),tid='u'+uid;
    const grid=payload.rows.map(row=>row.map(text=>text.replace(/(?<!\\)\|/g,'\\|')));
    grid[0][0]=this.encodeInvisibleUid(uid)+grid[0][0];
    const text=[this.buildRow(grid[0]),this.buildRow(grid[0].map(()=> '---')),...grid.slice(1).map(row=>this.buildRow(row))].join('\n');
    const before=line(from.line).slice(0,from.ch),after=line(to.line).slice(to.ch);
    // A real Markdown header is the first copied row, not a blank header added
    // by the native HTML converter. Separate the table from surrounding prose.
    const prefix=before?'\n\n':from.line>0 && line(from.line-1).trim()?'\n':'';
    const suffix=after?'\n\n':'\n';
    try{this.replaceTableRange(editor,prefix+text+suffix,from,to);}
    catch(error){new Notice('TableTune: 表格粘贴失败');return true;}
    this.setWidths(path,tid,payload.columnWidths.map(size=>size || '80px'));
    this.setRowHeights(path,tid,payload.rowHeights);
    this.merges[path] ||= {};this.merges[path][tid]=payload.merges;
    this.tableDims[path] ||= {};this.tableDims[path][tid]={rows:grid.length,cols:grid[0].length};
    this.clearMergeSelection();this.persist();this.rekeyAfterSourceChange(path,tid,0,null);
    return true;
  }

  // ---- cell selection (drag like a spreadsheet) ------------------------
  resetNativeCellSelection(table) {
    const session=this.activeEditor()?.editorComponent?.tableCell,native=session?.table;
    if(!native || native.tableEl!==table)return;
    const hadRange=!!(native.selectionAnchor || native.selectionHead || native.selectedCells?.length);
    if(!hadRange && session.cm?.state?.readOnly!==true)return;
    // Removing CSS paint does not release Obsidian's read-only cell editor.
    // Use its own deselection path, then clear orphaned anchors as well (the
    // native implementation skips cleanup when selectedCells is already empty).
    if(typeof native.deselectCells==='function')native.deselectCells();
    native.selectionAnchor=null;native.selectionHead=null;
    native.containerEl?.classList?.remove('has-selection');
    if(typeof native.updateCellReadonly==='function')native.updateCellReadonly();
    // Native updateCellReadonly is debounced. Release it immediately so the
    // very first click can place a caret instead of waiting for another click.
    if(typeof session.setReadonly==='function')session.setReadonly(false);
  }

  bindNativeTableSelection(table) {
    const native = this.activeEditor()?.editorComponent?.tableCell?.table;
    if (!native || native.tableEl !== table || typeof native.selectCells !== 'function' || !native.getCellAt) return null;
    if (!this._nativeSelectionBindings) this._nativeSelectionBindings = new Map();
    // The editor may replace its native controller without replacing the DOM.
    // Retire wrappers belonging to previous controllers instead of retaining
    // every old editor/selection through this map for the life of the note.
    for(const [previous,binding] of this._nativeSelectionBindings){
      if(!binding.table.isConnected || previous.tableEl!==binding.table ||
        (binding.table===table && previous!==native))this.releaseNativeSelectionBinding(previous,binding);
    }
    const existing=this._nativeSelectionBindings.get(native);
    if (existing) return native;
    const plugin=this,original=native.selectCells,originalFocus=native.setCellFocus;
    const wrapped=function(anchor,head,...args) {
      if(plugin.ownsCellTextRange(table)){
        plugin.resetNativeCellSelection(table);return;
      }
      // A completed pointer range remains authoritative until the next user
      // gesture. Native mouseup/RAF callbacks may still carry an older anchor.
      const owned=plugin._pointerRange;
      if(owned && owned===plugin._sel && owned.table===table){
        const first=this.getCellAt(owned.r1,owned.c1),last=this.getCellAt(owned.r2,owned.c2);
        if(first && last)return original.call(this,first,last,...args);
        return;
      }
      // Only an explicit keyboard range gesture may import a native range.
      // Source edits/merge rerenders can replay an obsolete native anchor.
      if(table._tcrNativeRangeBlocked && anchor!==head)return;
      if (plugin._drag?.table===table && plugin._drag.textPending) return;
      if (!table.isConnected || !anchor || !head || anchor===head) return original.call(this,anchor,head,...args);
      const path=table.dataset.tcrPath || plugin.currentPath(),tid=plugin.tableId(table);
      const cells=plugin.completeSelectionCells(table,path,tid,anchor.row,anchor.col,head.row,head.col);
      const points=Array.from(cells,key=>key.split(',').map(Number));
      const r1=Math.min(...points.map(p=>p[0])),r2=Math.max(...points.map(p=>p[0]));
      const c1=Math.min(...points.map(p=>p[1])),c2=Math.max(...points.map(p=>p[1]));
      const first=this.getCellAt(r1,c1),last=this.getCellAt(r2,c2);
      if (!first || !last) return original.call(this,anchor,head,...args);
      const result=original.call(this,first,last,...args);
      if (!(plugin._sel?.table===table && plugin._sel.axis)) plugin.selectRect(table,r1,c1,r2,c2,path,tid);
      return result;
    };
    const focusWrapped=typeof originalFocus==='function'?function(...args){
      const text=plugin.ownsCellTextRange(table);
      // Native click/end callbacks may refocus the cell twice after release.
      // An already-active cell editor owns its text range; do not rebuild it
      // or replace that range with stale pointer coordinates.
      if(text?.cm)return;
      const result=originalFocus.apply(this,args);
      if(text){const captured=plugin.captureCellTextRange(text);if(captured)plugin._textRange=captured;}
      return result;
    }:null;
    native.selectCells=wrapped;
    if(focusWrapped)native.setCellFocus=focusWrapped;
    this._nativeSelectionBindings.set(native,{table,original,wrapped,originalFocus,focusWrapped});
    return native;
  }

  unbindNativeTableSelection(table) {
    if (!this._nativeSelectionBindings) return;
    for (const [native,binding] of this._nativeSelectionBindings) {
      if (binding.table!==table) continue;
      this.releaseNativeSelectionBinding(native,binding);
    }
  }

  releaseNativeSelectionBinding(native,binding) {
    if (native.selectCells===binding.wrapped) native.selectCells=binding.original;
    if(binding.focusWrapped && native.setCellFocus===binding.focusWrapped)native.setCellFocus=binding.originalFocus;
    this._nativeSelectionBindings.delete(native);
  }

  setupCellSelection(table, path, tid) {
    if (table._tcrSelectionCleanup) return;
    table._tcrNativeRangeBlocked=true;
    table.querySelectorAll('.is-selected').forEach(cell=>cell.classList.remove('is-selected'));
    // Obsidian can establish selection through mouse/keyboard handlers after
    // our pointer event, or replace the table DOM entirely. Reconcile its raw
    // physical-cell selection with merged logical rectangles as well.
    let nativeFrame = 0;
    const syncNative = () => {
      if (nativeFrame) return;
      nativeFrame = requestAnimationFrame(() => {
        nativeFrame = 0;
        if(table._tcrNativeRangeBlocked){
          if(!this._sel || this._sel.table!==table)this.resetNativeCellSelection(table);
          table.querySelectorAll('.is-selected').forEach(cell=>cell.classList.remove('is-selected'));
          return;
        }
        if (!table.isConnected || (this._pointerRange===this._sel && this._sel?.table===table) || (this._drag?.table===table && (this._drag.active || this._drag.textPending)) || (this._sel?.table===table && this._sel.axis)) return;
        const native=this.bindNativeTableSelection(table);
        // Correct native bounds too (copy/delete/keyboard must agree with paint).
        if (native?.selectionAnchor && native.selectionHead && native.selectionAnchor!==native.selectionHead) {
          native.selectCells(native.selectionAnchor,native.selectionHead);
          return;
        }
        const cells = Array.from(table.querySelectorAll('td.is-selected, th.is-selected'));
        if (!cells.length) return;
        // A focused merged cell is not a range. Its covered physical cells
        // share one visible owner, so count owners rather than native nodes.
        const merges=this.effectiveMerges(table,table.dataset.tcrPath || path,this.tableId(table));
        const owners=new Set(cells.map(cell=>{
          const r=this.cellRow(cell),c=this.cellCol(cell),m=merges.find(m=>this.regionContains(m,r,c));
          return m ? m.r+','+m.c : r+','+c;
        }));
        if (owners.size===1) return;
        const rows=cells.map(c=>this.cellRow(c)), cols=cells.map(c=>this.cellCol(c));
        this.selectRect(table,Math.min(...rows),Math.min(...cols),Math.max(...rows),Math.max(...cols),
          table.dataset.tcrPath || path,this.tableId(table));
      });
    };
    const nativeObserver = new MutationObserver(records => {
      if (records.some(record => record.target.matches('td,th') &&
        /(?:^|\s)is-selected(?:\s|$)/.test(record.oldValue || '') !== record.target.classList.contains('is-selected'))) syncNative();
    });
    nativeObserver.observe(table,{subtree:true,attributes:true,attributeFilter:['class'],attributeOldValue:true});
    const shiftMouse = e => {
      if (e.target.closest('.tcr-handle,.tt-row-handle')) return;
      if (e.shiftKey && e.target.closest('td,th')?.closest('table')===table) {
        e.preventDefault();e.stopImmediatePropagation();
      }
    };
    const axisDown = e => {
      const handle = e.target.closest('.table-row-drag-handle, .table-col-drag-handle');
      if (!handle || e.button !== 0) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.selectTableAxis(table, handle, e);
    };
    const cellDown = e => {
      // Column resizing owns the entire gesture, even while the pointer is
      // over cell text. Do not install a competing range/text drag listener.
      if (e.target.closest('.tcr-handle,.tt-row-handle')) return;
      const cell = e.target.closest('td,th');
      if (e.button !== 0 || !cell || cell.closest('table') !== table) return;
      if (e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); }
      this.startCellDrag(e, table, cell, table.dataset.tcrPath || path, this.tableId(table));
    };
    const contextMenu = e => {
      const handle = e.target.closest('.table-row-drag-handle, .table-col-drag-handle');
      const cell = e.target.closest('td,th');
      if (!cell || cell.closest('table') !== table) return;
      const path = table.dataset.tcrPath || this.currentPath(), tid = this.tableId(table);
      e.preventDefault(); e.stopImmediatePropagation();
      if (handle) this.selectTableAxis(table, handle, e, true);
      else {
        const pos = this.logicalPointInCell(table, cell, e.clientX, e.clientY, path, tid);
        const sel = this._sel;
        if (!sel || sel.table !== table || pos.r < sel.r1 || pos.r > sel.r2 || pos.c < sel.c1 || pos.c > sel.c2)
          this.selectRect(table, pos.r, pos.c, pos.r, pos.c, path, tid);
      }
      this.refreshMergeToolbar();
    };
    table.addEventListener('pointerdown', axisDown, true);
    table.addEventListener('pointerdown', cellDown, true);
    table.addEventListener('mousedown',shiftMouse,true);
    table.addEventListener('contextmenu', contextMenu, true);
    const releaseIntent=e=>{
      // Toolbar/axis actions still need the established range. Ordinary cell
      // pointerdown clears it in startCellDrag; only Shift navigation imports
      // native keyboard ranges, never an unrelated key or late callback.
      if(e.type==='keydown'){
        if(['Delete','Backspace'].includes(e.key) && this.ownsCellTextRange(table)?.cm)this._textRange.keepCaret=true;
        if(!['Delete','Backspace','Control','Meta','Shift','Alt'].includes(e.key))this._textRange=null;
        if(e.shiftKey && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(e.key) &&
          (table.contains(e.target) || this.activeEditor()?.editorComponent?.tableCell?.table?.tableEl===table)){
          this._pointerRange=null;table._tcrNativeRangeBlocked=false;
        }
      }else {this._pointerRange=null;this._textRange=null;}
    };
    const releaseMouse=e=>{
      if(this._pointerRange===this._sel && this._sel?.table===table){e.preventDefault();e.stopImmediatePropagation();}
    };
    // Consume compatibility events from the completed drag only. A genuine
    // next click begins with pointerdown and releases ownership first.
    window.addEventListener('click',releaseMouse,true);
    window.addEventListener('pointerdown',releaseIntent,true);
    window.addEventListener('keydown',releaseIntent,true);
    table._tcrSelectionCleanup = () => {
      if(this._drag?.table===table && this._cellDragCleanup)this._cellDragCleanup();
      if(this._textRange?.table===table)this._textRange=null;
      if(this._cellSelectionAnchor?.table===table)this._cellSelectionAnchor=null;
      window.removeEventListener('click',releaseMouse,true);
      window.removeEventListener('pointerdown',releaseIntent,true);
      window.removeEventListener('keydown',releaseIntent,true);
      this.unbindNativeTableSelection(table);
      nativeObserver.disconnect();
      if (nativeFrame) cancelAnimationFrame(nativeFrame);
      table.removeEventListener('pointerdown', axisDown, true);
      table.removeEventListener('pointerdown', cellDown, true);
      table.removeEventListener('mousedown',shiftMouse,true);
      table.removeEventListener('contextmenu', contextMenu, true);
      const rails=table._tcrAxisRails || [];
      rails.forEach(rail=>this.removeAxisRail(rail));
      if(this._axisRails)this._axisRails=this._axisRails.filter(rail=>!rails.includes(rail));
      delete table._tcrAxisRails;
      delete table._tcrSelectionCleanup;
    };
    if (!this._selectionTables) this._selectionTables = new Set();
    this._selectionTables.add(table);
    this.setupAxisRails(table);
    this.bindNativeTableSelection(table);
    this.resetNativeCellSelection(table);
    if (table.querySelector('.is-selected')) syncNative();
  }

  // Native handles live in cells that may be hidden by a rowspan/colspan.
  // Independent logical-axis rails keep every row and column reachable.
  setupAxisRails(table) {
    if (table._tcrAxisRails?.every(rail=>rail.parentElement===table.parentElement && rail.isConnected)) return;
    if(table._tcrAxisRails){
      const stale=table._tcrAxisRails;
      stale.forEach(rail=>this.removeAxisRail(rail));
      if(this._axisRails)this._axisRails=this._axisRails.filter(rail=>!stale.includes(rail));
    }
    table._tcrAxisRails = [];
    if (!this._axisRails) this._axisRails = [];
    const host = table.parentElement;
    for (const axis of ['row','column','insert','row-insert']) {
      const rail = document.createElement('div');
      rail.className = 'tcr-axis-rail tcr-axis-' + (axis === 'insert' ? 'insertions' : axis === 'row-insert' ? 'row-insertions' : axis);
      rail._tcrTable = table;
      if (getComputedStyle(host).position === 'static') {
        rail._tcrHostPosition = host.style.position;
        host.style.position = 'relative';
      }
      rail.addEventListener('pointerdown', e => {
        if(this._columnDragCleanup){e.preventDefault();e.stopImmediatePropagation();return;}
        const insert = e.target.closest('.tcr-axis-insert');
        if (insert && e.button === 0) {
          e.preventDefault(); e.stopImmediatePropagation();
          this.insertTableAxis(table,insert.dataset.tcrInsertAxis,Number(insert.dataset.tcrIndex)); return;
        }
        const h = e.target.closest('.tcr-axis-pick');
        if (!h || e.button !== 0) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.selectTableAxis(table, h, e);
      });
      rail.addEventListener('contextmenu', e => {
        const h = e.target.closest('.tcr-axis-pick');
        if (!h) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.selectTableAxis(table, h, e, true);
        this.refreshMergeToolbar();
      });
      host.appendChild(rail); table._tcrAxisRails.push(rail); this._axisRails.push(rail);
    }
    this.positionAxisRails(table);
  }

  removeAxisRail(rail) {
    if (rail._tcrHostPosition !== undefined && rail.parentElement)
      rail.parentElement.style.position = rail._tcrHostPosition;
    rail.remove();
  }

  positionAxisRails(table) {
    if (!table._tcrAxisRails) return;
    const rect = table.getBoundingClientRect(), host = table.parentElement;
    const base = host.getBoundingClientRect(), css = getComputedStyle(table);
    const grid = table.classList.contains('tcr-grid-table');
    const rowSizes = grid ? css.gridTemplateRows.split(' ').map(parseFloat) :
      Array.from(table.rows, row => row.getBoundingClientRect().height);
    const cols = table.querySelector('colgroup');
    const colSizes = grid ? css.gridTemplateColumns.split(' ').map(parseFloat) :
      Array.from(table.rows[0]?.cells || [], (cell,i) => cols?.children[i]?.getBoundingClientRect().width || cell.getBoundingClientRect().width);
    for (const rail of table._tcrAxisRails) {
      const rowInsert=rail.classList.contains('tcr-axis-row-insertions');
      const row = rail.classList.contains('tcr-axis-row') || rowInsert, insert = rail.classList.contains('tcr-axis-insertions') || rowInsert;
      const sizes = insert ? [...(row?rowSizes:colSizes),0] : row ? rowSizes : colSizes;
      rail.style.setProperty('--tcr-table-height',rect.height+'px');
      rail.style.setProperty('--tcr-table-width',rect.width+'px');
      Object.assign(rail.style, {left:(rect.left-base.left+host.scrollLeft-host.clientLeft-(row?14:0))+'px',
        top:(rect.top-base.top+host.scrollTop-host.clientTop-(row?0:14))+'px',
        width:(row?14:colSizes.reduce((a,b)=>a+b,0))+'px', height:(row?rowSizes.reduce((a,b)=>a+b,0):14)+'px'});
      while (rail.children.length > sizes.length) rail.lastChild.remove();
      let offset = 0;
      sizes.forEach((size,i) => {
        let h = rail.children[i];
        if (!h) {
          h = document.createElement('div'); h.className = insert ? 'tcr-axis-insert' : 'tcr-axis-pick';
          h.dataset.tcrAxis = row ? 'row' : 'column'; h.dataset.tcrIndex = String(i);
          h.setAttribute('role','button'); rail.appendChild(h);
          if (insert) { h.textContent='+'; h.title=row?'插入行':'插入列';h.dataset.tcrInsertAxis=row?'row':'col'; }
        }
        h.setAttribute('aria-label', insert ? '在第 '+(i+1)+(row?' 行位置插入行':' 列位置插入列') : (row?'选择行 ':'选择列 ')+(i+1));
        h.setAttribute('aria-pressed', String(this._sel?.table===table && this._sel.axis===(row?'row':'column') && this._sel.indices.has(i)));
        Object.assign(h.style, row ? {top:(offset-(insert?7:0))+'px',height:(insert?14:size)+'px',left:'0',width:'14px'} :
          {left:(offset-(insert?7:0))+'px',width:(insert?14:size)+'px',top:'0',height:'14px'});
        offset += size;
      });
    }
    if (this._sel?.table === table && this._sel.axis) this.highlightAxisSelection();
  }

  selectTableAxis(table, handle, event = {}, context = false) {
    const cell = handle.closest('td,th');
    if (!cell && !handle.dataset.tcrAxis) return;
    const axis = handle.dataset.tcrAxis || (handle.classList.contains('table-row-drag-handle') ? 'row' : 'column');
    const index = handle.dataset.tcrIndex !== undefined ? Number(handle.dataset.tcrIndex) :
      axis === 'row' ? this.cellRow(cell) : this.cellCol(cell);
    const old = this._sel;
    const compatible = old && old.table === table && old.axis === axis;
    if (context && compatible && old.indices.has(index)) return;
    let indices = new Set([index]);
    let anchor = index;
    if (compatible) {
      anchor = old.anchor;
      if (event.shiftKey) {
        indices = event.ctrlKey || event.metaKey ? new Set(old.indices) : new Set();
        for (let i = Math.min(anchor,index); i <= Math.max(anchor,index); i++) indices.add(i);
      } else if (event.ctrlKey || event.metaKey) {
        indices = new Set(old.indices);
        if (indices.has(index)) indices.delete(index); else indices.add(index);
        anchor = index;
      } else anchor = index;
    }
    const path = table.dataset.tcrPath || this.currentPath(), tid = this.tableId(table);
    const closedRectangle = !!event.shiftKey && !event.ctrlKey && !event.metaKey;
    if (closedRectangle && indices.size) {
      const first = Math.min(...indices), last = Math.max(...indices);
      const cells = this.completeSelectionCells(table,path,tid,
        axis==='row'?first:0, axis==='column'?first:0,
        axis==='row'?last:table.rows.length-1, axis==='column'?last:table.rows[0].cells.length-1);
      indices = new Set(Array.from(cells,key=>Number(key.split(',')[axis==='row'?0:1])));
    }
    this.clearMergeSelection();
    if (!indices.size) return;
    const first = Math.min(...indices), last = Math.max(...indices);
    this._sel = { table, path, tid, axis,
      indices, anchor,
      r1: axis === 'row' ? first : 0, r2: axis === 'row' ? last : table.rows.length - 1,
      c1: axis === 'column' ? first : 0, c2: axis === 'column' ? last : table.rows[0].cells.length - 1 };
    this.highlightAxisSelection();
    if (closedRectangle) this.highlightSelection();
    this.refreshMergeToolbar();
  }

  highlightAxisSelection() {
    const sel = this._sel;
    if (!sel || !sel.axis) return;
    const {table, indices, axis} = sel;
    table.classList.add('tcr-selection-owned');
    table.classList.remove('tcr-cell-editing');
    this.clearTableTextSelection(table);
    const merges = this.effectiveMerges(table, sel.path, sel.tid);
    for (let r = 0; r < table.rows.length; r++) for (let c = 0; c < table.rows[r].cells.length; c++) {
      const cell = table.rows[r].cells[c];
      if (cell.classList.contains('tcr-merged-hidden')) continue;
      const reg = merges.find(m => m.r === r && m.c === c);
      const start = axis === 'row' ? r : c;
      const span = reg ? (axis === 'row' ? reg.rowspan : reg.colspan) : 1;
      let selected = true;
      for (let i = start; i < start+span; i++) if (!indices.has(i)) selected = false;
      cell.classList.toggle('tcr-axis-cell-selected', selected);
    }
    this._axisHandles = [];
    const root = table.parentElement;
    root.querySelectorAll('.table-row-drag-handle, .table-col-drag-handle, .tcr-axis-pick').forEach(h => {
      if (h.closest('table') !== table && h.closest('.tcr-axis-rail')?._tcrTable !== table) return;
      const a = h.dataset.tcrAxis || (h.classList.contains('table-row-drag-handle') ? 'row' : 'column');
      const cell = h.closest('td,th');
      const i = h.dataset.tcrIndex !== undefined ? Number(h.dataset.tcrIndex) :
        a === 'row' ? this.cellRow(cell) : this.cellCol(cell);
      const selected = a === axis && indices.has(i) && (!table._tcrAxisRails || h.classList.contains('tcr-axis-pick'));
      h.classList.toggle('tcr-axis-selected', selected);
      if (h.classList.contains('tcr-axis-pick')) h.setAttribute('aria-pressed',String(selected));
      if (selected) this._axisHandles.push(h);
    });
  }

  cellDragText(cell) {
    // Ignore handles, hidden merge placeholders and CodeMirror decorations.
    const content=cell.querySelector('.cm-content,[contenteditable="true"],.table-cell-wrapper') || cell;
    const walker=cell.ownerDocument.createTreeWalker(content,4);
    let text='',node;
    while ((node=walker.nextNode())) {
      if (node.parentElement.closest('.table-row-drag-handle,.table-col-drag-handle,.cm-cursorLayer,.cm-selectionLayer,.tcr-merged-hidden')) continue;
      text+=node.nodeValue;
    }
    return text.replace(/[\u200b-\u200d\u2060-\u206f\ufeff]/g,'');
  }

  selectCellDragText(d, selectAll=false) {
    const session=this.activeEditor()?.editorComponent?.tableCell,cm=session?.cm;
    if (session?.table?.tableEl===d.table && cm?.contentDOM && d.cell.contains(cm.contentDOM)) {
      const length=cm.state.doc.length,range=cm.state.selection.main;
      if (selectAll) cm.dispatch({selection:{anchor:0,head:length}});
      return length>0 && (selectAll || (range.from===0 && range.to===length));
    }
    const selection=d.table.ownerDocument.defaultView.getSelection();
    if (!selection) return false;
    if (selectAll) {
      const range=d.table.ownerDocument.createRange();
      range.selectNodeContents(d.cell.querySelector('[contenteditable="true"],.table-cell-wrapper') || d.cell);
      selection.removeAllRanges();selection.addRange(range);
    }
    return d.cell.contains(selection.anchorNode) && d.cell.contains(selection.focusNode) &&
      selection.toString().replace(/\s/g,'')===this.cellDragText(d.cell).replace(/\s/g,'');
  }

  captureCellTextRange(d) {
    const session=this.activeEditor()?.editorComponent?.tableCell,cm=session?.cm;
    if(session?.table?.tableEl===d.table && d.cell.contains(cm?.contentDOM)){
      const range=cm.state.selection.main;
      if(range.from<range.to)return {table:d.table,cell:d.cell,session,cm};
      return null;
    }
    const selection=d.table.ownerDocument.defaultView.getSelection();
    if(selection && !selection.isCollapsed && d.cell.contains(selection.anchorNode) && d.cell.contains(selection.focusNode))
      return {table:d.table,cell:d.cell};
    return null;
  }

  ownsCellTextRange(table) {
    const text=this._textRange;
    if(!text || text.table!==table || !table.isConnected || !text.cell.isConnected)return null;
    const session=this.activeEditor()?.editorComponent?.tableCell;
    // Delete collapses the text range normally. Keep its resulting caret safe
    // from a pending native release callback until the next deliberate intent.
    if(text.keepCaret && text.cm && session===text.session && session.cm===text.cm && text.cell.contains(text.cm.contentDOM))return text;
    const current=this.captureCellTextRange(text);
    if(!current || (text.cm && current.cm!==text.cm))return null;
    return current;
  }

  startCellDrag(e, table, cell, path, tid) {
    // A pointerup can be lost when a window loses focus, a drag is cancelled,
    // or Live Preview replaces its widget. Never let callbacks from that
    // gesture keep handling movements intended for a subsequent gesture.
    if(this._cellDragCleanup)this._cellDragCleanup();
    this.bindNativeTableSelection(table);
    const start = this.logicalPointInCell(table, cell, e.clientX, e.clientY, path, tid);
    const previous = this._cellSelectionAnchor;
    const extending = e.shiftKey && previous?.table === table && previous.path === path && previous.tid === tid;
    const startR = extending ? previous.r : start.r, startC = extending ? previous.c : start.c;
    if (!extending) this._cellSelectionAnchor = {table,path,tid,r:startR,c:startC};
    if (!extending) {
      this.clearMergeSelection();
      // A previous merge may have replaced the DOM or cleared plugin state
      // while the native editor still owns a read-only range.
      this.resetNativeCellSelection(table);
      table.classList.add('tcr-cell-editing');
    }
    this._lastTableCell = { path, tid, r: startR, c: startC, time: Date.now() };
    this._drag = { table, cell, path, tid, startR, startC, endR: start.r, endC: start.c,
      textPending: !extending && !!this.cellDragText(cell).trim(),
      x: e.clientX, y: e.clientY, active: !!extending };
    const gesture=this._drag;
    if (extending) this.selectRect(table,startR,startC,start.r,start.c,path,tid);
    const onMove = (ev) => {
      const d = this._drag; if (d!==gesture) return;
      if(!table.isConnected){cancel();return;}
      if (d.textPending) {
        const rect=d.cell.getBoundingClientRect();
        const inside=ev.clientX>=rect.left && ev.clientX<=rect.right && ev.clientY>=rect.top && ev.clientY<=rect.bottom;
        // Let the cell editor/browser own dragging while inside the text cell.
        if (inside) { d.textExit=null;return; }
        ev.preventDefault();ev.stopImmediatePropagation();
        if (!d.textExit && !this.selectCellDragText(d)) {
          this.selectCellDragText(d,true);
          d.textExit={x:ev.clientX,y:ev.clientY};return;
        }
        if (d.textExit && Math.abs(ev.clientX-d.textExit.x)+Math.abs(ev.clientY-d.textExit.y)<6) return;
        d.textPending=false;
      }
      if (!d.active) {
        if (Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) < 6) return;
        d.active = true;
      }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      let endR = d.endR, endC = d.endC;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const tcell = target && target.closest('td,th');
      if (tcell && d.table.contains(tcell)) {
        const end = this.logicalPointInCell(d.table, tcell, ev.clientX, ev.clientY, d.path, d.tid);
        endR = end.r; endC = end.c;
      }
      d.endR = endR; d.endC = endC;
      this.selectRect(d.table, Math.min(d.startR, endR), Math.min(d.startC, endC),
        Math.max(d.startR, endR), Math.max(d.startC, endC), d.path, d.tid);
    };
    const onTextMouseMove = ev => {
      const d=this._drag;
      if (d!==gesture) return;
      const rect=d.cell.getBoundingClientRect();
      if (d.active || (d.textPending && (ev.clientX<rect.left || ev.clientX>rect.right || ev.clientY<rect.top || ev.clientY>rect.bottom))) {
        // The compatibility mousemove follows pointermove. Do not let the
        // native editor overwrite the completed text or cell selection.
        ev.preventDefault();ev.stopImmediatePropagation();
        if (d.textPending && d.textExit) requestAnimationFrame(()=>{
          if (this._drag===d && d.textPending && d.textExit) this.selectCellDragText(d,true);
        });
      }
    };
    const onUp = (ev) => {
      if(this._drag!==gesture){cleanup();return;}
      const d = gesture;cleanup();
      if (d && !d.active) {
        // Keep native click/focus handling intact so the caret can enter text.
        this.clearMergeSelection();
        if (d.textPending && d.textExit) this.selectCellDragText(d,true);
        this._textRange=this.captureCellTextRange(d);
      }
      if(d?.active){
        ev.preventDefault();ev.stopImmediatePropagation();
        this._pointerRange=this._sel;
        this.refreshMergeToolbar();
      }
    };
    const cleanup=()=>{
      window.removeEventListener('pointermove',onMove,true);
      window.removeEventListener('pointerup',onUp,true);
      window.removeEventListener('mousemove',onTextMouseMove,true);
      window.removeEventListener('pointercancel',cancel,true);
      window.removeEventListener('blur',onWindowBlur,true);
      if(this._drag===gesture)this._drag=null;
      if(this._cellDragCleanup===cleanup)this._cellDragCleanup=null;
    };
    const cancel=()=>{
      cleanup();
      if(this._sel?.table===table)this.clearMergeSelection();
    };
    const onWindowBlur=ev=>{if(ev.target===window)cancel();};
    this._cellDragCleanup=cleanup;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('mousemove', onTextMouseMove, true);
    window.addEventListener('pointercancel',cancel,true);
    window.addEventListener('blur',onWindowBlur,true);
  }

  logicalPointInCell(table, cell, x, y, path, tid) {
    let r = this.cellRow(cell), c = this.cellCol(cell);
    const reg = this.effectiveMerges(table, path, tid).find((m) => this.regionContains(m, r, c));
    if (!reg) return { r, c };

    // A rowspan/colspan is one DOM cell, but the pointer may be over any of its
    // logical rows/columns. Resolve that sub-position so the raw drag rectangle
    // does not accidentally include neighbouring ordinary cells.
    if (table.classList && table.classList.contains('tcr-grid-table')) {
      const rect = cell.getBoundingClientRect();
      const tracks = typeof getComputedStyle === 'function'
        ? getComputedStyle(table).gridTemplateRows.split(' ').map(parseFloat) : [];
      let edge = rect.top;
      for (let rr = reg.r; rr < reg.r + reg.rowspan; rr++) {
        const height = tracks[rr] || rect.height / reg.rowspan;
        if (y < edge + height || rr === reg.r + reg.rowspan - 1) { r = rr; break; }
        edge += height;
      }
    } else for (let rr = reg.r; rr < reg.r + reg.rowspan; rr++) {
      const row = table.rows[rr];
      const rect = row && row.getBoundingClientRect ? row.getBoundingClientRect() : null;
      if (rect && y >= rect.top && y <= rect.bottom) { r = rr; break; }
    }
    const colgroup = table.querySelector('colgroup');
    if (colgroup) {
      const cellRect = cell.getBoundingClientRect();
      let edge = cellRect.left;
      for (let cc = reg.c; cc < reg.c + reg.colspan; cc++) {
        const col = colgroup.children[cc];
        const width = (col && col.getBoundingClientRect().width) ||
          (col && col.style && parseFloat(col.style.width)) || cellRect.width / reg.colspan;
        if (x <= edge + width || cc === reg.c + reg.colspan - 1) { c = cc; break; }
        edge += width;
      }
    }
    return { r, c };
  }

  selectRect(table, r1, c1, r2, c2, path, tid) {
    // Repainting/replacing a range is not the same as cancelling it. Keep
    // the native keyboard range alive until a genuine clear or text click.
    this.clearMergeSelection(true);
    const cells = this.completeSelectionCells(table, path, tid, r1, c1, r2, c2);
    const points = Array.from(cells, (key) => key.split(',').map(Number));
    const rows = points.map((p) => p[0]), cols = points.map((p) => p[1]);
    this._sel = {
      table,
      r1: Math.min(...rows), c1: Math.min(...cols),
      r2: Math.max(...rows), c2: Math.max(...cols),
      cells, path, tid,
    };
    this.highlightSelection();
    this.refreshMergeToolbar();
  }

  // Keep the selection rectangular. When it touches a merged region, expand
  // the rectangle to that region's outer boundary; repeat because the larger
  // rectangle may encounter another merged region.
  completeSelectionCells(table, path, tid, r1, c1, r2, c2) {
    [r1, r2] = [Math.min(r1, r2), Math.max(r1, r2)];
    [c1, c2] = [Math.min(c1, c2), Math.max(c1, c2)];
    const merges = this.effectiveMerges(table, path, tid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of merges) {
        const mr2 = m.r + m.rowspan - 1, mc2 = m.c + m.colspan - 1;
        const touches = r1 <= mr2 && m.r <= r2 && c1 <= mc2 && m.c <= c2;
        if (!touches) continue;
        const nr1 = Math.min(r1, m.r), nc1 = Math.min(c1, m.c);
        const nr2 = Math.max(r2, mr2), nc2 = Math.max(c2, mc2);
        if (nr1 !== r1 || nc1 !== c1 || nr2 !== r2 || nc2 !== c2) changed = true;
        r1 = nr1; c1 = nc1; r2 = nr2; c2 = nc2;
      }
    }
    const cells = new Set();
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) cells.add(r + ',' + c);
    return cells;
  }

  selectionCells(sel) {
    if (sel.cells instanceof Set) return sel.cells;
    const cells = new Set();
    for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) cells.add(r + ',' + c);
    return cells;
  }

  selectionIsRectangle(sel) {
    return this.selectionCells(sel).size === (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1);
  }

  highlightSelection() {
    const sel = this._sel; if (!sel) return;
    sel.table.querySelectorAll('.tcr-sel').forEach((c) => c.classList.remove('tcr-sel'));
    // Selection edges existed in earlier 1.1.6 iterations. They are no longer
    // part of the design; clean stale DOM nodes before applying fill-only state.
    sel.table.querySelectorAll('.tcr-sel-edge').forEach((edge) => edge.remove());
    const selected = this.selectionCells(sel);
    for (const key of selected) {
      const [rr, cc] = key.split(',').map(Number);
      const cell = sel.table.rows[rr] && sel.table.rows[rr].cells[cc];
      if (!cell || cell.classList.contains('tcr-merged-hidden')) continue;
      cell.classList.add('tcr-sel');
    }
    // One outline for the completed logical rectangle. Native per-cell edge
    // classes describe the raw drag and cannot represent merged cell closure.
    sel.table.classList.add('tcr-selection-owned');
    sel.table.classList.remove('tcr-cell-editing');
    this.clearTableTextSelection(sel.table);
    const host = sel.table.parentElement;
    const overlay = document.createElement('div');
    overlay.className = 'tcr-selection-rect';
    overlay.setAttribute('aria-hidden', 'true');
    this._selectionHost = host;
    this._selectionHostPosition = host.style.position;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(overlay);
    this._selectionOverlay = overlay;
    this.positionSelectionOverlay();
  }

  clearTableTextSelection(table) {
    // Pointer dragging can leave a browser text range across empty-cell <br>s.
    // Clear only a non-collapsed range touching this explicitly selected table;
    // preserve editor focus/caret and unrelated document/window selections.
    const selection=table.ownerDocument?.defaultView?.getSelection();
    if (!selection || selection.isCollapsed) return;
    if (table.contains(selection.anchorNode) || table.contains(selection.focusNode)) selection.removeAllRanges();
  }

  positionSelectionOverlay() {
    const sel = this._sel, overlay = this._selectionOverlay, host = this._selectionHost;
    if (!sel || !overlay || !host) return;
    const rects = Array.from(sel.table.querySelectorAll('.tcr-sel'), c => c.getBoundingClientRect())
      .filter(r => r.width && r.height);
    if (!rects.length) return;
    const base = host.getBoundingClientRect();
    const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
    Object.assign(overlay.style, { left: (left-base.left+host.scrollLeft-host.clientLeft)+'px',
      top: (top-base.top+host.scrollTop-host.clientTop)+'px',
      width: (Math.max(...rects.map(r => r.right))-left)+'px',
      height: (Math.max(...rects.map(r => r.bottom))-top)+'px' });
  }

  clearMergeSelection(preserveNative=false) {
    this._pointerRange=null;
    this._textRange=null;
    const table=this._sel?.table;
    if(table){
      if(!preserveNative)this.resetNativeCellSelection(table);
      table._tcrNativeRangeBlocked=true;
      table.querySelectorAll('.is-selected').forEach(cell=>cell.classList.remove('is-selected'));
    }
    if (this._selectionOverlay) { this._selectionOverlay.remove(); this._selectionOverlay = null; }
    if (this._selectionHost) {
      this._selectionHost.style.position = this._selectionHostPosition;
      this._selectionHost = null;
    }
    if (this._axisHandles) {
      this._axisHandles.forEach(h => { h.classList.remove('tcr-axis-selected'); h.setAttribute('aria-pressed','false'); });
      this._axisHandles = null;
    }
    if (this._sel) {
      this._sel.table.classList.remove('tcr-selection-owned');
      this._sel.table.querySelectorAll('.tcr-axis-cell-selected').forEach(c => c.classList.remove('tcr-axis-cell-selected'));
      this._sel.table.querySelectorAll('.tcr-sel').forEach((c) => c.classList.remove('tcr-sel'));
      this._sel.table.querySelectorAll('.tcr-sel-edge').forEach((edge) => edge.remove());
      this._sel = null;
    }
    this.hideMergeToolbar();
  }

  // ---- floating Merge/Split toolbar -----------------------------------
  isMergeRegion(sel) {
    if (!sel) return false;
    const list = this.effectiveMerges(sel.table, sel.path, sel.tid);
    return list.some((m) =>
      m.r === sel.r1 && m.c === sel.c1 &&
      m.rowspan === sel.r2 - sel.r1 + 1 &&
      m.colspan === sel.c2 - sel.c1 + 1 && this.selectionIsRectangle(sel)
    );
  }

  refreshMergeToolbar() {
    const sel=this._sel;
    if(!sel || this._drag?.active || !sel.table.isConnected){this.hideMergeToolbar();return;}
    this.showMergeToolbar(true);
    const bar=this._toolbar;
    // Reuse the existing command definitions so counts, merge constraints,
    // disjoint axis selection and source-safe mutations stay identical.
    const actions=[];
    this.populateEditorMenu({addItem:build=>{
      const action={},item={setTitle:title=>{action.title=title;return item;},onClick:run=>{action.run=run;return item;},setChecked:checked=>{action.checked=checked;return item;}};
      build(item);actions.push(action);
    }});
    bar.replaceChildren();
    let previousGroup=null;
    for(const action of actions){
      const title=action.title,group=/顶部对齐|垂直居中|底部对齐/.test(title)?'vertical-align':/对齐/.test(title)?'align':/删除/.test(title)?'delete':/插入/.test(title)?'insert':'merge';
      if(previousGroup && previousGroup!==group){const sep=document.createElement('span');sep.className='tcr-toolbar-separator';sep.setAttribute('role','separator');bar.appendChild(sep);}
      previousGroup=group;
      const icon=title==='清空内容'?'eraser':title==='合并单元格'?'combine':title==='拆分单元格'?'split':
        title==='左对齐'?'align-left':title==='居中对齐'?'align-center':title==='右对齐'?'align-right':
        title==='顶部对齐'?'align-vertical-justify-start':title==='垂直居中'?'align-vertical-justify-center':title==='底部对齐'?'align-vertical-justify-end':
        /上方/.test(title)?'arrow-up-to-line':/下方/.test(title)?'arrow-down-to-line':
        /左侧/.test(title)?'arrow-left-to-line':/右侧/.test(title)?'arrow-right-to-line':/行/.test(title)?'rows-3':'columns-3';
      const button=document.createElement('button');button.type='button';button.className='tcr-toolbar-button';
      button.title=title;button.setAttribute('aria-label',title);button.dataset.icon=icon;
      if(action.checked!==undefined)button.setAttribute('aria-pressed',String(action.checked));
      if(group==='delete')button.classList.add('tcr-toolbar-danger');
      if(typeof setIcon==='function')setIcon(button,icon);
      button.addEventListener('click',e=>{e.stopPropagation();if(this._sel!==sel)return;action.run();this.refreshMergeToolbar();});
      bar.appendChild(button);
    }
    this.positionMergeToolbar(sel);
  }

  showMergeToolbar(show) {
    if (!this._toolbar) {
      this._toolbar = document.createElement('div');
      this._toolbar.className = 'tcr-merge-toolbar';
      this._toolbar.setAttribute('role','toolbar');
      this._toolbar.setAttribute('aria-label','表格操作');
      // Keep the editor selection and active leaf when clicking a command.
      this._toolbar.addEventListener('pointerdown', (e) => e.preventDefault());
      document.body.appendChild(this._toolbar);
    }
    this._toolbar.style.display = show ? 'flex' : 'none';
  }

  hideMergeToolbar() {
    if (this._toolbar) this._toolbar.style.display = 'none';
  }

  positionMergeToolbar(sel) {
    if (!this._toolbar || this._toolbar.style.display==='none') return;
    let rect = null;
    for (const key of this.selectionCells(sel)) {
        const [rr, cc] = key.split(',').map(Number);
        const cell = sel.table.rows[rr] && sel.table.rows[rr].cells[cc];
        if (!cell || cell.classList.contains('tcr-merged-hidden')) continue;
        const r = cell.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) continue;
        if (!rect) rect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        else {
          rect.top = Math.min(rect.top, r.top);
          rect.bottom = Math.max(rect.bottom, r.bottom);
          rect.left = Math.min(rect.left, r.left);
          rect.right = Math.max(rect.right, r.right);
        }
      }
    if (!rect) return;
    const toolbarWidth = this._toolbar.offsetWidth || 300;
    const toolbarHeight = this._toolbar.offsetHeight || 40;
    this._toolbar.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - toolbarWidth - 4)) + 'px';
    const tableRect=sel.table.getBoundingClientRect();
    if(tableRect.bottom<0 || tableRect.top>window.innerHeight){this._toolbar.style.visibility='hidden';return;}
    this._toolbar.style.visibility='';
    const top=tableRect.top-toolbarHeight-24;
    this._toolbar.style.top = Math.max(4,Math.min(top>=4?top:tableRect.bottom+14,window.innerHeight-toolbarHeight-4))+'px';
  }

  // ---- native right-click menu (injected into Obsidian's editor menu) ---
  populateEditorMenu(menu) {
    const sel = this._sel;
    if(sel)menu.addItem(item=>{item.setTitle('清空内容');item.onClick(()=>this.clearSelectedCellContents());});
    if (sel && sel.axis) {
      menu.addItem(item => {
        const count = sel.indices.size;
        item.setTitle(sel.axis === 'row' ? (count === 1 ? '删除行' : `删除 ${count} 行`) : (count === 1 ? '删除列' : `删除 ${count} 列`));
        item.onClick(() => sel.axis === 'row' ? this.deleteSelectedRows() : this.deleteSelectedColumns());
      });
      const row = sel.axis === 'row';
      for (const after of [false,true]) menu.addItem(item => {
        item.setTitle(row ? (after?'在下方插入行':'在上方插入行') : (after?'在右侧插入列':'在左侧插入列'));
        item.onClick(()=>this.insertTableAxis(sel.table,row?'row':'col',
          (after?Math.max(...sel.indices)+1:Math.min(...sel.indices))));
      });
      this.addAlignmentMenu(menu);
      return;
    }
    const area = sel ? this.selectionCells(sel).size : 0;
    const isRegion = sel ? this.isMergeRegion(sel) : false;
    if (sel && area >= 2 && !isRegion && this.selectionIsRectangle(sel)) {
      menu.addItem((item) => {
        item.setTitle('合并单元格');
        item.onClick(() => this.mergeSelectedCells());
      });
    }
    if (sel) {
      menu.addItem((item) => {
        item.setTitle(sel.r1 === sel.r2 ? '删除行' : `删除 ${sel.r2 - sel.r1 + 1} 行`);
        item.onClick(() => this.deleteSelectedRows());
      });
      menu.addItem((item) => {
        item.setTitle(sel.c1 === sel.c2 ? '删除列' : `删除 ${sel.c2 - sel.c1 + 1} 列`);
        item.onClick(() => this.deleteSelectedColumns());
      });
    }
    let splitReg = null, path = null, tid = null;
    if (sel && isRegion) {
      splitReg = { r: sel.r1, c: sel.c1, rowspan: sel.r2 - sel.r1 + 1, colspan: sel.c2 - sel.c1 + 1 };
      path = sel.path; tid = sel.tid;
    } else {
      const c = this.cellAtCursor();
      if (c) {
        const table = c.closest('table');
        path = this.currentPath();
        tid = table ? this.tableId(table) : null;
        const r = this.cellRow(c), cc = this.cellCol(c);
        const list = this.effectiveMerges(table, path, tid);
        const reg = list.find((m) => this.regionContains(m, r, cc));
        if (reg) splitReg = reg;
      }
    }
    if (splitReg && path && tid) {
      menu.addItem((item) => {
        item.setTitle('拆分单元格');
        item.onClick(() => this.splitRegion(path, tid, splitReg));
      });
    }
    this.addAlignmentMenu(menu);
  }

  cellAtCursor() {
    const editor = this.activeEditor();
    const cm = editor && editor.cm;
    if (!editor || !editor.getCursor || !cm || !cm.domAtPos) return null;
    try {
      const cur = editor.getCursor();
      const doc = editor.getDoc();
      const line = typeof doc.line === 'function' ? doc.line(cur.line) : null;
      const off = line ? line.from + cur.ch : 0;
      const dom = cm.domAtPos(off);
      const node = dom && dom.node;
      if (!node) return null;
      return node.nodeType === 1 ? node.closest('td,th') : (node.parentElement && node.parentElement.closest('td,th'));
    } catch (e) { return null; }
  }

  handleCellEnter(e) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return false;
    const table = e.target.closest && e.target.closest('table[data-tcr]');
    if (!table || !e.target.closest('.table-cell-wrapper')) return false;
    const session = this.activeEditor()?.editorComponent?.tableCell;
    const cm = session && session.cm;
    if (!cm || session.table?.tableEl !== table || !cm.contentDOM.contains(e.target)) return false;
    e.preventDefault(); e.stopImmediatePropagation();
    this.clearMergeSelection();
    if (typeof session.table.deselectCells === 'function') session.table.deselectCells();
    cm.dispatch({...cm.state.replaceSelection('\n'), userEvent:'input.type'});
    requestAnimationFrame(()=>{if (table.isConnected) {this.positionAxisRails(table);this.positionSelectionOverlay();}});
    return true;
  }

  // Ctrl+A inside a merged cell selects the whole merged cell (for split).
  handleCellSelectAll(e) {
    if (!(e.ctrlKey || e.metaKey) || !(e.key === 'a' || e.key === 'A')) return false;
    const editor = this.activeEditor();
    const cm = editor && editor.cm;
    if (!editor || !cm || !editor.getCursor || !cm.domAtPos) return false;
    try {
      const cur = editor.getCursor();
      const doc = editor.getDoc();
      const line = typeof doc.line === 'function' ? doc.line(cur.line) : null;
      const off = line ? line.from + cur.ch : 0;
      const dom = cm.domAtPos(off);
      const node = dom && dom.node;
      const cell = node ? (node.nodeType === 1 ? node.closest('td,th') : (node.parentElement && node.parentElement.closest('td,th'))) : null;
      if (!cell) return false;
      const table = cell.closest('table[data-tcr]');
      if (!table) return false;
      const path = this.currentPath();
      const tid = this.tableId(table);
      const r = this.cellRow(cell), c = this.cellCol(cell);
      const list = this.effectiveMerges(table, path, tid);
      const reg = list.find((m) => this.regionContains(m, r, c));
      if (!reg) return false;
      e.preventDefault();
      e.stopPropagation();
      const anchor = table.rows[reg.r] && table.rows[reg.r].cells[reg.c];
      if (anchor) {
        this.selectRect(table, reg.r, reg.c,
          reg.r + reg.rowspan - 1, reg.c + reg.colspan - 1, path, tid);
      }
      return true;
    } catch (err) { return false; }
  }

  startDrag(e, colgroup, i, key, tid) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const cell = e.currentTarget && e.currentTarget.closest('th,td');
    // Handles survive header edits and colgroup replacement. Never use the
    // identity/DOM captured when the handle was first attached.
    const table = cell?.closest('table') || colgroup.closest('table');
    if (!table || table.isConnected === false) return;
    key = table.dataset.tcrPath || key;
    tid = this.tableId(table);
    colgroup = this.ensureColgroup(table, table.querySelectorAll('thead th, thead td').length || colgroup.children.length);
    if (cell) i = this.cellCol(cell);
    if (cell && cell.dataset.tcrMerge) i = this.cellCol(cell) + cell.colSpan - 1;
    let col = colgroup.children[i];
    if (!col) return;
    const history=this.historySnapshot();
    const handle=e.currentTarget;
    if(handle && e.pointerId!=null)try{handle.setPointerCapture(e.pointerId)}catch(_){}
    table.dataset.tcrResizing='1';
    table._tcrAxisRails?.forEach(rail=>rail.classList.add('tcr-resizing'));
    const startX = e.clientX;
    const startW = col.getBoundingClientRect().width || parseFloat(col.style.width) || 80;
    const initialWidths=Array.from(colgroup.children,c=>c.style.width || '');
    const updateStore = () => {
      const arr = [];
      for (const c of colgroup.children) arr.push(c.style.width || '');
      table._tcrColumnDrag = arr;
      this.setWidths(key, this.tableId(table), arr);
    };
    const onMove = (ev) => {
      if(ev.pointerId!=null && e.pointerId!=null && ev.pointerId!==e.pointerId)return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const liveGroup = table.querySelector('colgroup');
      if (liveGroup && liveGroup !== colgroup) {
        colgroup = liveGroup;
        (table._tcrColumnDrag || []).forEach((width, index) => {
          if (colgroup.children[index]) colgroup.children[index].style.width = width;
        });
        col = colgroup.children[i];
      }
      if (!col || table.isConnected === false) return;
      const w = Math.max(40, startW + (ev.clientX - startX));
      col.style.width = w + 'px';
      this.syncTableWidth(table, colgroup);
      // Keep the in-memory store current on every move so Reading view (and any
      // Live Preview re-render) always reflects the latest width immediately.
      updateStore();
    };
    const onUp = (ev) => {
      if(ev?.pointerId!=null && e.pointerId!=null && ev.pointerId!==e.pointerId)return;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      updateStore();
      const widths = table._tcrColumnDrag.slice();
      delete table._tcrColumnDrag;
      if(widths.every((width,index)=>width===initialWidths[index])){cleanup();return;}
      this.runTableHistory(()=>this.commitColumnWidths(table, key, widths),history);
      this.persist();
      cleanup();
    };
    const cleanup=()=>{
      window.removeEventListener('pointermove', onMove, true);window.removeEventListener('pointerup', onUp, true);window.removeEventListener('pointercancel', onCancel, true);
      handle?.removeEventListener('lostpointercapture',onCancel);
      delete table.dataset.tcrResizing;delete table._tcrColumnDrag;
      table._tcrAxisRails?.forEach(rail=>rail.classList.remove('tcr-resizing'));
      if(handle && e.pointerId!=null)try{handle.releasePointerCapture(e.pointerId)}catch(_){}
      if(this._columnDragCleanup===onCancel)this._columnDragCleanup=null;
    };
    const onCancel=()=>{
      initialWidths.forEach((width,index)=>{if(colgroup.children[index])colgroup.children[index].style.width=width;});
      this.setWidths(key,tid,initialWidths.slice());this.syncTableWidth(table,colgroup);cleanup();
    };
    this._columnDragCleanup=onCancel;
    // A release over an insertion rail must not become a native button click.
    const swallowClick=event=>{event.preventDefault();event.stopImmediatePropagation();};
    handle?.addEventListener('click',swallowClick,{once:true,capture:true});
    updateStore();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    handle?.addEventListener('lostpointercapture',onCancel);
  }

  commitColumnWidths(table, path, widths) {
    const oldTid = this.tableId(table);
    this.setWidths(path, oldTid, widths);
    // Give a resized table a source-backed identity so later header edits,
    // view switches and reopening the note cannot discard its saved widths.
    const editor = this.app?.workspace && this.activeEditor();
    if (!editor || this.currentPath() !== path || table.isConnected === false) return oldTid;
    const info = this.tableSourceInfo(editor, table);
    if (!info || typeof info.header !== 'string') return null;
    if(info.uid)return 'u'+info.uid;
    const uid = 'm'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    const at = info.toPos(info.from + info.header.match(/^\s*\|?\s*/)[0].length);
    try { this.replaceTableRange(editor,this.encodeInvisibleUid(uid), at, at); }
    catch (_) { return null; }
    const tid = 'u'+uid;
    for (const store of [this.widths,this.rowHeights,this.merges,this.tableDims,this.alignments,this.cellStyles,this.tableOptions]) {
      if (store?.[path]?.[oldTid] !== undefined) store[path][tid] = store[path][oldTid];
    }
    table.dataset.tableTuneUid = uid;
    if (this._sel?.table === table) this._sel.tid = tid;
    return tid;
  }

  // Row-resize: drag the bottom edge of the leftmost cell of a row to change
  // that row's height. Edit-mode only (mirrors into Reading via this.rowHeights).
  startRowDrag(e, tr, rowIndex, key, tid) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const table = tr.closest('table');
    const cell = e.currentTarget && e.currentTarget.closest('th,td');
    if (cell && cell.dataset.tcrMerge) {
      rowIndex = this.cellRow(cell) + cell.rowSpan - 1;
      tr = table.rows[rowIndex];
    }
    const tracks = table.classList.contains('tcr-grid-table')
      ? getComputedStyle(table).gridTemplateRows.split(' ').map(parseFloat) : [];
    const startH = tracks[rowIndex] || parseFloat(tr.style.height) || tr.getBoundingClientRect().height || 30;
    const prev = this.getRowHeights(key, tid) || [];
    const arr = prev.slice();
    let lastY = startY;
    const apply = (h) => {
      tr.style.height = h + 'px';
      arr[rowIndex] = Math.round(h) + 'px';
      // In-memory store updated every move so Live Preview re-renders and
      // Reading view both reflect the new height immediately.
      this.setRowHeights(key, tid, arr.slice());
      if (table.classList.contains('tcr-grid-table')) this.updateMergeGridRows(table, key, tid);
      this.positionAxisRails(table);
      if (this._sel?.table === table) this.positionSelectionOverlay();
    };
    const onMove = (ev) => {
      lastY = ev.clientY;
      const h = Math.max(24, startH + (ev.clientY - startY));
      apply(h);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      const h = Math.max(24, startH + (lastY - startY));
      apply(h);
      this.refreshMergeHeights(tr.closest('table'), key, tid);
      this.persist();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  refreshMergeHeights(table, path, tid) {
    if (!table) return;
    const heights = this.getRowHeights(path, tid) || [];
    for (const reg of this.getMerges(path, tid)) {
      let total = 0;
      for (let r = reg.r; r < reg.r + reg.rowspan; r++) {
        const row = table.rows[r];
        total += parseFloat(heights[r]) || (row && row.getBoundingClientRect().height) || 0;
      }
      if (total > 0) reg.height = Math.round(total) + 'px';
    }
  }
};













},
"./core.cjs":function(module,exports,require){
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

},
"./icons.cjs":function(module,exports,require){
'use strict';

// Small self-contained line icons. Do not depend on the host's icon registry,
// external fonts, network assets or theme-provided SVG stroke defaults.
const PATHS={
 'table-2':['M3 3h18v18H3Z','M3 9h18M9 3v18'],
 scan:['M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'],
 check:['M4 12l5 5L20 6'],
 'table-properties':['M3 3h18v18H3Z','M3 9h18M3 15h18M9 3v18','M15 4v3m0 3v3m0 3v3'],
 combine:['M3 4h6m6 0h6v16h-6M9 20H3V4','M3 12h7m-3-3 3 3-3 3m14-3h-7m3-3-3 3 3 3'],
 split:['M3 4h18v16H3Z','M12 4v16M10 12H5m3-3-3 3 3 3m6-3h5m-3-3 3 3-3 3'],
 'align-left':['M3 3v18M6 6h15M6 10h10M6 14h15M6 18h10'],
 'align-center':['M3 5h18M7 10h10M3 15h18M7 20h10'],
 'align-right':['M21 3v18M3 6h15M8 10h10M3 14h15M8 18h10'],
 'align-vertical-justify-start':['M3 3h18M6 7v14M12 7v9M18 7v14'],
 'align-vertical-justify-center':['M3 12h18M6 3v7m0 4v7M12 6v4m0 4v4M18 3v7m0 4v7'],
 'align-vertical-justify-end':['M3 21h18M6 3v14M12 8v9M18 3v14'],
 'arrow-up-to-line':['M3 3h18M12 21V7m-5 5 5-5 5 5'],
 'arrow-down-to-line':['M3 21h18M12 3v14m-5-5 5 5 5-5'],
 'arrow-left-to-line':['M3 3v18M21 12H7m5-5-5 5 5 5'],
 'arrow-right-to-line':['M21 3v18M3 12h14m-5-5 5 5-5 5'],
 eraser:['m3 14 10-11 8 8-9 10H9Z','m7 10 8 8M12 21h9'],
 'rows-3':['M3 3h18v18H3Z','M3 9h18M3 15h18'],
 'columns-3':['M3 3h18v18H3Z','M9 3v18M15 3v18'],
 pin:['M8 3h8m-7 0v6l-4 5h14l-4-5V3M12 14v8'],
 palette:['M12 3a9 9 0 1 0 0 18c2 0 3-1 2-3-1-2 0-3 2-3h2c2 0 3-2 3-4a9 9 0 0 0-9-8Z','M7 9h.1M11 6h.1M16 7h.1M6 14h.1'],
 copy:['M8 8h13v13H8Z','M16 8V3H3v13h5'],
 'undo-2':['M8 4 3 9l5 5M3 9h11a7 7 0 0 1 0 14'],
 'redo-2':['m16 4 5 5-5 5m5-5H10a7 7 0 0 0 0 14'],
 ellipsis:['M4 12h1m6 0h1m6 0h1'],
 'settings-2':['M3 6h8m4 0h6M3 12h2m4 0h12M3 18h12m4 0h2','M11 3v6M5 9v6m10 0v6'],
 x:['m5 5 14 14M19 5 5 19'],
 pencil:['m4 16 12-12 4 4L8 20H4Z','m13 7 4 4']
};

function renderIcon(element,name){
 const doc=element.ownerDocument,ns='http://www.w3.org/2000/svg';
 const svg=doc.createElementNS(ns,'svg');
 for(const [key,value]of Object.entries({xmlns:ns,viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false',class:'tt-icon'}))svg.setAttribute(key,value);
 // Inline presentation also covers hosts that reset generic button SVGs.
 for(const [key,value]of Object.entries({display:'block',visibility:'visible',opacity:'1',width:'18px',height:'18px',stroke:'currentColor','stroke-width':'1.8',fill:'none','flex-shrink':'0'}))svg.style.setProperty(key,value,'important');
 for(const d of PATHS[name]||PATHS['table-2']){
  const path=doc.createElementNS(ns,'path');path.setAttribute('d',d);path.style.setProperty('stroke','inherit','important');path.style.setProperty('fill','none','important');svg.appendChild(path);
 }
 element.replaceChildren(svg);return svg;
}

module.exports={renderIcon,PATHS};

},
"./plugin.cjs":function(module,exports,require){
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

}};const cache={};function load(id){if(!modules[id])return hostRequire(id);if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,load);return m.exports;}module.exports=load("./plugin.cjs");})(require);
