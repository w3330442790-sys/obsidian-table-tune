## 表格工具 · TableTune 2.1.3

图标空白兼容修复：使用插件自带 SVG 与明确描边，不依赖宿主图标库。悬浮位置和功能保持不变。详见 [2.1.3 发布说明](docs/releases/2.1.3.md)。

## 表格工具 · TableTune 2.1.2

恢复原位悬浮小图标栏，保留原有合并、拆分、对齐及行列操作；增加触控行列选区与图标自定义。详见 [2.1.2 发布说明](docs/releases/2.1.2.md)。

## 表格工具 · TableTune 2.1.1

安卓平板按钮显示修复：启用时初始化、阅读模式触控入口、底栏避让和宽表入口可见。详见 [2.1.1 发布说明](docs/releases/2.1.1.md)。

## 表格工具 · TableTune 2.1.0

安卓触控、固定表头首列、一键整理、底色重点、Excel/TSV 复制与 HTML 导出。完整说明见 [2.1.0 发布说明](docs/releases/2.1.0.md)。

BRAT 仓库：`w3330442790-sys/obsidian-table-tune`。继续使用原 table-tune 插件 ID 和 data.json，不删除或批量转换已有表格。

以下为上游 2.0.1 的历史说明。

## TableTune 2.0.1（上游历史）

合并单元格编辑稳定性修复 / Merged-cell editing fixes.

- 2026-10-26 更新：修复中断拖选后监听累积、缓存表格重新挂载后选区失效，并减少无关界面变化触发的重复布局；版本仍为 2.0.1，已安装用户需重新下载/安装此版本以获取修复。
- 修复合并后残留原生多选/只读状态，导致第一次点击不出现光标、无法编辑的问题。
- 修复拖选合并格内文字后，延迟聚焦使选区跳变、Delete 无法连续删除选中文字的问题；同时保护删除后的光标位置。
- 保留拖拽/Shift 单元格多选、复制粘贴列宽/行高和原生撤销重做功能。

Regression coverage includes horizontal/vertical merges, first-click typing, partial text selection and immediate Delete, stale focus callbacks, clipboard operations and native undo/redo. Tests use native selection/history code from Windows Obsidian 1.14.5; mobile behavior has not been verified.

**Requires Obsidian 1.14.4+.**

Download all three assets (`main.js`, `manifest.json`, `styles.css`) to `.obsidian/plugins/table-tune/`, then reload the plugin. Preserve your existing `data.json` and back up your vault before upgrading.

Version 2.0.0 remains available unchanged. Undo/redo is session-scoped. Merged cells and presentation rely on plugin metadata; they are not portable native Markdown formatting. External clipboard support depends on the formats supplied by the source app.

See the README and changelog for full usage and compatibility notes.
