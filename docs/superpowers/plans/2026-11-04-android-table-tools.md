# Android Table Tools Implementation Plan

> **For agentic workers:** Execute inline with superpowers:executing-plans. Track each step with checkboxes. This dedicated clone isolates work from existing vaults and projects.

**Goal:** Deliver an installable Android-friendly Obsidian table plugin implementing the approved design.

**Architecture:** Keep upstream editor logic in `src/base.cjs`; extend it in `src/plugin.cjs`. Pure width, cell-style and export algorithms live in `src/core.cjs`. A dependency-free module packer emits `main.js`; Obsidian and CodeMirror remain host-provided modules.

**Tech Stack:** CommonJS JavaScript, Obsidian API, CSS, Node test runner, existing local Playwright for isolated UI verification.

## Task 1 — Baseline and pure behavior

- [x] Create feature branch in this isolated clone, preserve MIT and source attribution.
- [x] Add `tests/core.test.cjs`: assert fit widths respect 64px; subset equalization preserves total; merged HTML omits covered cells, escapes text, preserves styles; TSV quotes multiline text; remap preserves styles when merge anchor deleted; freeze detects crossing merges.
- [x] Run `node --test tests/core.test.cjs` and observe missing implementation failures.
- [x] Implement exports `fitWidths`, `equalWidths`, `contentWidths`, `remapStyles`, `mergeStyles`, `splitStyles`, `freezeConflict`, `exportTable`, `safeFilename` in `src/core.cjs`.
- [x] Run the same test command, require zero failures.

## Task 2 — Integration and history

- [x] Preserve upstream main as `src/base.cjs`; add fixture loader and `tests/plugin.test.cjs` exercising actual inherited methods through a minimal Obsidian host mock.
- [x] Test history snapshots include new stores; unknown saved fields persist; style and options migrate on table identity changes; merge crossing freeze is rejected before source edit; same-ID replacement preserves all original data fields.
- [x] Extend base persistence, history, identity adoption, explicit and native dimension changes with `cellStyles` and `tableOptions` using existing alignment remapping as the integration point.
- [x] Implement stable-ID metadata mutation, per-table layout actions, style operations and guarded merging in `src/plugin.cjs`.
- [x] Run `node --test tests/*.test.cjs` and `node --check src/base.cjs`.

## Task 3 — UI, touch, freeze, clipboard

- [x] Add isolated browser fixture and Playwright assertions before UI implementation: no range drag on normal touch; explicit two-tap range; toolbar retains selection; freeze header/column after scroll; viewport keyboard positioning; styles and copy payload; cleanup on unload.
- [x] Build labelled 44px toolbar groups with secondary menus, pointer-safe selection, visualViewport listeners and container resize observers.
- [x] Apply freeze and style through cell data attributes and stylesheet rules that survive upstream editor style resets. Use scroll containers bounded to 60% available height for frozen headers.
- [x] Implement UTF-8 Vault HTML export with collision-free filenames; async clipboard rich/plain with explicit failure notice. Keep native-copy custom payload interoperable.
- [x] Run browser tests with an isolated page; inspect screenshots; fix regressions.

## Task 4 — Delivery

- [x] Add plugin manifest 0.1.0, Chinese README, CHANGELOG, migration and Android acceptance instructions.
- [x] `node scripts/build.cjs` packages local modules and produces `dist/tablet-table-tools/` and installable ZIP with PowerShell Compress-Archive.
- [x] Run unit tests, browser tests, bundle syntax check and manifest/package consistency check.
- [x] Record test counts and limitations in ACCEPTANCE.md and progress.md. Do not claim Android hardware or Excel app verification.
- [x] Deliver ZIP and installation steps; preserve feature branch locally without publishing or editing real vault.
