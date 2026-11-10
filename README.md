# DBML ER Diagrams

Obsidian plugin that renders ` ```dbml ` code blocks as **interactive entity-relationship diagrams**, with **orthogonal, dbdiagram.io-style routing** (right-angle lines), crow's-foot notation (crow's foot / bar) and direct editing on the canvas.

- **Plugin ID:** `dbml-erd`
- **Name:** DBML ER Diagrams
- **Author:** Wilmar Rojas Avendaño · **License:** MIT
- **Minimum Obsidian version:** 1.6.0 · Works on desktop and mobile.

---

## What it does

You write a ` ```dbml ` block with your tables and relationships and the plugin draws it as an SVG ERD, with automatic layout, cardinality markers and interactive editing. Every change you make from the diagram (rename, move, color, cardinality, delete…) is written back into the note's own dbml block — the block is the single source of truth.

### Render and layout

- Renders `dbml` / `DBML` blocks to an SVG ERD.
- Automatic layout with [elkjs](https://github.com/kieler/elkjs) (`elk.layered`) that minimizes crossings.
- **Orthogonal (90°) routing** in dbdiagram.io style, with rounded corners; lines re-route live as you move tables.
- Layout cache by structure: saving the layout does not recompute the layout nor cause flicker.
- Theme integrated with Obsidian variables (automatic light/dark).

### Notation

- **One symbol per endpoint for cardinality**: crow's foot on the "many" side; on the "one" side, a bar (`│`) if the FK is `not null`, or a circle (`○`) if it is nullable.
- **PK** (🔑) and **FK** (🔗) icons, **`NN`** badge for `not null` columns.
- Per-table header color (text adjusts to white or dark depending on the background).

### Canvas navigation

- **Pan** (drag the empty space), **zoom** (mouse wheel), `+` / `−` / `⊡` (fit) buttons.
- **Resizable** canvas (width and height).
- Table positions, zoom/pan and canvas size are **persisted inside the block** and restored when you reopen the note.

### Interactive editing (from the diagram)

Everything is saved back to the dbml block:

- **Table header** (click the node header) → menu:
  - Rename table… (also updates references).
  - Pick color… / Remove color.
  - Delete table… (with confirmation dialog; removes the table and the relationships that reference it).
- **Column row** (click a column) → menu:
  - Rename column… (updates `table.col` references).
  - Change type…
- **Connection / relationship** (click the line):
  - First click: **selects** it and shows the route vertices.
  - Second click: menu with the **relationship type (cardinality)** — One to many, Many to one, One to one, Many to many (the current one is checked) —, "Reset route" (if hand-edited) and "Deselect".
- **Route vertices** (with the connection selected):
  - Add: tap/drag the `+` handle in the middle of a segment.
  - Move: drag a vertex (the line re-orthogonalizes itself to 90°).
  - Delete: **right-click** on a vertex → "Delete vertex"; if it was the last one, the route returns to automatic mode.

### Language

The interface (menus, dialogs and notices) is available in **English** (default) and **Spanish**. Switch it under **Settings → Community plugins → DBML ER Diagrams → Language**.

---

## Usage

Insert a code block with the `dbml` language:

````markdown
```dbml
// height: 600

Table contract {
  contract_id   int          [pk]
  contract_name varchar(120) [not null]
  client_id     int          [not null]
  status        varchar(20)
}

Table client {
  client_id int          [pk]
  name      varchar(100) [not null]
}

Ref: contract.client_id > client.client_id
```
````

### Supported syntax

- `Table name { ... }` (keyword in any case, and the short form `name { ... }`).
- Columns: `name type [pk, not null, note: '...', ref: > other.col]`, one per line.
- Relationships: a `Ref: a.col > b.col` line (optionally named, `Ref fk_name: ...`), the long form `Ref { a.col > b.col }`, inline `ref: > b.col`, or the direct form `a.col <> b.col`.
- Cardinality operators: `>` (many→one), `<` (one→many), `<>` (many↔many), `-` (one↔one).
- Per-table header color: `Table name [headercolor: #2E7D32] { ... }`.
- Table and column notes (`Note: '...'`, `note: '...'`) are accepted and kept in the block, but not drawn in the diagram.
- Optional `// height: N` directive (canvas height in px).
- `//` and `/* ... */` comments.
- `indexes { }`, `enum`, `TableGroup`, `Project` and sticky `Note` blocks are accepted and ignored.

> A deliberate subset of DBML, enough for controlled schemas. It does not yet include enums, table groups or composite keys.

### Layout annotations (managed by the plugin)

The plugin stores the visual state as comments inside the block; you don't need to edit them by hand:

- `// @pos <table> <x> <y>` — position of a moved table.
- `// @view <x> <y> <zoom>` — pan and zoom.
- `// @size <w> <h>` — canvas size.
- `// @edge <from> <fromCol> <to> <toCol> <x1> <y1> …` — vertices of a hand-edited route.

---

## Generate the DBML automatically (`sql-to-dbml` skill)

So you don't have to write the DBML by hand there is a Claude Code skill, **`sql-to-dbml`**, that converts SQL `CREATE TABLE` scripts (ANSI, SQL Server, PostgreSQL or MySQL) — or tables you define during the conversation — into DBML compatible with this plugin (it degrades to what the plugin draws, never emitting syntax it can't understand).

- Repository: <https://github.com/wrojasa/skill-sql-to-dbml>
- Typical triggers: "convert this CREATE TABLE to dbml", "generate the dbml for these tables", "build the ERD in dbml", "add this table to the dbml", "update the dbml with…".

Paste the resulting block into a note inside ` ```dbml ` and the plugin renders it.

---

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Copy the three files to `<vault>/.obsidian/plugins/dbml-erd/`.
3. Enable the plugin under **Settings → Community plugins**.

---

## Development

```bash
npm install
npm run dev     # build with inline sourcemaps
npm run build   # minified production build
```

Code structure:

- `src/main.ts` — plugin, block rendering and the `Diagram` class (SVG, interaction, persistence).
- `src/parser.ts` — DBML parser (subset) and block mutators (rename, types, cardinality, delete).
- `src/layout.ts` — layout with elkjs and geometry constants.
- `src/i18n.ts` — interface strings (English/Spanish) and the `t()` lookup.
- `styles.css` — styles integrated with Obsidian's theme variables.

## Release

Releases are produced with GitHub Actions (`.github/workflows/release.yml`).
To publish a new version: bump `version` in `manifest.json` and `package.json`,
add the entry to `versions.json` and `CHANGELOG.md`, create a tag with that exact
number (no `v` prefix) and push it:

```bash
# use the exact number from the manifest, without the v prefix
git tag 0.1.19
git push origin 0.1.19
```

The workflow compiles and attaches `main.js`, `manifest.json` and `styles.css` to the release.

## License

MIT © 2026 Wilmar Rojas Avendaño
