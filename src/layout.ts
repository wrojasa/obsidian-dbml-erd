// Layout con elkjs: posiciona tablas (layered) y rutea aristas ortogonalmente
// conectándolas a puertos ubicados en la fila de cada columna.
import type {
  ELK as ElkInstance,
  ElkNode,
  ElkPort,
  ElkExtendedEdge,
} from "elkjs/lib/elk-api";
import type { Model } from "./parser";

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

let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }
  return measureCtx;
}

function measureText(text: string, font: string): number {
  const ctx = getMeasureCtx();
  if (!ctx) return text.length * 7; // estimación si no hay canvas disponible
  ctx.font = font;
  return ctx.measureText(text).width;
}

// ancho de tabla: NODE_W, o más si el nombre de la tabla o alguna fila
// (nombre + icono + tipo + badge NN) lo necesita para no solaparse.
export function tableWidth(t: Model["tables"][number]): number {
  let w = measureText(t.name, HEAD_FONT) + PAD_L * 2;
  for (const c of t.cols) {
    let rowW = PAD_L + measureText(c.name, c.pk ? COL_FONT_BOLD : COL_FONT);
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

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.spacing.nodeNode": "50",
      "elk.spacing.edgeNode": "25",
    },
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
