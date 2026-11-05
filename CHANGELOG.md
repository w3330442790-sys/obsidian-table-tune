# 2.1.3 — Self-contained toolbar icons (2026-11-05)

- Replace the host icon-registry dependency for toolbar/entry controls with bundled SVG line icons, explicit namespace, size, stroke and theme color inheritance.
- Guard icon presentation against mobile/theme SVG reset styles; retain disabled button opacity.
- Remove the always-successful fake SVG from the browser fixture. Run all interactions with an empty host icon API and verify actual path geometry, computed stroke, visibility and light/dark screenshots under conflicting CSS.
- Keep contextual positioning, triggers, selection, original commands and customization unchanged.
- The exact failure inside the user's Android host remains unobserved; this release removes the reproduced registry/style failure paths rather than claiming a proven host-specific cause.

# 2.1.2 — Restore contextual icon tools (2026-11-05)

- Restore a compact icon popup above the clicked table edge, resize handle or selected region; remove bottom docking and ordinary text-tap activation.
- Restore direct merge, split, all six alignment, clear, insert and delete icons using upstream commands. Destructive operations retain confirmation and axis guards.
- Add touch selection of the current row/column and two-tap multiple-row/column ranges.
- Add persistent shortcut visibility customization and reset; hidden commands remain in More.
- Replace the large table-tools text entry with a small table icon; maintain accessible names and 40px hit targets.
- Verify actual merge/source rewriting and splitting as well as positioning, selection, customization, history and compatibility in isolated tests.

# 2.1.1 — Android tablet control visibility (2026-11-05)

- Initialize tools on tables already open when the plugin is enabled or updated.
- Open tools by tapping reading-view cells; offer a switch to Live Preview for editing.
- Dock tools above visible Android navigation and keyboard toolbars.
- Keep the table tools entry visible while horizontally scrolling wide tables.
- Add regression checks for startup, reading taps, view switching, bottom navigation and horizontal scrolling.

# 2.1.0 — Personal Android edition (2026-11-04)

- Replace the existing table-tune program in place; retain its ID and original data.json.
- Add touch range selection, 44px toolbar, keyboard/viewport positioning and safe resize cancellation.
- Add independent frozen header/first column, five layout actions and semantic cell colors/marks.
- Add safe HTML/TSV copying and Vault-based HTML export with merge/layout preservation.
- Extend native history, metadata identity and structural remapping for new fields.
- Preserve existing content and layout on startup; no automatic Markdown conversion.

# Changelog

## 2.0.1 — 2026-10-25

### Updated package — 2026-10-26

- Cleaned up interrupted pointer gestures and obsolete native editor wrappers; restored selection controls when Live Preview reuses a detached table widget.
- Limited table rescans to table-related DOM changes. Verified interrupted gestures, 80 native-controller replacements, 100 cached-widget reuse cycles and text/cell selection after reuse.
- Replaced the existing 2.0.1 package without changing the version number. Reinstall this version to receive the update.

- Fixed merged cells retaining a native read-only selection after merging: the first click can now place a caret and edit text.
- Preserved text selections against delayed native cell-focus callbacks, so selecting text and immediately pressing Delete works without selection or caret jumps.
- Retained normal cell-range dragging, Shift selection, clipboard layout preservation and native undo/redo behavior.
- Added regression coverage for horizontal/vertical merges, first-click editing, partial text deletion, delayed focus callbacks and stale native selection recovery. Regression tests use native selection/history code from Windows Obsidian 1.14.5; mobile behavior has not been verified.

## 2.0.0 — 2026-10-22

### Updated package — 2026-10-23

- Added an eraser icon to clear selected cell contents without deleting rows/columns or changing merged regions, widths or alignment. Supports native undo/redo.
- Replaced the original 2.0.0 package at the author's request; the version number is unchanged. Existing installations may need a manual reinstall to receive this replacement.
- A report of first-row text disappearing after merging remains under investigation; this replacement does not claim to resolve that report.

### Added

- Merge/split cells and expand drag/Shift selections around intersecting merges.
- Text-first selection, partial text selection, and whole-table highlighting when selecting from outside a table.
- A horizontal icon toolbar for table operations and horizontal/vertical alignment.
- Multi-cell clipboard operations and supported external HTML, TSV and Markdown table pasting.
- Native Ctrl+Z undo and Ctrl+Y redo, with table source edits and layout metadata grouped into a single history step.

### Fixed

- First-row text disappearing after alignment or merging.
- Operations on one table affecting another table in the same note.
- Column widths snapping back after dragging or changing on first text input.
- Merged-cell borders becoming misaligned at minimum column width and creating the appearance of an extra cell.
- Disconnected selection outlines, click-only merged-cell highlighting and repeated caret artifacts during cell selection.

### Changed

- Preserve displayed column widths during text editing; use border dragging to resize.
- Use ordinary first-row text styling instead of forced bold.
- Require Obsidian 1.14.4 or newer; Windows/Obsidian 1.14.4 is the verified environment.

### Upgrade notes

- Preserve `data.json` and back up your vault before upgrading.
- Table layout uses plugin metadata and invisible identifiers in table source; other Markdown renderers do not reproduce all presentation features.
- Undo history is session-scoped and does not restore operations from before reloading the plugin/editor.

## 1.1.5

- Resize columns and rows from cell borders.
- Existing releases and tags are retained unchanged.
