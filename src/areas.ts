// Áreas de trabajo (TableGroup): medidas y lógica sin DOM, compartidas por el
// layout (ELK) y el render, y probables en node.
import type { Model, Ref } from "./parser";

// Margen interno de un área alrededor de sus tablas. Arriba deja espacio para
// la barra de encabezado; ELK usa los mismos valores como padding del
// contenedor, así el recuadro dibujado coincide con el que reservó el layout.
export const AREA_PAD_TOP = 44;
export const AREA_PAD = 16;
export const AREA_HEAD_H = 28;
// Prefijo de los nodos contenedor en ELK. `:` no es válido en nombres de
// tabla, así que nunca choca con una tabla.
export const GROUP_NODE_PREFIX = "group:";

// Recuadro compacto de un área colapsada: barra + una línea con el conteo.
export const COLLAPSED_H = AREA_HEAD_H + 24;
export const COLLAPSED_MIN_W = 160;
// x donde empieza el nombre (después del triángulo) y margen derecho
export const AREA_LABEL_X = 26;
const AREA_LABEL_PAD_R = 14;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Recuadro de un área expandida: el rectángulo que envuelve a sus miembros más
// el margen del área. null si no hay miembros.
export function areaBox(members: Rect[]): Rect | null {
  if (!members.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of members) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return {
    x: minX - AREA_PAD,
    y: minY - AREA_PAD_TOP,
    w: maxX - minX + AREA_PAD * 2,
    h: maxY - minY + AREA_PAD_TOP + AREA_PAD,
  };
}

// Recuadro de un área colapsada: en la esquina superior izquierda del área
// expandida, con el ancho que pida el nombre (mínimo COLLAPSED_MIN_W).
export function collapsedBox(area: Rect, nameWidth: number): Rect {
  return {
    x: area.x,
    y: area.y,
    w: Math.max(COLLAPSED_MIN_W, Math.ceil(AREA_LABEL_X + nameWidth + AREA_LABEL_PAD_R)),
    h: COLLAPSED_H,
  };
}

// Paleta para áreas nuevas (la misma que sugiere la skill sql-to-dbml).
export const AREA_PALETTE = ["#20479e", "#2e7d32", "#c62828", "#6a1b9a", "#ef6c00", "#00838f"];

// Primer color de la paleta que no usa ninguna área; si todos están en uso,
// el primero.
export function nextAreaColor(model: Model): string {
  const used = new Set((model.groups ?? []).map((g) => (g.color ?? "").toLowerCase()));
  return AREA_PALETTE.find((c) => !used.has(c)) ?? AREA_PALETTE[0];
}

// tabla -> nombre de su área
export function groupOfMap(model: Model): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of model.groups ?? [])
    for (const t of g.tables) if (!out.has(t)) out.set(t, g.name);
  return out;
}

// Marca de cardinalidad de un extremo. `optional` solo aplica a "one"
// (círculo en vez de barra); la pata de gallo no tiene variante opcional.
export interface Mark {
  kind: "many" | "one";
  optional: boolean;
}

// Marcas de los dos extremos de una relación, con el criterio del plugin: el
// operador decide muchos/uno, y el extremo "uno" es opcional (círculo) si la
// columna FK es nullable y no es PK. La FK es 'to' en `<` y 'from' en el resto.
export function refMarks(model: Model, r: Ref): { from: Mark; to: Mark } {
  const [ft, fc] = r.op === "<" ? [r.to, r.toCol] : [r.from, r.fromCol];
  const c = model.tables.find((t) => t.name === ft)?.cols.find((x) => x.name === fc);
  const opt = c ? !(c.nn || c.pk) : false;
  const fromMany = r.op === ">" || r.op === "<>";
  const toMany = r.op === "<" || r.op === "<>";
  return {
    from: { kind: fromMany ? "many" : "one", optional: fromMany ? false : opt },
    to: { kind: toMany ? "many" : "one", optional: toMany ? false : opt },
  };
}

export type EdgeEnd =
  | { kind: "table"; table: string; col: string }
  | { kind: "area"; area: string };

export interface VisibleEdge {
  refs: number[]; // índices en model.refs
  from: EdgeEnd;
  to: EdgeEnd;
  fromMark: Mark | null; // null: relaciones unificadas con marcas distintas
  toMark: Mark | null;
  // toca un área colapsada: se dibuja sin selección ni edición
  aggregated: boolean;
}

function endKey(e: EdgeEnd): string {
  return e.kind === "table" ? `t:${e.table}.${e.col}` : `a:${e.area}`;
}

function sameMark(a: Mark | null, b: Mark): boolean {
  return !!a && a.kind === b.kind && a.optional === b.optional;
}

// Aristas a dibujar según qué áreas están colapsadas:
// - una relación sin extremos en áreas colapsadas se dibuja tal cual (una por
//   relación, en el orden del modelo);
// - un extremo que es miembro de un área colapsada pasa al recuadro del área;
// - relaciones con ambos extremos en la misma área colapsada no se dibujan;
// - las que comparten extremos tras el cambio se unifican en una sola; entre
//   dos áreas colapsadas hay una sola línea por par, sin importar el sentido;
// - cada extremo conserva su marca solo si todas las unificadas coinciden.
export function visibleEdges(model: Model, collapsed: Set<string>): VisibleEdge[] {
  const groupOf = groupOfMap(model);
  const areaOf = (t: string): string | null => {
    const g = groupOf.get(t);
    return g && collapsed.has(g) ? g : null;
  };
  const plain: VisibleEdge[] = [];
  const merged = new Map<string, VisibleEdge>();
  model.refs.forEach((r, i) => {
    const fa = areaOf(r.from);
    const ta = areaOf(r.to);
    const marks = refMarks(model, r);
    if (!fa && !ta) {
      plain.push({
        refs: [i],
        from: { kind: "table", table: r.from, col: r.fromCol },
        to: { kind: "table", table: r.to, col: r.toCol },
        fromMark: marks.from,
        toMark: marks.to,
        aggregated: false,
      });
      return;
    }
    if (fa && fa === ta) return; // interna de un área colapsada
    let from: EdgeEnd = fa ? { kind: "area", area: fa } : { kind: "table", table: r.from, col: r.fromCol };
    let to: EdgeEnd = ta ? { kind: "area", area: ta } : { kind: "table", table: r.to, col: r.toCol };
    let fm = marks.from;
    let tm = marks.to;
    // entre dos áreas el par no tiene sentido: se ordena para unificar A-B y B-A
    if (fa && ta && endKey(from) > endKey(to)) {
      [from, to] = [to, from];
      [fm, tm] = [tm, fm];
    }
    const key = `${endKey(from)}|${endKey(to)}`;
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, { refs: [i], from, to, fromMark: fm, toMark: tm, aggregated: true });
      return;
    }
    cur.refs.push(i);
    if (!sameMark(cur.fromMark, fm)) cur.fromMark = null;
    if (!sameMark(cur.toMark, tm)) cur.toMark = null;
  });
  return [...plain, ...merged.values()];
}
