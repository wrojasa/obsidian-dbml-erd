// Layout con elkjs: posiciona tablas (layered) y rutea aristas ortogonalmente
// conectándolas a puertos ubicados en la fila de cada columna.
import type {
  ELK as ElkInstance,
  ElkNode,
  ElkPort,
  ElkExtendedEdge,
} from "elkjs/lib/elk-api";
import type { Model, Group } from "./parser";
import { AREA_PAD, AREA_PAD_TOP, GROUP_NODE_PREFIX } from "./areas";

export const ROW_H = 28;
export const HEAD_H = 36;
export const NODE_W = 216; // ancho mínimo de tabla

// métricas usadas para calcular cuánto debe ensancharse una tabla cuando
// un nombre de columna/tipo no entra en NODE_W (evita que se solapen).
const PAD_L = 14;
const PAD_R = 14;
const NAME_TYPE_GAP = 16;
const ICON_W = 18; // 🔑/🔗
const BADGE_W = 22;
const BADGE_GAP = 8;
const HEAD_FONT = "700 13px sans-serif";
const COL_FONT = "12.5px sans-serif";
const COL_FONT_BOLD = "700 12.5px sans-serif";
const TYPE_FONT = "11.5px sans-serif";

// Un canvas de medición por documento: con `activeDocument` el plugin respeta
// las ventanas emergentes de Obsidian, y la WeakMap evita reutilizar el canvas
// de una ventana que ya se cerró.
const measureCtxs = new WeakMap<Document, CanvasRenderingContext2D | null>();
function getMeasureCtx(): CanvasRenderingContext2D | null {
  try {
    const doc = activeDocument;
    if (!measureCtxs.has(doc)) {
      measureCtxs.set(doc, doc.createElement("canvas").getContext("2d"));
    }
    return measureCtxs.get(doc) ?? null;
  } catch {
    return null; // sin DOM (p. ej. pruebas en node)
  }
}

function measureText(text: string, font: string): number {
  const ctx = getMeasureCtx();
  if (!ctx) return text.length * 7; // estimación si no hay canvas disponible
  ctx.font = font;
  return ctx.measureText(text).width;
}

// Ancho del nombre de una columna con la misma fuente que usa tableWidth. El
// render ubica el ícono 🔑/🔗 con este valor para que coincida con el espacio
// que la tabla le reservó.
export function colNameWidth(c: Model["tables"][number]["cols"][number]): number {
  return measureText(c.name, c.pk ? COL_FONT_BOLD : COL_FONT);
}

// Ancho del nombre de un área en su barra (misma fuente que .dbml-area-txt).
const AREA_FONT = "700 12.5px sans-serif";
export function areaNameWidth(name: string): number {
  return measureText(name, AREA_FONT);
}

// ancho de tabla: NODE_W, o más si el nombre de la tabla o alguna fila
// (nombre + icono + tipo + badge NN) lo necesita para no solaparse.
export function tableWidth(t: Model["tables"][number]): number {
  let w = measureText(t.name, HEAD_FONT) + PAD_L * 2;
  for (const c of t.cols) {
    let rowW = PAD_L + colNameWidth(c);
    if (c.pk || c.fk) rowW += ICON_W;
    rowW += NAME_TYPE_GAP + measureText(c.type, TYPE_FONT);
    if (c.nn) rowW += BADGE_GAP + BADGE_W;
    rowW += PAD_R;
    w = Math.max(w, rowW);
  }
  return Math.max(NODE_W, Math.ceil(w));
}

export interface Pt {
  x: number;
  y: number;
}
export interface NodePos {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface EdgePath {
  pts: Pt[]; // polilínea ruteada por ELK (coords absolutas)
}
export interface LayoutResult {
  nodes: Record<string, NodePos>;
  edges: EdgePath[]; // mismo orden que model.refs
  // recuadro inicial de cada área según ELK (coordenadas absolutas); el render
  // lo recalcula siempre a partir de las tablas, esto sirve para pruebas
  groups?: Record<string, NodePos>;
}

// ELK (~1.6 MB) se carga perezosamente en el primer layout: el import()
// dinámico difiere la evaluación del motor al primer render en vez del
// arranque de Obsidian. La promesa compartida dedupe renders concurrentes.
let elkPromise: Promise<ElkInstance> | undefined;
function getElk(): Promise<ElkInstance> {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then(
      (m) => new m.default()
    );
  }
  return elkPromise;
}

export function tableHeight(colCount: number): number {
  return HEAD_H + colCount * ROW_H;
}
function colRowY(model: Model, table: string, col: string): number {
  const t = model.tables.find((t) => t.name === table);
  if (!t) return HEAD_H / 2;
  const i = t.cols.findIndex((c) => c.name === col);
  const idx = i < 0 ? 0 : i;
  return HEAD_H + idx * ROW_H + ROW_H / 2;
}

export async function computeLayout(model: Model): Promise<LayoutResult> {
  const children: ElkNode[] = model.tables.map((t) => {
    const h = tableHeight(t.cols.length);
    const w = tableWidth(t);
    const ports: ElkPort[] = [];
    model.refs.forEach((r, i) => {
      if (r.from === t.name) {
        const y = colRowY(model, t.name, r.fromCol);
        ports.push(port(`s${i}_e`, w, y, "EAST"));
        ports.push(port(`s${i}_w`, 0, y, "WEST"));
      }
      if (r.to === t.name) {
        const y = colRowY(model, t.name, r.toCol);
        ports.push(port(`t${i}_e`, w, y, "EAST"));
        ports.push(port(`t${i}_w`, 0, y, "WEST"));
      }
    });
    return {
      id: t.name,
      width: w,
      height: h,
      ports,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    };
  });

  // source desde EAST, target hacia WEST (caso jerárquico común)
  const edges: ElkExtendedEdge[] = model.refs.map((r, i) => ({
    id: "e" + i,
    sources: [`s${i}_e`],
    targets: [`t${i}_w`],
  }));

  const rootOptions = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.spacing.nodeNodeBetweenLayers": "120",
    "elk.spacing.nodeNode": "50",
    "elk.spacing.edgeNode": "25",
  };

  // Con áreas, cada una es un contenedor de sus tablas. Sin áreas, el grafo es
  // exactamente el de siempre (mismos nodos, opciones y lectura del resultado).
  const groups = (model.groups ?? []).filter((g) => g.tables.length > 0);
  if (groups.length) return computeGroupedLayout(model, groups, children, edges, rootOptions);

  const graph: ElkNode = {
    id: "root",
    layoutOptions: rootOptions,
    children,
    edges,
  };

  const res = await (await getElk()).layout(graph);
  const nodes: Record<string, NodePos> = {};
  for (const n of res.children ?? []) {
    nodes[n.id] = {
      x: n.x ?? 0,
      y: n.y ?? 0,
      w: n.width ?? 0,
      h: n.height ?? 0,
    };
  }
  // Indexa por id de arista ('e'+i) en vez de confiar en el orden de salida
  // de ELK, que no está garantizado que coincida con el de entrada.
  const byId: Record<string, Pt[]> = {};
  for (const e of res.edges ?? []) {
    const ee = e as ElkExtendedEdge;
    const sec = ee.sections?.[0];
    byId[ee.id ?? ""] = sec
      ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]
      : [];
  }
  const edgePaths: EdgePath[] = model.refs.map((_, i) => ({
    pts: byId["e" + i] ?? [],
  }));
  return { nodes, edges: edgePaths };
}

// Layout con áreas: cada `TableGroup` es un nodo contenedor (`group:<nombre>`)
// con sus tablas como hijos, y la raíz usa INCLUDE_CHILDREN para que ELK
// ubique y rutee todo el grafo en una sola corrida. ELK devuelve los hijos
// relativos a su contenedor y cada arista relativa a `edge.container`; aquí
// todo se pasa a coordenadas absolutas, así el resto del plugin recibe el
// mismo formato que sin áreas.
async function computeGroupedLayout(
  model: Model,
  groups: Group[],
  tableNodes: ElkNode[],
  edges: ElkExtendedEdge[],
  rootOptions: Record<string, string>
): Promise<LayoutResult> {
  const byName = new Map(tableNodes.map((n) => [n.id, n]));
  const inGroup = new Set<string>();
  const groupNodes: ElkNode[] = groups.map((g) => {
    const kids: ElkNode[] = [];
    for (const t of g.tables) {
      const n = byName.get(t);
      if (!n || inGroup.has(t)) continue;
      inGroup.add(t);
      kids.push(n);
    }
    return {
      id: GROUP_NODE_PREFIX + g.name,
      layoutOptions: {
        ...rootOptions,
        "elk.padding": `[top=${AREA_PAD_TOP},left=${AREA_PAD},bottom=${AREA_PAD},right=${AREA_PAD}]`,
      },
      children: kids,
    };
  });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: { ...rootOptions, "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [...groupNodes, ...tableNodes.filter((n) => !inGroup.has(n.id))],
    edges,
  };

  const res = await (await getElk()).layout(graph);
  const abs = new Map<string, Pt>([["root", { x: 0, y: 0 }]]);
  const nodes: Record<string, NodePos> = {};
  const groupBoxes: Record<string, NodePos> = {};
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      abs.set(c.id, { x, y });
      const box = { x, y, w: c.width ?? 0, h: c.height ?? 0 };
      if (c.id.startsWith(GROUP_NODE_PREFIX)) {
        groupBoxes[c.id.slice(GROUP_NODE_PREFIX.length)] = box;
        walk(c, x, y);
      } else {
        nodes[c.id] = box;
      }
    }
  };
  walk(res, 0, 0);
  // las aristas pueden quedar en el arreglo `edges` de un contenedor
  const byId: Record<string, Pt[]> = {};
  const collect = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const sec = e.sections?.[0];
      const o = abs.get(e.container ?? n.id) ?? { x: 0, y: 0 };
      byId[e.id] = sec
        ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({
            x: p.x + o.x,
            y: p.y + o.y,
          }))
        : [];
    }
    for (const c of n.children ?? []) collect(c);
  };
  collect(res);
  return {
    nodes,
    edges: model.refs.map((_, i) => ({ pts: byId["e" + i] ?? [] })),
    groups: groupBoxes,
  };
}

function port(id: string, x: number, y: number, side: string): ElkPort {
  return {
    id,
    x,
    y,
    width: 1,
    height: 1,
    layoutOptions: { "elk.port.side": side },
  };
}
