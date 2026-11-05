# Contextual Table Toolbar Implementation Plan

**Goal:** Restore the original contextual popup and original icon operations, with touch selection and configurable shortcuts.

**Architecture:** Keep upstream source-safe command implementations in base.cjs. Extend plugin.cjs only for triggers, touch selection, shortcut configuration and popup geometry. Reuse Obsidian icons and menus. Persist hidden shortcut IDs alongside existing fields.

**Tech Stack:** CommonJS, Obsidian Plugin/Menu/setIcon, CSS, Node test runner, Playwright touch simulation.

## Tasks

- [x] Add failing browser checks for normal text taps staying closed, edge taps opening above the point, SVG-only buttons, direct merge/split/alignment, row/column selection and shortcut visibility persistence. Update old bottom-docking assertions to the requested contextual behavior.
- [x] In src/plugin.cjs, track an anchor cell/local point on edge/resize/axis interactions. Use the active pane and visual viewport to clamp a popup above it, falling below only when needed. Suppress ordinary-text triggers and clean up new event handlers on unload.
- [x] Build icon shortcuts from upstream command callbacks, with contextual merge/split states. Expose row/column selection menus and add two-tap axis modes. Keep More and Customize accessible even when other shortcuts are hidden.
- [x] In styles.css, use a bounded single-row icon popup, 40px hit targets and 18px glyphs. Convert the large table-tools text entry into a small icon.
- [x] Add checked customization choices and reset in the toolbar menu; preserve existing metadata in persist(). Extend fixture SVG rendering and source/history harness only as necessary for meaningful browser checks.
- [x] Run npm test, npm run build, node --check main.js and npm run test:ui. Inspect popup screenshots, review changes, update version/docs and verify installation ZIP contains no data.json. Publish only within authorized scope.
