# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.20] - 2026-06-30

### Added

- **Interface language (English/Spanish)**: menus, dialogs and notices can be shown in English (default) or Spanish. A new setting under **Settings → Community plugins → DBML ER Diagrams → Language** switches it. Strings live in `src/i18n.ts` behind a `t()` lookup.

## [0.1.19] - 2026-06-22

### Added

- **Change relationship type (cardinality)**: the line menu (click on the selected connection) lets you choose one to many, many to one, one to one or many to many. It checks the current option and rewrites the operator (`<`, `>`, `-`, `<>`) in the dbml block, whether in the standalone `Ref:` form or inline on the column; the markers (crow's foot / bar) update accordingly.

## [0.1.18] - 2026-06-22

### Added

- **Delete table**: the node header menu (next to rename/color) offers "Delete table…", with a confirmation dialog. It removes the table declaration from the dbml block along with its `@pos`/`@edge` annotations and the standalone `Ref:` relationships that reference it on either end.
- **Delete vertex**: with the line selected, the context menu (right-click) of a route vertex offers "Delete vertex". It reuses the same flow as inserting (rebake to the current frame → mutate → save); if it was the last vertex, the connection returns to automatic routing.

## [0.1.17] - 2026-06-20

### Changed

- **Always orthogonal (90°) routing**: dragging a bend point no longer produces oblique angles. The point moves freely in any direction, but the line is *orthogonalized* when drawn: between each pair of points that are not aligned an elbow is inserted (`(b.x, a.y)`, "horizontal first"), so each bend you drag becomes a real 90° corner (it enters vertically, leaves horizontally). The two endpoints (column ports) are not modified; only the intermediate route is adapted. Collinear/duplicate points are removed to preserve the rounded corners. This replaces the soft magnet of 0.1.16, which allowed arbitrary angles.

## [0.1.16] - 2026-06-20

### Fixed

- **Flicker on re-render (real cause)**: every re-render of the block recomputed the ELK layout asynchronously, briefly showing the "Rendering ERD…" placeholder; that gap was the visible flicker. The layout is now cached by DBML structure (ignoring the `@pos`/`@view`/`@size`/`@edge` annotations), so re-renders triggered by saving the layout reuse it and are drawn synchronously, without a pause.
- **Moving bends: orthogonal magnet too aggressive**: the "L" snap *always* forced the dragged point to an elbow, preventing free/horizontal/vertical movement and collapsing it onto a neighbor (it looked like they were being "deleted"), besides leaving square corners. The point now moves freely and only snaps to an axis when it is close (~7px screen threshold) to aligning with a neighbor, keeping the rounded corners.
- **Resizing the canvas downward**: `@size` was not persisted when the browser set sub-pixel sizes (e.g. `400.5px`), so the height reverted to the default on each re-render. Fractional px are now accepted and rounded.

## [0.1.15] - 2026-06-19

### Fixed

- **Flicker and continuous deselection**: `saveLayout` rewrote the block on every call even when the content had not changed; each write fires an Obsidian `modify` event that re-renders the code block (new instance → the selected edge and its handles are lost, with periodic flicker). Now the current content is read and only persisted if the block actually changed (idempotent save), breaking the re-render loop.
- **Bends could not be created with a click**: the insertion handles ("+" in the middle of each segment) only added a point when *dragging* (3px threshold); a tap/click without movement did nothing. Now a click on an insertion handle creates the bend at that point, in addition to the existing drag.
- **Edge selection survives re-render**: the edge with visible handles is remembered per block (`sourcePath#line`) and restored when the diagram remounts, so saving the layout (or adding several nodes in a row) no longer hides the handles.

## [0.1.14] - 2026-06-19

### Fixed

- **Bends now move with the tables**: previously, when creating a bend point on a connection, those points stayed fixed at absolute coordinates; when a table was moved only the endpoints re-anchored and the route looked broken/frozen. Now the intermediate waypoints are stored relative to a *base frame* (the anchors of the two endpoints when the route was authorized) and stretched affine-ly (independent interpolation in X and Y) when either table is moved, deforming the whole connection naturally. When you start dragging a handle the route is "rebaked" to the current frame so the drag and the orthogonal magnet work in the same coordinates you see. `@edge` routes are serialized already mapped to the current frame, so they match `@pos` and on reload the mapping starts as identity.

## [0.1.13] - 2026-06-19

### Changed

- **Orthogonal magnet when dragging handles**: when moving a bend point of a connection, it now snaps automatically to the nearest "L" elbow relative to its neighbors (one axis inherits the X of the previous point and the other the Y of the next, or vice versa, whichever ends up closer). It keeps the perpendicular dbdiagram.io-style segments without manual alignment. The endpoints re-anchor to the current column ports with the same logic as saved routing.

## [0.1.12] - 2026-06-19

### Added

- **Hand-editable connections**: tap a relationship to select it; handles appear at each bend and in the middle of each segment. Drag a handle to bend the curve or use the mid-segment one to insert a new point. The route is saved as a `// @edge` comment inside the block (next to `@pos`/`@view`/`@size`) and restored when you reopen the note. Tapping a selected relationship again opens a menu with "Reset route" (back to automatic) and "Deselect".

### Changed

- **Collision avoidance when moving tables**: manual routing (`manhattan`) now picks the nearest vertical channel that does not cross *other* tables, not just the two connected ones. Previously a connection could cross over intermediate tables after moving a table.
- `@edge` routes update when renaming tables or columns, and are discarded if the relationship no longer exists in the DBML.

## [0.1.11] - 2026-06-19

### Fixed

- **Edit menus on mobile (Android)**: the "Rename table/column" and "Pick color" pop-up menu appeared and closed instantly on touch. The `pointerup` that opened the menu kept propagating up to `document`, where the Obsidian menu registers its auto-close listener. Propagation is now stopped (`stopPropagation`/`preventDefault`) and the opening is deferred one tick, so the menu stays open.

## [0.1.10] - 2026-06-18

### Added

- **Canvas size persistence**: when resizing the diagram by dragging its corner (now `resize: both`, width and height), the size is saved as a `// @size <width> <height>` comment inside the block, next to `// @view` and `// @pos`. On reopening the note the canvas restores the chosen size. Only user-set dimensions (inline px) are persisted, so changing the Obsidian panel width does not alter what was saved.

## [0.1.9] - 2026-06-17

### Added

- **Text editing from the diagram**: click a table header → "Rename table…"; click a column → "Rename column…" or "Change type…". Changes are written back to the DBML block. When renaming tables or columns, references (`Ref:` and inline) are updated too so relationships don't break.
- **Position persistence**: tables you move are saved as `// @pos` comments inside the block (and the view as `// @view`), so closing and reopening the note keeps them where you left them. Saving happens on table drop (debounced) and the view is restored to avoid jumps on re-render.

### Changed

- `minAppVersion` bumped to `1.6.0`: editing and saving use `vault.process` (atomic read-modify-write) instead of `read`+`modify`.
- Drag listeners migrated to *pointer capture* on the node itself; the rest uses `registerDomEvent`/`activeWindow` (no leaks, compatible with pop-out windows).
- Header colors and canvas height applied via CSS variables (`--dbml-head-fill`, `--dbml-erd-height`) instead of inline styles.

### Fixed

- The parser no longer breaks on `//` or braces inside strings (`note: '...'`), `indexes { }` blocks, loose apostrophes or triple-quote notes; the table body is delimited by counting braces.
- References to nonexistent tables/columns are discarded instead of dropping the whole diagram; duplicate relationships are deduplicated.
- Renaming a table no longer corrupts the text of notes containing `name.`; named/`rgb()` colors compute the readable text color correctly.
- The header color can be set even if the `{` is on the next line.

## [0.1.8] - 2026-06-17

### Fixed

- The static styles of the color input (`position`, `left`) were moved to the `.dbml-color-input` CSS class, resolving the `obsidianmd/no-static-styles-assignment` error from the Obsidian review.

## [0.1.7] - 2026-06-17

### Changed

- Cleanup for the Obsidian review: ELK types without `any` (`ElkNode`/`ElkPort`/`ElkExtendedEdge`), `document`/`requestAnimationFrame` replaced by `activeDocument`/`activeWindow` (compatibility with pop-out windows), unnecessary type assertions removed, plugin name without all-caps.
- Release workflow with artifact build provenance attestation (`attest-build-provenance`).

## [0.1.6] - 2026-06-17

### Added

- Interactive palette: clicking a table header opens a menu to **pick** or **remove** color. The plugin writes `[headercolor: #hex]` back into the DBML block (persistent and portable).

## [0.1.5] - 2026-06-17

### Added

- Per-table header color with `[headercolor: #hex]` (dbdiagram-compatible). The header text color adjusts itself (white or dark) based on luminance.

## [0.1.4] - 2026-06-17

### Changed

- Events migrated to pointer events: drag and pan now work on mobile (touch) too.
- Global listeners are registered with `registerDomEvent` and cleaned up when the note is closed/re-rendered (no memory leaks).
- `touch-action: none` on the canvas so touch dragging doesn't scroll the page.

## [0.1.3] - 2026-06-17

### Changed

- One-symbol-per-endpoint cardinality notation, just like dbdiagram.io.
- The "one" side derives from the FK nullability: bar (`│`) if `not null`, circle (`○`) if nullable.
- The "many" side draws only the crow's foot (the schema doesn't know the minimum).

## [0.1.2] - 2026-06-17

### Added

- Resizable canvas (handle) and per-diagram `// height: N` directive.
- `--dbml-erd-height` CSS variable for global height.

### Changed

- Relationship notation changed to circle + bar (0..1) on the "one" side.

## [0.1.1] - 2026-06-17

### Fixed

- Relationships of already-moved tables stopped following their endpoints when dragging another table. Now any edge touching a moved table is re-routed with manhattan.

## [0.1.0] - 2026-06-17

### Added

- Render of `dbml` / `DBML` blocks to an SVG ERD.
- Automatic layout with elkjs (`elk.layered`, orthogonal routing).
- Hybrid routing: ELK on load, manhattan on drag.
- Draggable tables, pan, zoom, fit.
- PK / FK icons, `NN` badge, theme integrated with Obsidian variables.
