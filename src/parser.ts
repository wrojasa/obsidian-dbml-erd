// Parser DBML mínimo (subset suficiente para BD_SIOM).
// Soporta: Table, columnas con [pk, not null, note, ref inline],
// relaciones Ref: a.col > b.col, inline ref, y forma a.col <> b.col.

export interface Column {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  nn: boolean;
  note?: string;
}
export interface Table {
  name: string;
  note?: string;
  headerColor?: string;
  cols: Column[];
}
export type Cardinality = ">" | "<" | "<>" | "-";
export interface Ref {
  from: string;
  fromCol: string;
  to: string;
  toCol: string;
  op: Cardinality;
}
// Área de trabajo: un `TableGroup` con sus tablas miembro (solo las que
// existen, sin repetir y en el orden del texto) y su color opcional.
export interface Group {
  name: string;
  color?: string;
  tables: string[];
}
export interface Model {
  tables: Table[];
  refs: Ref[];
  groups: Group[];
}

// Palabra clave `Table` sin distinguir mayúsculas (como en dbdiagram.io), sin
// volver insensible el nombre de la tabla que la sigue.
const TABLE_KW = "[Tt][Aa][Bb][Ll][Ee]";

// Bloques DBML de nivel raíz que no son tablas. Escritos sin nombre
// (`TableGroup {`, `enum {`, `Note {`, `Ref {`) casan con la forma corta de
// tabla, así que se descartan explícitamente para no dibujar tablas fantasma.
const NON_TABLE_BLOCKS = new Set([
  "tablegroup",
  "enum",
  "project",
  "note",
  "ref",
  "indexes",
]);

// `note: '...'` o `note: "..."` dentro de los settings de una columna. La nota
// termina en la comilla seguida de `,` o `]`, así un apóstrofo interno
// ("it's") no la corta ni deja texto suelto que se lea como setting.
const COL_NOTE_RE = /note:\s*(?:'(.*?)'|"(.*?)")(?=\s*(?:,|\]|$))/i;
const INLINE_REF_RE = /ref:\s*(<>|>|<|-)\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/i;

function countBraces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === "{") n++;
    else if (ch === "}") n--;
  }
  return n;
}

// Dado el índice de una comilla simple en src, devuelve el índice del carácter
// SIGUIENTE al cierre de esa cadena. Soporta cadenas triple ('''...'''),
// escape \' y cadenas de una línea sin cerrar (corta en el salto de línea, lo
// que hace que un apóstrofo suelto no desincronice el resto del documento).
function skipString(src: string, i: number): number {
  if (src[i] === "'" && src[i + 1] === "'" && src[i + 2] === "'") {
    const end = src.indexOf("'''", i + 3);
    return end < 0 ? src.length : end + 3;
  }
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "'") return j + 1;
    if (ch === "\n") return j; // cadena de una línea sin cerrar: apóstrofo suelto
    j++;
  }
  return src.length;
}

// Quita comentarios de línea // y de bloque /* … */ respetando cadenas entre
// comillas simples (así un Note: 'ver http://x' o un default con // no se
// trunca). Los saltos de línea dentro de un /* … */ se conservan para que las
// declaraciones siguientes sigan empezando en su propia línea.
function stripLineComments(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'") {
      const end = skipString(input, i);
      out += input.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue; // el salto de línea lo agrega la próxima vuelta
    }
    if (ch === "/" && input[i + 1] === "*") {
      const close = input.indexOf("*/", i + 2);
      const stop = close < 0 ? input.length : close + 2;
      for (let k = i; k < stop; k++) if (input[k] === "\n") out += "\n";
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function scanBrace(src: string, openIdx: number, skipStr: boolean): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    if (skipStr && ch === "'") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Dado el índice de un '{', devuelve el índice de su '}' emparejado contando
// profundidad. Primero intenta saltando cadenas; si no cierra (comillas raras),
// reintenta contando llaves crudas para NUNCA descartar una tabla por completo.
function matchBrace(src: string, openIdx: number): number {
  const withStr = scanBrace(src, openIdx, true);
  return withStr >= 0 ? withStr : scanBrace(src, openIdx, false);
}

export function parseDBML(input: string): Model {
  // BOM (U+FEFF) pegado desde archivos o la web: no es [ \t] y anularía la
  // declaración de tabla que tenga delante.
  const src = stripLineComments(input.replace(/﻿/g, ""));
  const tables: Table[] = [];
  const refs: Ref[] = [];

  const relRe =
    /(?:Ref:\s*)?([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*(<>|>|<|-)\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g;
  // Declaración de tabla: 'Table' opcional (grupo 1), nombre opc. entre
  // comillas (grupo 2), 'as alias' opcional, [settings] opcional (grupo 3),
  // hasta la '{' de apertura. Tolera NBSP de texto pegado desde la web.
  const declRe = new RegExp(
    `(?:^|\\n)[ \\t\\u00a0]*(?:(${TABLE_KW})[ \\t\\u00a0]+)?"?([A-Za-z0-9_]+)"?\\s*(?:as\\s+\\w+\\s*)?(?:\\[([^\\]]*)\\]\\s*)?\\{`,
    "g"
  );

  const bodies: [number, number][] = [];
  let m: RegExpExecArray | null;

  while ((m = declRe.exec(src)) !== null) {
    const hasKeyword = !!m[1];
    const name = m[2];
    const settings = m[3] || "";
    const braceIdx = m.index + m[0].length - 1; // m[0] termina en '{'
    const closeIdx = matchBrace(src, braceIdx);
    if (closeIdx < 0) continue;
    if (!hasKeyword && NON_TABLE_BLOCKS.has(name.toLowerCase())) {
      // `TableGroup {`, `enum {`, `Note {`… sin nombre: no es una tabla. Su
      // cuerpo se excluye del escaneo de relaciones, salvo `Ref { … }`, cuyas
      // relaciones sí deben leerse.
      if (name.toLowerCase() !== "ref") bodies.push([m.index, closeIdx + 1]);
      declRe.lastIndex = closeIdx + 1;
      continue;
    }
    const body = src.slice(braceIdx + 1, closeIdx);
    bodies.push([m.index, closeIdx + 1]);

    const cols: Column[] = [];
    let tableNote: string | undefined;
    const hcMatch = settings.match(
      /header[_ ]?color:\s*([#A-Za-z0-9(),.\s%]+?)\s*(?:,|$)/i
    );
    const headerColor = hcMatch ? hcMatch[1].trim() : undefined;

    let skipDepth = 0; // sub-bloques indexes { ... } / Note { ... }
    let awaitBrace = false; // `indexes` o `Note` con la llave en la línea siguiente
    let tripleNote: string[] | null = null; // Note: ''' … ''' en varias líneas
    for (let line of body.split("\n")) {
      line = line.trim();
      if (tripleNote) {
        const end = line.indexOf("'''");
        if (end < 0) {
          tripleNote.push(line);
          continue;
        }
        tripleNote.push(line.slice(0, end));
        tableNote = tripleNote.join(" ").replace(/\s+/g, " ").trim();
        tripleNote = null;
        continue;
      }
      if (awaitBrace) {
        awaitBrace = false;
        if (line.startsWith("{")) {
          skipDepth = countBraces(line);
          continue;
        }
      }
      if (skipDepth > 0) {
        skipDepth += countBraces(line);
        continue;
      }
      if (!line || line === "{" || line === "}") continue;
      const tq = line.match(/^Note:\s*'''(.*)$/i);
      if (tq) {
        const end = tq[1].indexOf("'''");
        if (end >= 0) tableNote = tq[1].slice(0, end).trim();
        else tripleNote = [tq[1]];
        continue;
      }
      // hasta la ÚLTIMA comilla de la línea: un apóstrofo interno no la corta
      const tn = line.match(/^Note:\s*(?:'(.*)'|"(.*)")\s*$/i);
      if (tn) {
        tableNote = (tn[1] ?? tn[2]).replace(/\\'/g, "'");
        continue;
      }
      if (/^(?:indexes|note)\s*\{/i.test(line)) {
        skipDepth = countBraces(line);
        continue;
      }
      if (/^(?:indexes|note)$/i.test(line)) {
        awaitBrace = true;
        continue;
      }
      const cm = line.match(/^([A-Za-z0-9_]+)\s+([^[\n]+?)\s*(\[.*\])?\s*$/);
      if (!cm) continue;
      const rawAttrs = cm[3] || "";
      const noteM = rawAttrs.match(COL_NOTE_RE);
      // settings sin la nota: su texto nunca cuenta como pk / not null / ref
      const rest = rawAttrs.replace(COL_NOTE_RE, "");
      const ir = rest.match(INLINE_REF_RE);
      // flags sin valores entre comillas (p. ej. default: 'not null') ni el
      // destino del ref (p. ej. ref: > a.pk), que darían falsos positivos
      const flags = rest
        .replace(/'[^']*'|"[^"]*"/g, "")
        .replace(/ref:\s*(?:<>|>|<|-)\s*[^,\]]*/gi, "")
        .toLowerCase();
      const note = noteM ? noteM[1] ?? noteM[2] : undefined;
      const col: Column = {
        name: cm[1],
        type: cm[2],
        pk: /\bpk\b|\bprimary\s+key\b/.test(flags),
        fk: false,
        nn: /\bnot\s+null\b/.test(flags),
        note: note?.replace(/\\'/g, "'"),
      };
      cols.push(col);
      if (ir) {
        refs.push({
          from: name,
          fromCol: cm[1],
          op: ir[1] as Cardinality,
          to: ir[2],
          toCol: ir[3],
        });
      }
    }
    tables.push({ name, note: tableNote, headerColor, cols });
    declRe.lastIndex = closeIdx + 1; // no re-escanear dentro del cuerpo
  }

  // Áreas de trabajo: `TableGroup nombre [color: #hex] { tabla … }`. Se leen
  // antes que los demás bloques para que su cuerpo (que puede llevar settings
  // con `:`) quede fuera del escaneo de relaciones.
  const groups = parseGroups(src, tables, bodies);

  // Bloques con nombre que no son tablas (`enum x {`, `TableGroup g {`,
  // `Note n {`, `Project p {`): su contenido no debe leerse como relaciones.
  // `Ref nombre { … }` sí contiene relaciones y no se excluye.
  const blockRe =
    /(?:^|\n)[ \t]*(enum|TableGroup|Project|Note|Ref)[ \t]+[^\n{:]*\{/gi;
  while ((m = blockRe.exec(src)) !== null) {
    const idx = m.index;
    if (bodies.some(([s, e]) => idx >= s && idx < e)) continue;
    const closeIdx = matchBrace(src, m.index + m[0].length - 1);
    if (closeIdx < 0) continue;
    if (m[1].toLowerCase() !== "ref") bodies.push([idx, closeIdx + 1]);
    blockRe.lastIndex = closeIdx + 1;
  }

  while ((m = relRe.exec(src)) !== null) {
    const idx = m.index;
    if (bodies.some(([s, e]) => idx >= s && idx < e)) continue;
    refs.push({
      from: m[1],
      fromCol: m[2],
      op: m[3] as Cardinality,
      to: m[4],
      toCol: m[5],
    });
  }

  // Valida y deduplica refs: descarta las que apuntan a tablas/columnas
  // inexistentes (typos y "refs fantasma" de prosa) y las duplicadas.
  const byName = new Map(tables.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const validRefs: Ref[] = [];
  for (const r of refs) {
    const tf = byName.get(r.from);
    const tt = byName.get(r.to);
    if (!tf || !tt) continue;
    if (!tf.cols.some((c) => c.name === r.fromCol)) continue;
    if (!tt.cols.some((c) => c.name === r.toCol)) continue;
    const key = `${r.from}.${r.fromCol}|${r.op}|${r.to}.${r.toCol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    validRefs.push(r);
  }

  // marca FKs: la columna del lado "muchos". En `<` es la de 'to'; en `>`,
  // `-` y `<>`, la de 'from' (mismo criterio que la marca de cardinalidad).
  for (const r of validRefs) {
    const [ft, fc] = r.op === "<" ? [r.to, r.toCol] : [r.from, r.fromCol];
    const c = byName.get(ft)?.cols.find((c) => c.name === fc);
    if (c) c.fk = true;
  }

  return { tables, refs: validRefs, groups };
}

// Lee los `TableGroup` con nombre y registra sus cuerpos en `bodies` para que
// no se escaneen como relaciones. Reglas: la palabra clave no distingue
// mayúsculas; el color sale de `color: #rgb|#rrggbb`; cada línea con un nombre
// de tabla es un miembro (también `esquema.tabla`, del que se toma la tabla);
// se ignoran notas, líneas vacías y nombres inexistentes; una tabla pertenece
// solo a la primera área que la lista; un nombre de área repetido se ignora;
// un área sin miembros válidos no se devuelve.
function parseGroups(
  src: string,
  tables: Table[],
  bodies: [number, number][]
): Group[] {
  const known = new Set(tables.map((t) => t.name));
  const taken = new Set<string>();
  const names = new Set<string>();
  const out: Group[] = [];
  const re =
    /(?:^|\n)[ \t ]*TableGroup[ \t ]+"?([A-Za-z0-9_]+)"?[ \t ]*(?:\[([^\]\n]*)\])?\s*\{/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const idx = m.index;
    if (bodies.some(([s, e]) => idx >= s && idx < e)) continue;
    const closeIdx = matchBrace(src, m.index + m[0].length - 1);
    if (closeIdx < 0) continue;
    bodies.push([idx, closeIdx + 1]);
    re.lastIndex = closeIdx + 1;
    const name = m[1];
    if (names.has(name)) continue;
    names.add(name);
    const cm = (m[2] || "").match(/color:\s*(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\b/i);
    const body = src.slice(m.index + m[0].length, closeIdx);
    const members: string[] = [];
    let depth = 0; // salta sub-bloques como `Note { … }`
    for (let line of body.split("\n")) {
      line = line.trim();
      if (depth > 0) {
        depth += countBraces(line);
        continue;
      }
      if (/^note\s*\{/i.test(line)) {
        depth = countBraces(line);
        continue;
      }
      const mm = line.match(/^"?(?:[A-Za-z0-9_]+"?\."?)?([A-Za-z0-9_]+)"?$/);
      if (!mm) continue;
      const t = mm[1];
      if (!known.has(t) || taken.has(t)) continue;
      taken.add(t);
      members.push(t);
    }
    if (members.length)
      out.push({ name, color: cm ? cm[1] : undefined, tables: members });
  }
  return out;
}

// Áreas colapsadas guardadas en el bloque como `// @group <nombre> collapsed`.
export function parseGroupState(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\/\/[ \t]*@group[ \t]+"?([A-Za-z0-9_]+)"?[ \t]+collapsed\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

// Reemplaza coincidencias de re en line solo FUERA de cadenas entre comillas
// simples (no toca el texto de notas).
function replaceOutsideStrings(
  line: string,
  re: RegExp,
  repl: string
): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const q = line.indexOf("'", i);
    if (q < 0) {
      out += line.slice(i).replace(re, repl);
      break;
    }
    out += line.slice(i, q).replace(re, repl);
    const end = line.indexOf("'", q + 1);
    if (end < 0) {
      out += line.slice(q); // comilla sin cerrar: deja el resto tal cual
      break;
    }
    out += line.slice(q, end + 1); // segmento de cadena intacto
    i = end + 1;
  }
  return out;
}

// Edita la línea de declaración de una tabla para fijar/quitar headercolor.
// Tolera la '{' en esta línea o en la siguiente (consistente con findTableRange).
// Devuelve la línea nueva, o null si la línea no declara esa tabla.
export function setHeaderColorInLine(
  line: string,
  tableName: string,
  color: string | null
): string | null {
  if (color !== null && /[\]',\n]|\/\//.test(color)) return null; // evita romper el bloque
  const e = esc(tableName);
  const re = new RegExp(
    `^(\\s*(?:${TABLE_KW}\\s+)?"?${e}"?\\s*(?:as\\s+\\w+\\s*)?)(\\[[^\\]]*\\])?\\s*(\\{.*)?$`
  );
  const m = line.match(re);
  if (!m) return null;
  // sin `Table` ni `{` es una columna sin tipo (`  user [pk]`), no la tabla
  if (!new RegExp(`^\\s*${TABLE_KW}\\s`).test(line) && !m[3]) return null;
  const head = m[1].replace(/\s+$/, "");
  const inner = (m[2] || "").replace(/^\[|\]$/g, "");
  const rest = m[3] ? " " + m[3].replace(/^\s*/, "") : "";

  // separa settings por coma respetando comillas simples
  const parts = inner
    ? inner
        .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  const filtered = parts.filter((p) => !/^header[_ ]?color\s*:/i.test(p));
  if (color) filtered.push(`headercolor: ${color}`);

  const bracket = filtered.length ? ` [${filtered.join(", ")}]` : "";
  return head + bracket + rest;
}

// ---- edición de textos (rename / tipo) sobre las líneas del bloque ----

export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Bloques que no son tablas (`TableGroup`, `enum`, `Note`, `Project`, `Ref`,
// `indexes`) dentro del rango, como [tipo en minúsculas, línea de apertura,
// línea de cierre]. Las llaves se cuentan sin las cadenas entre comillas
// simples, así `Note: 'a {'` no abre nada.
export interface LineBlock {
  kind: string;
  open: number;
  close: number;
}
export function scanNonTableBlocks(
  lines: string[],
  start: number,
  end: number
): LineBlock[] {
  const out: LineBlock[] = [];
  const head = /^\s*(TableGroup|enum|Note|Project|Ref|indexes)\b[^{]*\{/i;
  const last = Math.min(end, lines.length - 1);
  for (let i = start; i <= last; i++) {
    const plain = lines[i].replace(/'[^']*'/g, "");
    const m = plain.match(head);
    if (!m) continue;
    let depth = countBraces(plain);
    let j = i;
    while (depth > 0 && j < last) {
      j++;
      depth += countBraces(lines[j].replace(/'[^']*'/g, ""));
    }
    out.push({ kind: m[1].toLowerCase(), open: i, close: j });
    i = j;
  }
  return out;
}

function linesInBlocks(blocks: LineBlock[]): Set<number> {
  const s = new Set<number>();
  for (const b of blocks) for (let i = b.open; i <= b.close; i++) s.add(i);
  return s;
}

// localiza [lineaDeclaracion, lineaCierre] de una tabla dentro del rango del bloque.
// El conteo de llaves ignora las que aparezcan dentro de cadenas entre comillas.
export function findTableRange(
  lines: string[],
  start: number,
  end: number,
  name: string
): [number, number] | null {
  const e = esc(name);
  // Con `Table`, el nombre debe terminar ahí (`Table user` no casa con
  // `Table user_role`); sin `Table`, la línea debe abrir `{`. Antes bastaba con
  // que la línea EMPEZARA por el nombre, y renombrar o borrar `user` atacaba la
  // primera tabla `user_role` o columna `user_id` declarada antes.
  const declRe = new RegExp(
    `^\\s*(?:${TABLE_KW}\\s+"?${e}"?(?![A-Za-z0-9_])|"?${e}"?\\s*(?:as\\s+\\w+\\s*)?(?:\\[[^\\]]*\\]\\s*)?(?:\\{|$))`
  );
  // Las líneas de miembro de un `TableGroup` (`  pedido`) parecen la forma
  // corta de una declaración: se saltan los cuerpos de bloques que no son tablas.
  const skip = linesInBlocks(scanNonTableBlocks(lines, start, end));
  let decl = -1;
  for (let i = start; i <= end && i < lines.length; i++) {
    if (skip.has(i)) continue;
    if (declRe.test(lines[i])) {
      decl = i;
      break;
    }
  }
  if (decl < 0) return null;
  // reúsa el emparejado robusto de matchBrace sobre el texto del rango
  const lastLine = Math.min(end, lines.length - 1);
  const seg = lines.slice(decl, lastLine + 1).join("\n");
  const openIdx = seg.indexOf("{");
  if (openIdx < 0) return null;
  const closeOff = matchBrace(seg, openIdx);
  if (closeOff < 0) return null;
  let close = decl;
  for (let k = 0; k < closeOff; k++) if (seg[k] === "\n") close++;
  return [decl, close];
}

// Renombra una tabla y actualiza referencias y comentarios @pos. Muta lines.
export function renameTableInBlock(
  lines: string[],
  start: number,
  end: number,
  oldName: string,
  newName: string
): boolean {
  if (!/^[A-Za-z0-9_]+$/.test(newName)) return false;
  const range = findTableRange(lines, start, end, oldName);
  if (!range) return false;
  const [decl] = range;
  const e = esc(oldName);
  lines[decl] = lines[decl].replace(
    new RegExp(`^(\\s*(?:${TABLE_KW}\\s+)?)"?${e}"?`),
    `$1${newName}`
  );
  // referencias tabla.col: solo fuera de cadenas y solo cuando hay columna detrás
  const refRe = new RegExp(`\\b${e}\\.(?=[A-Za-z0-9_])`, "g");
  const posRe = new RegExp(`^(\\s*//\\s*@pos\\s+)"?${e}"?(\\s)`);
  for (let i = start; i <= end && i < lines.length; i++) {
    if (i === decl) continue;
    const pos = lines[i].match(posRe);
    if (pos) {
      lines[i] = lines[i].replace(posRe, `$1${newName}$2`);
      continue; // los @pos no contienen refs reales
    }
    if (/^\s*\/\/\s*@edge\b/.test(lines[i])) {
      lines[i] = rewriteEdgeLine(lines[i], (f, fc, t, tc) => [
        f === oldName ? newName : f,
        fc,
        t === oldName ? newName : t,
        tc,
      ]);
      continue; // los @edge no contienen refs reales
    }
    lines[i] = replaceOutsideStrings(lines[i], refRe, `${newName}.`);
  }
  // la tabla también figura como miembro en su `TableGroup`
  const member = memberLineRe(oldName);
  for (const i of groupMemberLines(lines, start, end)) {
    if (member.test(lines[i])) lines[i] = lines[i].replace(member, `$1${newName}$2`);
  }
  return true;
}

// Línea de miembro de un `TableGroup`: el nombre solo, con `esquema.` opcional.
export function memberLineRe(table: string): RegExp {
  return new RegExp(`^(\\s*(?:"?[A-Za-z0-9_]+"?\\.)?)"?${esc(table)}"?(\\s*)$`);
}

// Índices de las líneas interiores de los cuerpos `TableGroup` del rango.
export function groupMemberLines(lines: string[], start: number, end: number): number[] {
  const out: number[] = [];
  for (const b of scanNonTableBlocks(lines, start, end)) {
    if (b.kind !== "tablegroup") continue;
    for (let i = b.open + 1; i < b.close; i++) out.push(i);
  }
  return out;
}

// cualquier línea de miembro (un nombre de tabla, con `esquema.` opcional)
export const ANY_MEMBER_RE = /^\s*"?(?:[A-Za-z0-9_]+"?\."?)?[A-Za-z0-9_]+"?\s*$/;
// nombre del área en la línea de encabezado `TableGroup nombre …`
export const GROUP_HEAD_RE = /^\s*TableGroup\s+"?([A-Za-z0-9_]+)"?/i;

// Líneas a borrar de las áreas que una edición deja sin tablas: si todas las
// líneas de miembro de un área están en `removed` (y al menos una lo está),
// se borra el bloque completo y su línea `// @group <área> collapsed`. Un
// área vacía no se dibuja ni se alcanza desde el canvas.
export function emptiedGroupLines(
  lines: string[],
  start: number,
  end: number,
  removed: Set<number>
): number[] {
  const out: number[] = [];
  for (const b of scanNonTableBlocks(lines, start, end)) {
    if (b.kind !== "tablegroup") continue;
    let lost = 0;
    let left = 0;
    for (let i = b.open + 1; i < b.close; i++) {
      if (!ANY_MEMBER_RE.test(lines[i])) continue;
      if (removed.has(i)) lost++;
      else left++;
    }
    if (!lost || left) continue;
    for (let i = b.open; i <= b.close; i++) out.push(i);
    const gm = lines[b.open].match(GROUP_HEAD_RE);
    if (!gm) continue;
    const stateRe = new RegExp(`^\\s*//\\s*@group\\s+"?${esc(gm[1])}"?\\s+collapsed\\b`);
    for (let i = start; i <= end && i < lines.length; i++)
      if (stateRe.test(lines[i])) out.push(i);
  }
  return out;
}

// Quita de los settings de una columna el `ref:` inline que apunta a `table`.
// Devuelve la línea intacta si no lo tiene. Si era el único setting, quita
// también los corchetes.
function dropInlineRefTo(line: string, table: string): string {
  const m = line.match(/^(\s*[A-Za-z0-9_]+\s+[^[\n]*?)\s*\[(.*)\](\s*)$/);
  if (!m) return line;
  const target = new RegExp(
    `^ref\\s*:\\s*(?:<>|>|<|-)\\s*"?${esc(table)}"?\\.`,
    "i"
  );
  const parts = m[2]
    .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = parts.filter((p) => !target.test(p));
  if (kept.length === parts.length) return line;
  return kept.length
    ? `${m[1]} [${kept.join(", ")}]${m[3]}`
    : `${m[1]}${m[3]}`;
}

// Elimina una tabla del bloque: su declaración, los comentarios @pos/@edge que
// la mencionan, las relaciones independientes que la referencian en cualquier
// extremo (`Ref:`, `Ref nombre:` o la forma corta `a.c > b.c`) y los `ref:`
// inline de otras tablas que apuntan a ella. Muta lines. Devuelve false si no
// existe.
export function deleteTableInBlock(
  lines: string[],
  start: number,
  end: number,
  name: string
): boolean {
  const range = findTableRange(lines, start, end, name);
  if (!range) return false;
  const [decl, close] = range;
  const e = esc(name);
  const toDelete = new Set<number>();
  for (let i = decl; i <= close; i++) toDelete.add(i);
  // también deja de ser miembro de su `TableGroup`; si era la última tabla,
  // el área se elimina con su línea @group
  const member = memberLineRe(name);
  for (const i of groupMemberLines(lines, start, end))
    if (member.test(lines[i])) toDelete.add(i);
  for (const i of emptiedGroupLines(lines, start, end, toDelete)) toDelete.add(i);
  const refRe = new RegExp(`\\b${e}\\.[A-Za-z0-9_]+`);
  const relLineRe =
    /^\s*(?:Ref\b[^:\n]*:\s*)?"?[A-Za-z0-9_]+"?\.[A-Za-z0-9_]+\s*(?:<>|>|<|-)\s*"?[A-Za-z0-9_]+"?\.[A-Za-z0-9_]+/i;
  const posRe = new RegExp(`^\\s*//\\s*@pos\\s+"?${e}"?(\\s|$)`);
  const edgeRe = new RegExp(
    `^\\s*//\\s*@edge\\s+"?([A-Za-z0-9_]+)"?\\s+"?[A-Za-z0-9_]+"?\\s+"?([A-Za-z0-9_]+)"?\\s`
  );
  for (let i = start; i <= end && i < lines.length; i++) {
    if (toDelete.has(i)) continue;
    if (posRe.test(lines[i])) {
      toDelete.add(i);
      continue;
    }
    const em = lines[i].match(edgeRe);
    if (em) {
      if (em[1] === name || em[2] === name) toDelete.add(i);
      continue;
    }
    if (/^\s*\/\//.test(lines[i])) continue;
    if (relLineRe.test(lines[i]) && refRe.test(lines[i])) {
      toDelete.add(i);
      continue;
    }
    lines[i] = dropInlineRefTo(lines[i], name);
  }
  // un `Ref { … }` que se quedó sin relaciones se elimina entero
  for (let i = start; i <= end && i < lines.length; i++) {
    if (toDelete.has(i) || !/^\s*Ref\b[^:\n{]*\{\s*$/i.test(lines[i])) continue;
    let j = i + 1;
    let emptied = false;
    while (j <= end && j < lines.length && (toDelete.has(j) || !lines[j].trim())) {
      if (toDelete.has(j)) emptied = true;
      j++;
    }
    if (emptied && j < lines.length && /^\s*\}\s*$/.test(lines[j])) {
      for (let k = i; k <= j; k++) toDelete.add(k);
    }
  }
  for (const i of [...toDelete].sort((a, b) => b - a)) lines.splice(i, 1);
  return true;
}

// Renombra una columna de una tabla y actualiza referencias tabla.col. Muta lines.
export function renameColumnInBlock(
  lines: string[],
  start: number,
  end: number,
  table: string,
  oldCol: string,
  newCol: string
): boolean {
  if (!/^[A-Za-z0-9_]+$/.test(newCol)) return false;
  const range = findTableRange(lines, start, end, table);
  if (!range) return false;
  const [decl, close] = range;
  const ec = esc(oldCol);
  let found = false;
  for (let i = decl + 1; i < close; i++) {
    if (new RegExp(`^\\s*${ec}\\s+[A-Za-z0-9_(]`).test(lines[i])) {
      lines[i] = lines[i].replace(
        new RegExp(`^(\\s*)${ec}(?=\\s)`),
        `$1${newCol}`
      );
      found = true;
      break;
    }
  }
  if (!found) return false;
  const refRe = new RegExp(`\\b${esc(table)}\\.${ec}\\b`, "g");
  for (let i = start; i <= end && i < lines.length; i++) {
    if (/^\s*\/\/\s*@edge\b/.test(lines[i])) {
      lines[i] = rewriteEdgeLine(lines[i], (f, fc, t, tc) => [
        f,
        f === table && fc === oldCol ? newCol : fc,
        t,
        t === table && tc === oldCol ? newCol : tc,
      ]);
      continue;
    }
    lines[i] = replaceOutsideStrings(lines[i], refRe, `${table}.${newCol}`);
  }
  return true;
}

// Cambia el tipo de una columna. Muta lines.
export function setColumnTypeInBlock(
  lines: string[],
  start: number,
  end: number,
  table: string,
  col: string,
  newType: string
): boolean {
  if (!/^[A-Za-z0-9_(),. ]+$/.test(newType)) return false;
  const range = findTableRange(lines, start, end, table);
  if (!range) return false;
  const [decl, close] = range;
  const ecol = esc(col);
  for (let i = decl + 1; i < close; i++) {
    const m = lines[i].match(
      new RegExp(`^(\\s*${ecol}\\s+)([^[\\n]+?)\\s*(\\[.*\\])?\\s*$`)
    );
    if (m) {
      const settings = m[3] ? ` ${m[3]}` : "";
      lines[i] = `${m[1]}${newType.trim()}${settings}`;
      return true;
    }
  }
  return false;
}

// Cambia el operador de cardinalidad de una relación (<, >, -, <>). Reescribe
// la forma independiente (`Ref: a.c > b.c`) y la inline dentro de la columna de
// origen (`c tipo [ref: > b.c]`); si la misma relación está declarada de las dos
// formas, cambia ambas para no dejar dos aristas con operadores distintos.
// Muta lines. Devuelve false si no la halla.
export function setRefOpInBlock(
  lines: string[],
  start: number,
  end: number,
  ref: { from: string; fromCol: string; to: string; toCol: string },
  newOp: string
): boolean {
  if (!/^(<>|>|<|-)$/.test(newOp)) return false;
  const ef = esc(ref.from),
    efc = esc(ref.fromCol),
    et = esc(ref.to),
    etc = esc(ref.toCol);
  let changed = false;
  // 1) forma independiente: a.c OP b.c (con o sin "Ref:" / "Ref nombre:")
  const standalone = new RegExp(
    `^(\\s*(?:[Rr][Ee][Ff]\\b[^:\\n]*:\\s*)?"?${ef}"?\\.${efc}\\s*)(<>|>|<|-)(\\s*"?${et}"?\\.${etc})`
  );
  for (let i = start; i <= end && i < lines.length; i++) {
    if (/^\s*\/\/\s*@/.test(lines[i])) continue;
    if (standalone.test(lines[i])) {
      lines[i] = lines[i].replace(standalone, `$1${newOp}$3`);
      changed = true;
    }
  }
  // 2) inline en la columna de origen dentro de la tabla `from`
  const range = findTableRange(lines, start, end, ref.from);
  if (range) {
    const [decl, close] = range;
    const colRe = new RegExp(`^\\s*${efc}\\s`);
    const inlineRe = new RegExp(
      `(ref:\\s*)(<>|>|<|-)(\\s*"?${et}"?\\.${etc})`,
      "i"
    );
    for (let i = decl + 1; i < close; i++) {
      if (colRe.test(lines[i]) && inlineRe.test(lines[i])) {
        lines[i] = lines[i].replace(inlineRe, `$1${newOp}$3`);
        changed = true;
      }
    }
  }
  return changed;
}

// ---- posiciones / vista persistidas como comentarios ----

export function parsePositions(
  src: string
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  const re =
    /\/\/\s*@pos\s+"?([A-Za-z0-9_]+)"?\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out[m[1]] = { x: parseFloat(m[2]), y: parseFloat(m[3]) };
  }
  return out;
}

export function parseView(
  src: string
): { x: number; y: number; k: number } | null {
  const m = src.match(
    /\/\/\s*@view\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/
  );
  return m
    ? { x: parseFloat(m[1]), y: parseFloat(m[2]), k: parseFloat(m[3]) }
    : null;
}

export function parseSize(src: string): { w: number; h: number } | null {
  const m = src.match(/\/\/\s*@size\s+(\d+)\s+(\d+)/);
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
}

// Rutas de aristas editadas a mano: // @edge FROM FCOL TO TCOL x1 y1 x2 y2 …
// (solo los waypoints intermedios; los extremos se reanclan a los puertos).
// Clave de salida: `FROM.FCOL->TO.TCOL`.
export function parseEdges(
  src: string
): Record<string, { x: number; y: number }[]> {
  const out: Record<string, { x: number; y: number }[]> = {};
  const re =
    /\/\/\s*@edge\s+"?([A-Za-z0-9_]+)"?\s+"?([A-Za-z0-9_]+)"?\s+"?([A-Za-z0-9_]+)"?\s+"?([A-Za-z0-9_]+)"?((?:\s+-?\d+(?:\.\d+)?){2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const nums = m[5].trim().split(/\s+/).map(Number);
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2)
      pts.push({ x: nums[i], y: nums[i + 1] });
    if (pts.length) out[`${m[1]}.${m[2]}->${m[3]}.${m[4]}`] = pts;
  }
  return out;
}

// Reescribe los identificadores de una línea // @edge (from/fcol/to/tcol),
// dejando intactos los waypoints. Devuelve la línea sin cambios si no es @edge.
function rewriteEdgeLine(
  line: string,
  fn: (from: string, fcol: string, to: string, tcol: string) => [string, string, string, string]
): string {
  const m = line.match(
    /^(\s*\/\/\s*@edge\s+)"?([A-Za-z0-9_]+)"?(\s+)"?([A-Za-z0-9_]+)"?(\s+)"?([A-Za-z0-9_]+)"?(\s+)"?([A-Za-z0-9_]+)"?(\s.*)?$/
  );
  if (!m) return line;
  const [f, fc, t, tc] = fn(m[2], m[4], m[6], m[8]);
  return `${m[1]}${f}${m[3]}${fc}${m[5]}${t}${m[7]}${tc}${m[9] ?? ""}`;
}
