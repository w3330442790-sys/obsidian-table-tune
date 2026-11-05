# Restore contextual table tools

User-directed design, 2026-11-05: restore the original popup location instead of bottom docking. User also requested both touch range/axis selection and configurable visible icons.

- Open a compact icon toolbar above the clicked table edge, resize handle, or explicit selection. Normal text taps edit without opening it. Clamp to the current pane and visual viewport; only flip below the anchor when there is no space above. Never dock to the bottom.
- Reuse upstream merge, split, horizontal/vertical alignment, clear, insert and delete operations. Keep merge and split visible with contextual disabled states. Retain layout, freeze, styles, export and history actions as icons. Destructive commands retain confirmation.
- Preserve two-tap rectangular selection; add current row/column and two-tap multiple-row/column selection without requiring modifier keys. Include merged regions using upstream selection semantics.
- Provide an always-accessible customization icon with checked visibility choices and reset defaults. Store hidden action IDs in the existing plugin data without replacing any other fields. Hidden commands remain available in More. No feature is removed.
- Replace the large text entry with a small table icon. Icons use Obsidian setIcon, accessible labels and titles; touch targets remain 40px, visual glyphs 18px. The one-row popup scrolls within a capped width.
- Verify the trigger, anchor geometry, pane/keyboard clamping, text editing, original actions, touch selection, configuration persistence and unload cleanup in isolated browser tests. No real-device claim.
