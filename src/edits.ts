// Ediciones estructurales del bloque hechas desde el canvas: crear tablas y
// áreas, editar áreas y cambiar la pertenencia de las tablas. Sin DOM ni
// Obsidian, para reutilizarse tal cual en el port a VS Code.
//
// Cada función recibe (lines, start, end, …), modifica `lines` y devuelve true
// si pudo; con false, `lines` queda intacto. `start` y `end` delimitan el
// bloque, cercas ```` ``` ```` incluidas si las hay.
import {
  ANY_MEMBER_RE,
  GROUP_HEAD_RE,
  emptiedGroupLines,
  esc,
  findTableRange,
  groupMemberLines,
  memberLineRe,
  parseDBML,
  scanNonTableBlocks,
} from "./parser";

export const NAME_RE = /^[A-Za-z0-9_]+$/;
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;
const FENCE_RE = /^\s*(```|~~~)/;

// ---- lectura del bloque ----

export function tableNames(lines: string[], start: number, end: number): string[] {
  return parseDBML(lines.slice(start, end + 1).join("\n")).tables.map((t) => t.name);
}

export interface GroupBlock {
  name: string;
  open: number; // línea `TableGroup nombre … {`
  close: number; // línea `}`
}

// Áreas escritas en el texto, incluidas las vacías. Solo se reconocen las que
// abren `{` en la misma línea del encabezado (como las escribe el plugin).
export function groupBlocks(lines: string[], start: number, end: number): GroupBlock[] {
  const out: GroupBlock[] = [];
  for (const b of scanNonTableBlocks(lines, start, end)) {
    if (b.kind !== "tablegroup") continue;
    const m = lines[b.open].match(GROUP_HEAD_RE);
    if (m) out.push({ name: m[1], open: b.open, close: b.close });
  }
  return out;
}

// ---- utilidades internas ----

function eol(lines: string[], start: number): string {
  return (lines[start] ?? "").endsWith("\r") ? "\r" : "";
}

function lastTableClose(lines: string[], start: number, end: number): number {
  let last = -1;
  for (const n of tableNames(lines, start, end)) {
    const r = findTableRange(lines, start, end, n);
    if (r) last = Math.max(last, r[1]);
  }
  return last;
}

function firstContentLine(lines: string[], start: number): number {
  return FENCE_RE.test(lines[start] ?? "") ? start + 1 : start;
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

// Inserta un fragmento en `idx`, separándolo con líneas vacías de lo que haya
// antes y después (salvo cercas y anotaciones `// @`).
function insertBlock(lines: string[], start: number, idx: number, block: string[]) {
  const cr = eol(lines, start);
  const out = block.map((l) => l + cr);
  const before = lines[idx - 1];
  const after = lines[idx];
  if (before !== undefined && !isBlank(before) && !FENCE_RE.test(before)) out.unshift(cr);
  if (after !== undefined && !isBlank(after) && !FENCE_RE.test(after) && !/^\s*\/\/\s*@/.test(after))
    out.push(cr);
  lines.splice(idx, 0, ...out);
}

// Borra las líneas indicadas y, si quedan dos líneas vacías seguidas donde
// estaba el primer borrado, deja una.
function removeLines(lines: string[], idxs: Set<number>) {
  if (!idxs.size) return;
  const sorted = [...idxs].sort((a, b) => b - a);
  for (const i of sorted) lines.splice(i, 1);
  const at = sorted[sorted.length - 1];
  if (isBlank(lines[at - 1]) && isBlank(lines[at])) lines.splice(at, 1);
}

// Quita las líneas de miembro de `table` en todas las áreas, salvo en
// `keepGroup`, y elimina las áreas que queden vacías con su línea @group.
// Devuelve cuántas líneas se borraron.
function removeMemberLines(
  lines: string[],
  start: number,
  end: number,
  table: string,
  keepGroup?: string
): number {
  const keep = keepGroup
    ? groupBlocks(lines, start, end).find((g) => g.name === keepGroup)
    : undefined;
  const member = memberLineRe(table);
  const rm = new Set<number>();
  for (const i of groupMemberLines(lines, start, end)) {
    if (keep && i > keep.open && i < keep.close) continue;
    if (member.test(lines[i])) rm.add(i);
  }
  if (!rm.size) return 0;
  for (const i of emptiedGroupLines(lines, start, end, rm)) rm.add(i);
  const before = lines.length;
  removeLines(lines, rm);
  return before - lines.length;
}

// ---- ediciones ----

// Crea `Table <nombre> { id integer [pk, not null] }` después de la última
// tabla (antes de las áreas, los `Ref:` y las anotaciones).
export function addTableInBlock(
  lines: string[],
  start: number,
  end: number,
  name: string
): boolean {
  if (!NAME_RE.test(name)) return false;
  if (tableNames(lines, start, end).includes(name)) return false;
  const last = lastTableClose(lines, start, end);
  const idx = last >= 0 ? last + 1 : firstContentLine(lines, start);
  insertBlock(lines, start, idx, [`Table ${name} {`, "  id integer [pk, not null]", "}"]);
  return true;
}

// Crea un área con las tablas indicadas (las que existan), sacándolas antes de
// sus áreas actuales. Va después de las tablas y de las áreas existentes.
export function addGroupInBlock(
  lines: string[],
  start: number,
  end: number,
  name: string,
  tables: string[],
  color?: string
): boolean {
  if (!NAME_RE.test(name)) return false;
  if (color !== undefined && !HEX_COLOR_RE.test(color)) return false;
  if (groupBlocks(lines, start, end).some((g) => g.name === name)) return false;
  const known = new Set(tableNames(lines, start, end));
  const members = [...new Set(tables)].filter((t) => known.has(t));
  if (!members.length) return false;
  let e = end;
  for (const t of members) e -= removeMemberLines(lines, start, e, t);
  const lastGroup = Math.max(-1, ...groupBlocks(lines, start, e).map((g) => g.close));
  const last = Math.max(lastGroup, lastTableClose(lines, start, e));
  const idx = last >= 0 ? last + 1 : firstContentLine(lines, start);
  insertBlock(lines, start, idx, [
    `TableGroup ${name}${color ? ` [color: ${color}]` : ""} {`,
    ...members.map((t) => `  ${t}`),
    "}",
  ]);
  return true;
}

// Renombra un área en su encabezado y en su línea `// @group`.
export function renameGroupInBlock(
  lines: string[],
  start: number,
  end: number,
  oldName: string,
  newName: string
): boolean {
  if (!NAME_RE.test(newName)) return false;
  const groups = groupBlocks(lines, start, end);
  const g = groups.find((x) => x.name === oldName);
  if (!g) return false;
  if (oldName === newName) return true;
  if (groups.some((x) => x.name === newName)) return false;
  lines[g.open] = lines[g.open].replace(
    new RegExp(`^(\\s*TableGroup\\s+)"?${esc(oldName)}"?`, "i"),
    `$1${newName}`
  );
  const state = new RegExp(`^(\\s*//\\s*@group\\s+)"?${esc(oldName)}"?(\\s+collapsed\\b)`);
  for (let i = start; i <= end && i < lines.length; i++)
    if (state.test(lines[i])) lines[i] = lines[i].replace(state, `$1${newName}$2`);
  return true;
}

// Pone, cambia o quita (`null`) el color de un área, sin tocar otros settings.
export function setGroupColorInBlock(
  lines: string[],
  start: number,
  end: number,
  name: string,
  color: string | null
): boolean {
  if (color !== null && !HEX_COLOR_RE.test(color)) return false;
  const g = groupBlocks(lines, start, end).find((x) => x.name === name);
  if (!g) return false;
  const raw = lines[g.open];
  const cr = raw.endsWith("\r") ? "\r" : "";
  const m = raw
    .slice(0, raw.length - cr.length)
    .match(/^(\s*TableGroup\s+"?[A-Za-z0-9_]+"?)\s*(?:\[([^\]]*)\])?\s*(\{.*)?$/i);
  if (!m) return false;
  const parts = (m[2] ?? "")
    .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((p) => p.trim())
    .filter((p) => p && !/^color\s*:/i.test(p));
  if (color) parts.push(`color: ${color}`);
  const bracket = parts.length ? ` [${parts.join(", ")}]` : "";
  const rest = m[3] ? ` ${m[3]}` : "";
  lines[g.open] = m[1] + bracket + rest + cr;
  return true;
}

// Quita un área: borra su bloque y su línea `// @group`. Las tablas quedan.
export function removeGroupInBlock(
  lines: string[],
  start: number,
  end: number,
  name: string
): boolean {
  const g = groupBlocks(lines, start, end).find((x) => x.name === name);
  if (!g) return false;
  const rm = new Set<number>();
  for (let i = g.open; i <= g.close; i++) rm.add(i);
  const state = new RegExp(`^\\s*//\\s*@group\\s+"?${esc(name)}"?\\s+collapsed\\b`);
  for (let i = start; i <= end && i < lines.length; i++) if (state.test(lines[i])) rm.add(i);
  removeLines(lines, rm);
  return true;
}

// Mueve una tabla a un área (`group`) o la saca de la suya (`null`). Las áreas
// que queden vacías se eliminan. El miembro nuevo va después del último.
export function moveTableToGroupInBlock(
  lines: string[],
  start: number,
  end: number,
  table: string,
  group: string | null
): boolean {
  if (!tableNames(lines, start, end).includes(table)) return false;
  if (group !== null && !groupBlocks(lines, start, end).some((g) => g.name === group))
    return false;
  const e = end - removeMemberLines(lines, start, end, table, group ?? undefined);
  if (group === null) return true;
  const g = groupBlocks(lines, start, e).find((x) => x.name === group);
  if (!g) return false;
  const member = memberLineRe(table);
  let idx = g.open + 1;
  let indent = "  ";
  for (let i = g.open + 1; i < g.close; i++) {
    if (member.test(lines[i])) return true; // ya es miembro
    if (ANY_MEMBER_RE.test(lines[i])) {
      idx = i + 1;
      indent = (lines[i].match(/^\s*/) ?? [""])[0];
    }
  }
  lines.splice(idx, 0, `${indent}${table}${eol(lines, start)}`);
  return true;
}

// Fija posiciones: reemplaza o agrega `// @pos <tabla> <x> <y>` (redondeado)
// para cada tabla indicada, sin tocar otras anotaciones. Las nuevas van al
// final del bloque, antes de la cerca de cierre.
export function setPositionsInBlock(
  lines: string[],
  start: number,
  end: number,
  positions: Record<string, { x: number; y: number }>
): boolean {
  const cr = eol(lines, start);
  let e = end;
  for (const [t, p] of Object.entries(positions)) {
    if (!NAME_RE.test(t) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const text = `// @pos ${t} ${Math.round(p.x)} ${Math.round(p.y)}`;
    const re = new RegExp(`^\\s*//\\s*@pos\\s+"?${esc(t)}"?\\s`);
    let found = false;
    for (let i = start; i <= e && i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      lines[i] = text + cr;
      found = true;
    }
    if (found) continue;
    const idx = FENCE_RE.test(lines[e] ?? "") && e > start ? e : e + 1;
    lines.splice(idx, 0, text + cr);
    e++;
  }
  return true;
}
