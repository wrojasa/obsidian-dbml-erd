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
export interface Model {
  tables: Table[];
  refs: Ref[];
}

export function parseDBML(input: string): Model {
  // quita comentarios de línea //
  const src = input.replace(/\/\/[^\n]*/g, "");
  const tables: Table[] = [];
  const refs: Ref[] = [];

  const relRe =
    /(?:Ref:\s*)?([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*(<>|>|<|-)\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g;
  const tableRe =
    /(?:Table\s+)?([A-Za-z0-9_"]+)\s*(?:as\s+\w+\s*)?(?:\[([^\]]*)\]\s*)?\{([\s\S]*?)\}/g;

  const bodies: [number, number][] = [];
  let m: RegExpExecArray | null;

  while ((m = tableRe.exec(src)) !== null) {
    const name = m[1].replace(/"/g, "");
    const settings = m[2] || "";
    const body = m[3];
    bodies.push([m.index, m.index + m[0].length]);
    const cols: Column[] = [];
    let tableNote: string | undefined;
    const hcMatch = settings.match(
      /header[_ ]?color:\s*([#A-Za-z0-9(),.\s%]+?)\s*(?:,|$)/i
    );
    const headerColor = hcMatch ? hcMatch[1].trim() : undefined;

    for (let line of body.split("\n")) {
      line = line.trim();
      if (!line || line === "{" || line === "}") continue;
      const tn = line.match(/^Note:\s*'([^']*)'/i);
      if (tn) {
        tableNote = tn[1];
        continue;
      }
      if (/^indexes/i.test(line)) continue;
      const cm = line.match(/^([A-Za-z0-9_]+)\s+([A-Za-z0-9_()]+)\s*(\[.*\])?/);
      if (!cm) continue;
      const rawAttrs = cm[3] || "";
      const attrs = rawAttrs.toLowerCase();
      const noteM = rawAttrs.match(/note:\s*'([^']*)'/i);
      const col: Column = {
        name: cm[1],
        type: cm[2],
        pk: /\bpk\b|primary key/.test(attrs),
        fk: false,
        nn: /not null/.test(attrs),
        note: noteM ? noteM[1] : undefined,
      };
      cols.push(col);
      const ir = rawAttrs.match(
        /ref:\s*(<>|>|<|-)\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/i
      );
      if (ir) {
        refs.push({
          from: name,
          fromCol: cm[1],
          op: ir[1] as Cardinality,
          to: ir[2],
          toCol: ir[3],
        });
        col.fk = true;
      }
    }
    tables.push({ name, note: tableNote, headerColor, cols });
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

  // marca FKs
  for (const r of refs) {
    const t = tables.find((t) => t.name === r.from);
    const c = t?.cols.find((c) => c.name === r.fromCol);
    if (c) c.fk = true;
  }

  return { tables, refs };
}

// Edita la línea de declaración de una tabla para fijar/quitar headercolor.
// Devuelve la línea nueva, o null si la línea no declara esa tabla.
export function setHeaderColorInLine(
  line: string,
  tableName: string,
  color: string | null
): string | null {
  const esc = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^(\\s*(?:Table\\s+)?"?${esc}"?\\s*(?:as\\s+\\w+\\s*)?)(\\[[^\\]]*\\])?(\\s*\\{.*)$`
  );
  const m = line.match(re);
  if (!m) return null;
  const head = m[1].replace(/\s+$/, "");
  const inner = (m[2] || "").replace(/^\[|\]$/g, "");
  const rest = " " + m[3].replace(/^\s*/, "");

  // separa settings por coma respetando comillas simples
  const parts = inner
    ? inner.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map((p) => p.trim()).filter(Boolean)
    : [];
  const filtered = parts.filter((p) => !/^header[_ ]?color\s*:/i.test(p));
  if (color) filtered.push(`headercolor: ${color}`);

  const bracket = filtered.length ? ` [${filtered.join(", ")}]` : "";
  return head + bracket + rest;
}
