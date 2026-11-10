import {
  Plugin,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Menu,
  Modal,
  App,
  Notice,
  TFile,
  PluginSettingTab,
  Setting,
  FuzzySuggestModal,
  setIcon,
} from "obsidian";
import { t, setLang, Lang, LANGS } from "./i18n";
import {
  parseDBML,
  Model,
  Ref,
  setHeaderColorInLine,
  renameTableInBlock,
  deleteTableInBlock,
  renameColumnInBlock,
  setColumnTypeInBlock,
  setRefOpInBlock,
  parsePositions,
  parseView,
  parseSize,
  parseEdges,
  parseGroupState,
} from "./parser";
import {
  computeLayout,
  LayoutResult,
  NodePos,
  Pt,
  ROW_H,
  HEAD_H,
  NODE_W,
  colNameWidth,
  areaNameWidth,
} from "./layout";
import {
  NAME_RE,
  addGroupInBlock,
  addTableInBlock,
  moveTableToGroupInBlock,
  removeGroupInBlock,
  renameGroupInBlock,
  setGroupColorInBlock,
  setPositionsInBlock,
} from "./edits";
import {
  AREA_HEAD_H,
  AREA_LABEL_X,
  AREA_PAD,
  nextAreaColor,
  EdgeEnd,
  Mark,
  Rect,
  VisibleEdge,
  areaBox,
  collapsedBox,
  groupOfMap,
  refMarks,
  visibleEdges,
} from "./areas";

const NS = "http://www.w3.org/2000/svg";

interface DbmlErdSettings {
  lang: Lang;
}
const DEFAULT_SETTINGS: DbmlErdSettings = { lang: "en" };

export default class DbmlErdPlugin extends Plugin {
  settings: DbmlErdSettings = { ...DEFAULT_SETTINGS };
  // arista seleccionada por bloque (sourcePath#lineStart); sobrevive a los
  // re-render del code block para no perder los handles al guardar el layout.
  selByBlock = new Map<string, string | undefined>();
  // cache de layout ELK por estructura DBML (ignorando @pos/@view/@size/@edge):
  // así los re-render que dispara guardar el layout no recalculan ELK ni
  // muestran el placeholder async (esa pausa era el "parpadeo" visible).
  private layoutCache = new Map<string, LayoutResult>();
  // loadSettings corre sin await en onload (solo fija idioma de i18n);
  // renderBlock la espera para que hasta el placeholder salga en el idioma
  // correcto sin bloquear el arranque de Obsidian.
  private settingsReady?: Promise<void>;

  async onload() {
    const handler = (
      source: string,
      el: HTMLElement,
      ctx: MarkdownPostProcessorContext
    ) => this.renderBlock(source, el, ctx);
    this.registerMarkdownCodeBlockProcessor("dbml", handler);
    this.registerMarkdownCodeBlockProcessor("DBML", handler);
    this.addSettingTab(new DbmlErdSettingTab(this.app, this));
    // si data.json está corrupto, cae al idioma por defecto sin romper renders
    this.settingsReady = this.loadSettings().catch(() => {});
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    setLang(this.settings.lang);
  }

  async saveSettings() {
    setLang(this.settings.lang);
    await this.saveData(this.settings);
  }

  async renderBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ) {
    if (this.settingsReady) await this.settingsReady;
    let model: Model;
    try {
      model = parseDBML(source);
    } catch (e) {
      el.empty();
      el.createDiv({ cls: "dbml-erd-wrap" }).setText(
        t("parseError", {
          msg: e instanceof Error ? e.message : String(e),
        })
      );
      return;
    }
    if (model.tables.length === 0) {
      el.empty();
      el.createDiv({ cls: "dbml-erd-wrap" }).setText(t("noTables"));
      return;
    }
    try {
      // El layout ELK depende solo de la estructura DBML, no de las anotaciones
      // de disposición; al ignorarlas en la clave, un re-render por guardado
      // reusa el layout cacheado y se renderiza sin pausa async (sin parpadeo).
      const layoutKey = source
        .replace(/^[ \t]*\/\/[ \t]*@(pos|view|size|edge|group)\b.*$/gm, "")
        .trim();
      let layout = this.layoutCache.get(layoutKey);
      if (!layout) {
        // primer cálculo: muestra placeholder mientras ELK trabaja (async)
        el.empty();
        el.createDiv({ cls: "dbml-erd-wrap" }).setText(t("rendering"));
        layout = await computeLayout(model);
        this.layoutCache.set(layoutKey, layout);
      }
      el.empty();
      const wrap = el.createDiv({ cls: "dbml-erd-wrap" });
      const hMatch = source.match(/\/\/\s*(?:canvas-)?height:\s*(\d+)/i);
      const height = hMatch ? parseInt(hMatch[1], 10) : undefined;
      const savedPos = parsePositions(source);
      const view = parseView(source);
      const size = parseSize(source);
      const savedEdges = parseEdges(source);
      const collapsed = parseGroupState(source);
      // clona los nodos del layout cacheado: el Diagram (savedPos y el arrastre)
      // muta las posiciones, y la cache debe quedar prístina para otros render.
      const freshNodes: LayoutResult["nodes"] = {};
      for (const [k, v] of Object.entries(layout.nodes))
        freshNodes[k] = { ...v };
      const layoutForInstance: LayoutResult = {
        nodes: freshNodes,
        edges: layout.edges,
      };
      ctx.addChild(
        new Diagram(wrap, model, layoutForInstance, {
          height,
          plugin: this,
          ctx,
          el,
          savedPos,
          view: view ?? undefined,
          size: size ?? undefined,
          savedEdges,
          collapsed,
        })
      );
    } catch (e) {
      el.empty();
      el.createDiv({ cls: "dbml-erd-wrap" }).setText(
        t("layoutError", {
          msg: e instanceof Error ? e.message : String(e),
        })
      );
    }
  }
}

class Diagram extends MarkdownRenderChild {
  private model: Model;
  private pos: Record<string, NodePos>;
  private elkEdges: Pt[][]; // ruta ELK original por ref
  private selKey?: string; // clave de persistencia de selección (sourcePath#linea)
  private customEdges: Record<string, Pt[]> = {}; // waypoints intermedios por ref
  // frame de anclas (extremos + lados) con el que se autorizaron los waypoints
  // de cada ref; sirve para estirarlos afín-mente al mover tablas (base->actual).
  private customEdgeBase: Record<
    string,
    { ax: number; ay: number; bx: number; by: number; aR: boolean; bR: boolean }
  > = {};
  private _selectedEdge?: string; // ref con handles visibles
  private get selectedEdge(): string | undefined {
    return this._selectedEdge;
  }
  private set selectedEdge(v: string | undefined) {
    this._selectedEdge = v;
    if (this.selKey && this.plugin) this.plugin.selByBlock.set(this.selKey, v);
  }
  private view = { x: 30, y: 30, k: 1 };
  private movedTables = new Set<string>();
  private saveTimer = 0;
  private hostEl?: HTMLElement;
  private lastSize = "";
  private colorInput?: HTMLInputElement;
  private plugin?: DbmlErdPlugin;
  private ctx?: MarkdownPostProcessorContext;
  private blockEl?: HTMLElement;
  private svg: SVGSVGElement;
  private vp: SVGGElement;
  private areaLayer: SVGGElement;
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;
  private handleLayer: SVGGElement;
  // áreas de trabajo: tabla -> área, áreas colapsadas y nodo SVG por tabla
  // (para mover las tablas de un área sin redibujarlas)
  private groupOf = new Map<string, string>();
  private collapsed = new Set<string>();
  private nodeEls = new Map<string, SVGGElement>();
  // aristas visibles según las áreas colapsadas; se recalcula al colapsar
  private visCache?: VisibleEdge[];
  private static readonly AREA_DEFAULT_COLOR = "#64748b";

  constructor(
    parent: HTMLElement,
    model: Model,
    layout: LayoutResult,
    opts?: {
      height?: number;
      plugin?: DbmlErdPlugin;
      ctx?: MarkdownPostProcessorContext;
      el?: HTMLElement;
      savedPos?: Record<string, { x: number; y: number }>;
      view?: { x: number; y: number; k: number };
      size?: { w: number; h: number };
      savedEdges?: Record<string, { x: number; y: number }[]>;
      collapsed?: Set<string>;
    }
  ) {
    super(parent);
    this.model = model;
    this.pos = layout.nodes;
    this.elkEdges = layout.edges.map((e) => e.pts);
    this.plugin = opts?.plugin;
    this.ctx = opts?.ctx;
    this.blockEl = opts?.el;
    this.groupOf = groupOfMap(model);
    // solo cuentan las líneas @group de áreas que existen en el modelo
    const groupNames = new Set(model.groups.map((g) => g.name));
    for (const n of opts?.collapsed ?? [])
      if (groupNames.has(n)) this.collapsed.add(n);

    // aplica posiciones guardadas (override del layout ELK)
    if (opts?.savedPos) {
      for (const [name, p] of Object.entries(opts.savedPos)) {
        if (this.pos[name]) {
          this.pos[name].x = p.x;
          this.pos[name].y = p.y;
          this.movedTables.add(name);
        }
      }
    }
    // rutas de aristas editadas a mano: solo se conservan las que aún
    // corresponden a una relación existente (descarta @edge huérfanos).
    if (opts?.savedEdges) {
      const valid = new Set(this.model.refs.map((r) => this.edgeKey(r)));
      for (const [k, pts] of Object.entries(opts.savedEdges)) {
        if (valid.has(k) && pts.length)
          this.customEdges[k] = pts.map((p) => ({ ...p }));
      }
    }
    if (opts?.view) this.view = { ...opts.view };

    // restaura la selección de arista de un render previo del mismo bloque
    // (los handles deben reaparecer aunque Obsidian re-renderice al guardar).
    if (this.ctx && this.blockEl) {
      const info = this.ctx.getSectionInfo(this.blockEl);
      this.selKey = `${this.ctx.sourcePath}#${info ? info.lineStart : 0}`;
      const prev = this.plugin?.selByBlock.get(this.selKey);
      // una relación hacia un área colapsada no se puede seleccionar
      if (
        prev &&
        this.model.refs.some(
          (r) =>
            this.edgeKey(r) === prev &&
            !this.isHidden(r.from) &&
            !this.isHidden(r.to)
        )
      )
        this._selectedEdge = prev;
    }

    const host = parent.createDiv({ cls: "dbml-erd-canvas" });
    this.hostEl = host;
    if (opts?.height)
      host.style.setProperty("--dbml-erd-height", opts.height + "px");
    // tamaño guardado (override del default CSS / --dbml-erd-height)
    if (opts?.size) {
      host.style.width = opts.size.w + "px";
      host.style.height = opts.size.h + "px";
      this.lastSize = `${opts.size.w} ${opts.size.h}`;
    }
    this.svg = activeDocument.createElementNS(NS, "svg");
    this.svg.classList.add("dbml-erd-svg");
    this.vp = activeDocument.createElementNS(NS, "g");
    this.areaLayer = activeDocument.createElementNS(NS, "g");
    this.edgeLayer = activeDocument.createElementNS(NS, "g");
    this.nodeLayer = activeDocument.createElementNS(NS, "g");
    this.handleLayer = activeDocument.createElementNS(NS, "g");
    this.vp.appendChild(this.areaLayer); // áreas al fondo, bajo las líneas
    this.vp.appendChild(this.edgeLayer);
    this.vp.appendChild(this.nodeLayer);
    this.vp.appendChild(this.handleLayer); // handles por encima de todo
    this.svg.appendChild(this.vp);
    host.appendChild(this.svg);

    // toolbar
    const bar = host.createDiv({ cls: "dbml-erd-toolbar" });
    this.btn(bar, "+", () => this.zoom(1.15));
    this.btn(bar, "−", () => this.zoom(0.87));
    this.btn(bar, "⊡", () => this.fit(true));
    // nueva tabla (ícono, para no confundirse con el + del zoom)
    const nb = bar.createEl("button");
    setIcon(nb, "table");
    nb.setAttribute("aria-label", t("newTable"));
    this.registerDomEvent(nb, "click", () => this.promptNewTable());

    this.redrawAreas();
    this.drawNodes();
    this.redrawEdges();
    this.redrawHandles(); // muestra handles si se restauró una selección
    this.bindPanZoom(host);
    this.bindResize(host);
    this.applyView();
    // si no hay vista guardada, encuadrar tras montar (necesita medidas del host)
    if (!opts?.view) activeWindow.requestAnimationFrame(() => this.fit());
  }

  onunload() {
    if (this.saveTimer) activeWindow.clearTimeout(this.saveTimer);
    this.colorInput?.remove();
    this.colorInput = undefined;
  }

  private btn(bar: HTMLElement, label: string, cb: () => void) {
    const b = bar.createEl("button", { text: label });
    this.registerDomEvent(b, "click", cb);
  }

  // ---- geometría ----
  private colRowY(table: string, col: string): number {
    const t = this.model.tables.find((t) => t.name === table);
    if (!t) return HEAD_H / 2;
    const i = t.cols.findIndex((c) => c.name === col);
    const idx = i < 0 ? 0 : i;
    return HEAD_H + idx * ROW_H + ROW_H / 2;
  }

  private edgeKey(r: Ref): string {
    return `${r.from}.${r.fromCol}->${r.to}.${r.toCol}`;
  }

  // ---- áreas de trabajo ----
  // ¿la tabla está dentro de un área colapsada (no se dibuja)?
  private isHidden(table: string): boolean {
    const g = this.groupOf.get(table);
    return !!g && this.collapsed.has(g);
  }

  private memberRects(name: string, except?: string): Rect[] {
    const g = this.model.groups.find((x) => x.name === name);
    if (!g) return [];
    const out: Rect[] = [];
    for (const t of g.tables) {
      if (t === except) continue;
      const p = this.pos[t];
      if (!p) continue;
      const cols = this.model.tables.find((x) => x.name === t)?.cols.length ?? 0;
      out.push({ x: p.x, y: p.y, w: p.w || NODE_W, h: p.h || HEAD_H + cols * ROW_H });
    }
    return out;
  }

  // recuadro expandido del área (siempre derivado de sus tablas)
  private areaBoxOf(name: string): Rect | null {
    return areaBox(this.memberRects(name));
  }

  // recuadro compacto del área colapsada
  private collapsedBoxOf(name: string): Rect | null {
    const box = this.areaBoxOf(name);
    return box ? collapsedBox(box, areaNameWidth(name)) : null;
  }

  private visibleEdgeList(): VisibleEdge[] {
    if (!this.visCache) this.visCache = visibleEdges(this.model, this.collapsed);
    return this.visCache;
  }

  // rectángulos visibles que una línea debe esquivar: tablas (salvo las
  // ocultas y las indicadas) y recuadros de áreas colapsadas (salvo las indicadas)
  private tableRects(
    ignore: string[],
    ignoreAreas: string[] = []
  ): { x: number; y: number; w: number; h: number }[] {
    const ig = new Set(ignore);
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const t of this.model.tables) {
      if (ig.has(t.name) || this.isHidden(t.name)) continue;
      const p = this.pos[t.name];
      if (!p) continue;
      out.push({
        x: p.x,
        y: p.y,
        w: p.w || NODE_W,
        h: p.h || HEAD_H + t.cols.length * ROW_H,
      });
    }
    const igA = new Set(ignoreAreas);
    for (const name of this.collapsed) {
      if (igA.has(name)) continue;
      const b = this.collapsedBoxOf(name);
      if (b) out.push(b);
    }
    return out;
  }

  // ¿el segmento (axis-aligned) cruza algún rectángulo (con padding)?
  private segHitsRects(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    rects: { x: number; y: number; w: number; h: number }[],
    pad = 12
  ): boolean {
    const lox = Math.min(x1, x2),
      hix = Math.max(x1, x2),
      loy = Math.min(y1, y2),
      hiy = Math.max(y1, y2);
    for (const r of rects) {
      if (
        hix < r.x - pad ||
        lox > r.x + r.w + pad ||
        hiy < r.y - pad ||
        loy > r.y + r.h + pad
      )
        continue;
      return true;
    }
    return false;
  }

  // ruteo manhattan (para drag): Z entre puertos de columna, eligiendo un canal
  // vertical que no atraviese otras tablas.
  private manhattan(r: Ref): { pts: Pt[]; aSide: string; bSide: string } | null {
    const A = this.pos[r.from];
    const B = this.pos[r.to];
    if (!A || !B) return null;
    return this.routeEnds(
      { x: A.x, w: A.w || NODE_W, y: A.y + this.colRowY(r.from, r.fromCol) },
      { x: B.x, w: B.w || NODE_W, y: B.y + this.colRowY(r.to, r.toCol) },
      [r.from, r.to],
      []
    );
  }

  // geometría de un extremo para el ruteo: x y ancho del rectángulo de origen
  // y la altura del puerto (fila de la columna, o centro del área colapsada)
  private endGeom(e: EdgeEnd): { x: number; w: number; y: number } | null {
    if (e.kind === "table") {
      const P = this.pos[e.table];
      if (!P) return null;
      return { x: P.x, w: P.w || NODE_W, y: P.y + this.colRowY(e.table, e.col) };
    }
    const b = this.collapsedBoxOf(e.area);
    return b ? { x: b.x, w: b.w, y: b.y + b.h / 2 } : null;
  }

  // Z ortogonal entre dos extremos (tabla o área colapsada), con canal
  // vertical libre de obstáculos. Es el ruteo de manhattan(), generalizado.
  private routeEnds(
    a: { x: number; w: number; y: number },
    b: { x: number; w: number; y: number },
    ignoreTables: string[],
    ignoreAreas: string[]
  ): { pts: Pt[]; aSide: string; bSide: string } {
    const A = a;
    const B = b;
    const ay = a.y;
    const by = b.y;
    const aw = a.w;
    const bw = b.w;
    const aCx = A.x + aw / 2;
    const bCx = B.x + bw / 2;
    // Si las tablas se solapan en X (apiladas), ambas salen por el mismo lado
    // y la línea rodea por fuera; si no, cada una mira hacia la otra. Hay
    // solape cuando la distancia entre centros es menor que el promedio de los
    // anchos; con el ancho mayor, una tabla ancha junto a una angosta se tomaba
    // como apilada y la línea daba la vuelta.
    const overlapX = Math.abs(bCx - aCx) < (aw + bw) / 2;
    const aRight = overlapX ? true : bCx >= aCx;
    const bRight = overlapX ? true : !aRight;
    const ax = aRight ? A.x + aw : A.x;
    const bx = bRight ? B.x + bw : B.x;
    const stub = 18;
    const ax2 = ax + (aRight ? stub : -stub);
    const bx2 = bx + (bRight ? stub : -stub);
    // canal vertical base (como antes); luego se busca uno libre de colisiones.
    const baseMid = overlapX ? Math.max(ax2, bx2) : (ax2 + bx2) / 2;
    const rects = this.tableRects(ignoreTables, ignoreAreas);
    // candidatos: base, stubs y bordes ±margen de cada tabla visible y de cada
    // área colapsada. Se prueba el más cercano a baseMid que no cruce ningún
    // obstáculo en los 3 tramos.
    const margin = 22;
    const cands = [baseMid, ax2, bx2];
    for (const t of this.model.tables) {
      if (this.isHidden(t.name)) continue;
      const p = this.pos[t.name];
      if (!p) continue;
      cands.push(p.x - margin, p.x + (p.w || NODE_W) + margin);
    }
    for (const name of this.collapsed) {
      const cb = this.collapsedBoxOf(name);
      if (cb) cands.push(cb.x - margin, cb.x + cb.w + margin);
    }
    cands.sort((u, v) => Math.abs(u - baseMid) - Math.abs(v - baseMid));
    let midX = baseMid;
    for (const c of cands) {
      if (
        !this.segHitsRects(ax2, ay, c, ay, rects) &&
        !this.segHitsRects(c, ay, c, by, rects) &&
        !this.segHitsRects(c, by, bx2, by, rects)
      ) {
        midX = c;
        break;
      }
    }
    return {
      pts: [
        { x: ax, y: ay },
        { x: ax2, y: ay },
        { x: midX, y: ay },
        { x: midX, y: by },
        { x: bx2, y: by },
        { x: bx, y: by },
      ],
      aSide: aRight ? "E" : "W",
      bSide: bRight ? "E" : "W",
    };
  }

  private roundedPath(pts: Pt[], rad = 8): string {
    if (pts.length === 0) return "";
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1],
        c = pts[i],
        n = pts[i + 1];
      const v1 = [Math.sign(c.x - p.x), Math.sign(c.y - p.y)];
      const v2 = [Math.sign(n.x - c.x), Math.sign(n.y - c.y)];
      if (v1[0] === v2[0] && v1[1] === v2[1]) {
        d += ` L ${c.x} ${c.y}`;
        continue;
      }
      const r = Math.min(
        rad,
        Math.hypot(c.x - p.x, c.y - p.y) / 2,
        Math.hypot(n.x - c.x, n.y - c.y) / 2
      );
      d += ` L ${c.x - v1[0] * r} ${c.y - v1[1] * r} Q ${c.x} ${c.y} ${
        c.x + v2[0] * r
      } ${c.y + v2[1] * r}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L ${last.x} ${last.y}`;
  }

  private endpointSide(pts: Pt[], which: "start" | "end"): string {
    // lado por dirección del primer/último segmento
    if (which === "start") {
      return pts[1].x >= pts[0].x ? "E" : "W";
    }
    const n = pts.length;
    return pts[n - 2].x <= pts[n - 1].x ? "W" : "E";
  }

  private marker(
    x: number,
    y: number,
    side: string,
    kind: "many" | "one",
    optional = false
  ) {
    const g = activeDocument.createElementNS(NS, "g");
    const dir = side === "E" ? 1 : -1;
    if (kind === "many") {
      // pata de gallo (crow's foot): el esquema no conoce el mínimo, sin marca extra
      g.appendChild(this.line(x + dir * 11, y - 6, x, y));
      g.appendChild(this.line(x + dir * 11, y, x, y));
      g.appendChild(this.line(x + dir * 11, y + 6, x, y));
    } else if (optional) {
      // "cero o uno": círculo (FK nullable)
      g.appendChild(this.circle(x + dir * 9, y, 4));
    } else {
      // "exactamente uno": barra (FK not null)
      g.appendChild(this.line(x + dir * 8, y - 6, x + dir * 8, y + 6));
    }
    return g;
  }
  private line(x1: number, y1: number, x2: number, y2: number) {
    const l = activeDocument.createElementNS(NS, "line");
    l.setAttribute("x1", "" + x1);
    l.setAttribute("y1", "" + y1);
    l.setAttribute("x2", "" + x2);
    l.setAttribute("y2", "" + y2);
    l.classList.add("dbml-marker");
    return l;
  }
  private circle(cx: number, cy: number, r: number) {
    const c = activeDocument.createElementNS(NS, "circle");
    c.setAttribute("cx", "" + cx);
    c.setAttribute("cy", "" + cy);
    c.setAttribute("r", "" + r);
    c.classList.add("dbml-marker");
    c.classList.add("dbml-marker-circle");
    return c;
  }

  // ---- dibujo de aristas ----
  // redibuja aristas: si cualquiera de sus extremos fue movido, usa manhattan
  // (posición actual); si no, conserva la ruta ELK original (esquiva).
  // Sin áreas colapsadas, la lista visible es una arista por relación en el
  // orden del modelo, igual que antes. Las aristas hacia áreas colapsadas
  // (agregadas) se rutean al recuadro del área y no se pueden seleccionar.
  private redrawEdges() {
    while (this.edgeLayer.firstChild)
      this.edgeLayer.removeChild(this.edgeLayer.firstChild);
    for (const ve of this.visibleEdgeList()) {
      if (!ve.aggregated) {
        const i = ve.refs[0];
        const r = this.model.refs[i];
        const pts = this.edgePts(r, i);
        if (pts && pts.length >= 2) this.drawEdge(r, pts, this.edgeKey(r));
        continue;
      }
      const a = this.endGeom(ve.from);
      const b = this.endGeom(ve.to);
      if (!a || !b) continue;
      const ignT: string[] = [];
      const ignA: string[] = [];
      for (const e of [ve.from, ve.to]) {
        if (e.kind === "table") ignT.push(e.table);
        else ignA.push(e.area);
      }
      const route = this.routeEnds(a, b, ignT, ignA);
      this.drawPlainEdge(route.pts, ve.fromMark, ve.toMark);
    }
  }

  // arista agregada hacia un área colapsada: sin selección ni handles; cada
  // extremo lleva marca solo si las relaciones unificadas coinciden
  private drawPlainEdge(pts: Pt[], fromMark: Mark | null, toMark: Mark | null) {
    const path = activeDocument.createElementNS(NS, "path");
    path.setAttribute("d", this.roundedPath(this.orthogonalize(pts)));
    path.classList.add("dbml-edge", "aggregated");
    this.edgeLayer.appendChild(path);
    const s = pts[0];
    const e = pts[pts.length - 1];
    if (fromMark)
      this.edgeLayer.appendChild(
        this.marker(s.x, s.y, this.endpointSide(pts, "start"), fromMark.kind, fromMark.optional)
      );
    if (toMark)
      this.edgeLayer.appendChild(
        this.marker(e.x, e.y, this.endpointSide(pts, "end"), toMark.kind, toMark.optional)
      );
  }

  // ruta actual de una arista, por prioridad:
  // 1) waypoints manuales (reanclando extremos a los puertos actuales)
  // 2) manhattan (si algún extremo fue movido)
  // 3) ruta ELK original
  private edgePts(r: Ref, i: number): Pt[] | null {
    const custom = this.customEdges[this.edgeKey(r)];
    if (custom && custom.length) return this.routeWithWaypoints(r, custom);
    if (this.movedTables.has(r.from) || this.movedTables.has(r.to)) {
      const m = this.manhattan(r);
      return m ? m.pts : null;
    }
    const pts = this.elkEdges[i];
    return pts && pts.length >= 2 ? pts : null;
  }

  // anclas actuales de los extremos contra los puertos de columna. Si se pasa un
  // frame base, conserva sus lados (estable al mover); si no, los deduce de la
  // posición de los waypoints respecto al centro de cada tabla.
  private currentAnchors(
    r: Ref,
    mid: Pt[],
    base?: { aR: boolean; bR: boolean }
  ): { ax: number; ay: number; bx: number; by: number; aR: boolean; bR: boolean } | null {
    const A = this.pos[r.from];
    const B = this.pos[r.to];
    if (!A || !B) return null;
    const ay = A.y + this.colRowY(r.from, r.fromCol);
    const by = B.y + this.colRowY(r.to, r.toCol);
    const aw = A.w || NODE_W;
    const bw = B.w || NODE_W;
    let aR: boolean, bR: boolean;
    if (base) {
      aR = base.aR;
      bR = base.bR;
    } else if (mid.length) {
      aR = mid[0].x >= A.x + aw / 2;
      bR = mid[mid.length - 1].x >= B.x + bw / 2;
    } else {
      aR = B.x + bw / 2 >= A.x + aw / 2;
      bR = !aR;
    }
    const ax = aR ? A.x + aw : A.x;
    const bx = bR ? B.x + bw : B.x;
    return { ax, ay, bx, by, aR, bR };
  }

  // mapea un valor de un eje desde el span base [ba,bb] al actual [ca,cb]
  // (afín). Si el span base es ~0 (extremos alineados) preserva el offset.
  private lerpAxis(v: number, ba: number, bb: number, ca: number, cb: number) {
    const span = bb - ba;
    if (Math.abs(span) < 1e-6) return ca + (v - ba);
    return ca + ((v - ba) / span) * (cb - ca);
  }

  // waypoints intermedios de una ref transformados del frame base al actual,
  // de modo que se estiren al mover cualquiera de las dos tablas.
  private mappedInterior(r: Ref, key: string): Pt[] {
    const mid = this.customEdges[key];
    if (!mid || !mid.length) return [];
    const base = this.customEdgeBase[key];
    const cur = this.currentAnchors(r, mid, base);
    if (!base || !cur) return mid.map((p) => ({ ...p }));
    return mid.map((p) => ({
      x: this.lerpAxis(p.x, base.ax, base.bx, cur.ax, cur.bx),
      y: this.lerpAxis(p.y, base.ay, base.by, cur.ay, cur.by),
    }));
  }

  // arma la polilínea: extremos reanclados a los puertos actuales + waypoints
  // intermedios estirados afín-mente (base->actual). Captura el frame base la
  // primera vez (p.ej. @edge cargado), cuando aún coincide con la posición real.
  private routeWithWaypoints(r: Ref, mid: Pt[]): Pt[] {
    const A = this.pos[r.from];
    const B = this.pos[r.to];
    if (!A || !B) return mid.slice();
    const key = this.edgeKey(r);
    if (!this.customEdgeBase[key]) {
      const cap = this.currentAnchors(r, mid);
      if (cap) this.customEdgeBase[key] = cap;
    }
    const cur = this.currentAnchors(r, mid, this.customEdgeBase[key]);
    if (!cur) return mid.slice();
    const inner = this.mappedInterior(r, key);
    return [
      { x: cur.ax, y: cur.ay },
      ...inner,
      { x: cur.bx, y: cur.by },
    ];
  }

  // Convierte una polilínea libre en una ortogonal (solo tramos H/V) insertando
  // un codo entre cada par de puntos que difieran en ambos ejes. Estrategia
  // "horizontal primero": el codo va en (b.x, a.y), de modo que cada punto
  // intermedio que el usuario arrastró queda como esquina real de 90° (se entra
  // en vertical y se sale en horizontal). Los extremos no se tocan. Se eliminan
  // puntos colineales/duplicados para no romper el redondeo de esquinas.
  private orthogonalize(pts: Pt[]): Pt[] {
    if (pts.length < 2) return pts.slice();
    const out: Pt[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dx > 1e-6 && dy > 1e-6) out.push({ x: b.x, y: a.y }); // codo
      out.push({ x: b.x, y: b.y });
    }
    // colapsa puntos repetidos o colineales consecutivos
    const clean: Pt[] = [];
    for (const p of out) {
      const n = clean.length;
      if (n && Math.abs(clean[n - 1].x - p.x) < 1e-6 && Math.abs(clean[n - 1].y - p.y) < 1e-6)
        continue; // duplicado
      if (n >= 2) {
        const a = clean[n - 2];
        const m = clean[n - 1];
        const col1 = Math.abs(a.x - m.x) < 1e-6 && Math.abs(m.x - p.x) < 1e-6;
        const col2 = Math.abs(a.y - m.y) < 1e-6 && Math.abs(m.y - p.y) < 1e-6;
        if (col1 || col2) clean[n - 1] = p; // colineal: reemplaza el del medio
        else clean.push(p);
      } else clean.push(p);
    }
    return clean;
  }

  private drawEdge(r: Ref, pts: Pt[], key: string) {
    // la línea se dibuja ortogonalizada (90°); los markers usan los puntos
    // lógicos para deducir el lado de salida/entrada de cada extremo.
    const d = this.roundedPath(this.orthogonalize(pts));
    const path = activeDocument.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.classList.add("dbml-edge");
    if (this.selectedEdge === key) path.classList.add("selected");
    if (this.customEdges[key]) path.classList.add("custom");
    this.edgeLayer.appendChild(path);
    // path "hit" invisible y ancho para tocar/arrastrar con el dedo
    const hit = activeDocument.createElementNS(NS, "path") as SVGElement;
    hit.setAttribute("d", d);
    hit.classList.add("dbml-edge-hit");
    this.edgeLayer.appendChild(hit);
    this.enableEdgeSelect(hit, r, key);
    const s = pts[0];
    const e = pts[pts.length - 1];
    // operador -> muchos/uno; el extremo "uno" es círculo si la FK es nullable
    // y no es PK (refMarks, compartido con las aristas hacia áreas)
    const mk = refMarks(this.model, r);
    this.edgeLayer.appendChild(
      this.marker(s.x, s.y, this.endpointSide(pts, "start"), mk.from.kind, mk.from.optional)
    );
    this.edgeLayer.appendChild(
      this.marker(e.x, e.y, this.endpointSide(pts, "end"), mk.to.kind, mk.to.optional)
    );
  }

  // ---- edición de aristas ----
  private refresh() {
    this.redrawEdges();
    this.redrawHandles();
  }

  // tap en la línea: 1er toque selecciona (muestra handles); 2º abre menú.
  private enableEdgeSelect(hit: SVGElement, r: Ref, key: string) {
    let sx = 0,
      sy = 0,
      moved = false;
    hit.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      sx = ev.clientX;
      sy = ev.clientY;
      moved = false;
      try {
        hit.setPointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      const mv = (e: PointerEvent) => {
        if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        moved = true;
      };
      const up = (e: PointerEvent) => {
        hit.removeEventListener("pointermove", mv);
        hit.removeEventListener("pointerup", up);
        hit.removeEventListener("pointercancel", up);
        try {
          hit.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        if (moved || e.type === "pointercancel") return;
        e.stopPropagation();
        if (this.selectedEdge === key) {
          const ev2 = e;
          setTimeout(() => this.openEdgeMenu(r, key, ev2), 0);
        } else {
          this.selectedEdge = key;
          this.refresh();
        }
      };
      hit.addEventListener("pointermove", mv);
      hit.addEventListener("pointerup", up);
      hit.addEventListener("pointercancel", up);
    });
  }

  private openEdgeMenu(r: Ref, key: string, evt: PointerEvent) {
    const menu = new Menu();
    if (this.customEdges[key]) {
      menu.addItem((i) =>
        i
          .setTitle(t("resetRoute"))
          .setIcon("rotate-ccw")
          .onClick(() => this.resetEdge(key))
      );
    }
    // tipo de relación (cardinalidad): cambia pata de gallo (muchos) / barra (uno)
    const ops: [string, string][] = [
      ["<", t("relOneToMany")],
      [">", t("relManyToOne")],
      ["-", t("relOneToOne")],
      ["<>", t("relManyToMany")],
    ];
    for (const [op, label] of ops) {
      menu.addItem((i) =>
        i
          .setTitle(label)
          .setChecked(r.op === op)
          .onClick(() => this.setRefOp(r, op))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(t("deselect"))
        .setIcon("x")
        .onClick(() => {
          this.selectedEdge = undefined;
          this.refresh();
        })
    );
    menu.showAtMouseEvent(evt);
  }

  private setRefOp(r: Ref, op: string) {
    if (r.op === op) return;
    this.editBlock(
      (l, s, e) => setRefOpInBlock(l, s, e, r, op),
      t("changeRelTypeFail")
    );
  }

  private resetEdge(key: string) {
    delete this.customEdges[key];
    delete this.customEdgeBase[key];
    this.refresh();
    this.scheduleSaveLayout();
  }

  // prepara los waypoints de una ref para editarlos a mano "en frame actual":
  // si no existían, los siembra de la ruta visible; si existían, colapsa la
  // transformación base->actual a coordenadas absolutas. En ambos casos deja el
  // frame base = actual (mapeo identidad), de modo que el arrastre y el imán
  // ortogonal trabajen en las mismas coordenadas que se ven en pantalla.
  private seedCustom(r: Ref, i: number, key: string): Pt[] {
    if (!this.customEdges[key]) {
      const full = this.edgePts(r, i) ?? [];
      this.customEdges[key] = full.slice(1, -1).map((p) => ({ ...p }));
    } else {
      this.customEdges[key] = this.mappedInterior(r, key);
    }
    const cap = this.currentAnchors(r, this.customEdges[key]);
    if (cap) this.customEdgeBase[key] = cap;
    return this.customEdges[key];
  }

  private redrawHandles() {
    while (this.handleLayer.firstChild)
      this.handleLayer.removeChild(this.handleLayer.firstChild);
    if (!this.selectedEdge) return;
    const i = this.model.refs.findIndex(
      (r) => this.edgeKey(r) === this.selectedEdge
    );
    if (i < 0) return;
    const r = this.model.refs[i];
    if (this.isHidden(r.from) || this.isHidden(r.to)) return;
    const key = this.selectedEdge;
    const pts = this.edgePts(r, i);
    if (!pts || pts.length < 2) return;
    const rad = 6 / this.view.k;
    // handle de inserción en el medio de cada segmento (hueco)
    for (let s = 0; s < pts.length - 1; s++) {
      const mx = (pts[s].x + pts[s + 1].x) / 2;
      const my = (pts[s].y + pts[s + 1].y) / 2;
      const add = this.circle(mx, my, rad * 0.7) as SVGElement;
      add.classList.remove("dbml-marker", "dbml-marker-circle");
      add.classList.add("dbml-edge-handle", "add");
      this.handleLayer.appendChild(add);
      this.enableHandleDrag(add, r, i, key, s, true);
    }
    // handle por cada waypoint intermedio (relleno)
    for (let m = 1; m < pts.length - 1; m++) {
      const h = this.circle(pts[m].x, pts[m].y, rad) as SVGElement;
      h.classList.remove("dbml-marker", "dbml-marker-circle");
      h.classList.add("dbml-edge-handle");
      this.handleLayer.appendChild(h);
      this.enableHandleDrag(h, r, i, key, m - 1, false);
      const idx = m - 1;
      h.addEventListener("contextmenu", (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.openWaypointMenu(r, i, key, idx, ev);
      });
    }
  }

  // click derecho sobre un quiebre (waypoint): menú para eliminarlo.
  private openWaypointMenu(
    r: Ref,
    i: number,
    key: string,
    idx: number,
    evt: MouseEvent
  ) {
    const menu = new Menu();
    menu.addItem((it) =>
      it
        .setTitle(t("deleteVertex"))
        .setIcon("trash-2")
        .onClick(() => this.deleteWaypoint(r, i, key, idx))
    );
    menu.showAtMouseEvent(evt);
  }

  // elimina el waypoint idx; mismo flujo que insertar (seedCustom -> mutar ->
  // guardar). Si no quedan quiebres, descarta la ruta custom (vuelve al auto).
  private deleteWaypoint(r: Ref, i: number, key: string, idx: number) {
    const mids = this.seedCustom(r, i, key);
    if (idx < 0 || idx >= mids.length) return;
    mids.splice(idx, 1);
    if (mids.length === 0) {
      delete this.customEdges[key];
      delete this.customEdgeBase[key];
    }
    this.scheduleSaveLayout();
    this.refresh();
  }

  // arrastra un waypoint; si isAdd, inserta uno nuevo en segIdx y lo arrastra.
  private enableHandleDrag(
    el: SVGElement,
    r: Ref,
    i: number,
    key: string,
    idx: number,
    isAdd: boolean
  ) {
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      wp = idx,
      started = false;
    el.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      sx = ev.clientX;
      sy = ev.clientY;
      started = false;
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      const mv = (e: PointerEvent) => {
        if (!started) {
          if (Math.hypot(e.clientX - sx, e.clientY - sy) < 3) return;
          started = true;
          const mids = this.seedCustom(r, i, key);
          if (isAdd) {
            // punto inicial = posición actual del add-handle (medio del segmento)
            const cx = parseFloat(el.getAttribute("cx") || "0");
            const cy = parseFloat(el.getAttribute("cy") || "0");
            mids.splice(idx, 0, { x: cx, y: cy });
            wp = idx;
          } else {
            wp = idx;
          }
          ox = mids[wp].x;
          oy = mids[wp].y;
        }
        const mids = this.customEdges[key];
        if (!mids) return;
        // el punto se mueve libre; la ruta se ortogonaliza al dibujar (drawEdge),
        // así siempre queda en ángulos de 90° sin tocar los extremos.
        mids[wp] = {
          x: ox + (e.clientX - sx) / this.view.k,
          y: oy + (e.clientY - sy) / this.view.k,
        };
        el.setAttribute("cx", String(mids[wp].x));
        el.setAttribute("cy", String(mids[wp].y));
        this.redrawEdges(); // solo líneas; handles se reconstruyen al soltar
      };
      const up = (e: PointerEvent) => {
        el.removeEventListener("pointermove", mv);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        // tap sin arrastre sobre un add-handle: inserta un quiebre en ese punto
        // (antes solo se creaba al arrastrar, por eso "el click no hacía nada").
        if (!started && isAdd && e.type !== "pointercancel") {
          const cx = parseFloat(el.getAttribute("cx") || "0");
          const cy = parseFloat(el.getAttribute("cy") || "0");
          const mids = this.seedCustom(r, i, key);
          mids.splice(idx, 0, { x: cx, y: cy });
          this.scheduleSaveLayout();
          this.refresh();
          return;
        }
        if (started) this.scheduleSaveLayout();
        this.redrawHandles();
      };
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }

  // ---- dibujo de áreas ----
  // Cada área se redibuja desde la posición actual de sus tablas: expandida es
  // un recuadro con barra (asa de arrastre y triángulo ▾), colapsada es un
  // recuadro compacto (todo él es asa) con ▸, el nombre y el conteo.
  private redrawAreas() {
    while (this.areaLayer.firstChild)
      this.areaLayer.removeChild(this.areaLayer.firstChild);
    for (const grp of this.model.groups) {
      const box = this.areaBoxOf(grp.name);
      if (!box) continue;
      const color = grp.color ?? Diagram.AREA_DEFAULT_COLOR;
      const isCol = this.collapsed.has(grp.name);
      const el = activeDocument.createElementNS(NS, "g");
      el.classList.add("dbml-area");
      el.style.setProperty("--dbml-area-color", color);
      el.style.setProperty("--dbml-area-txt", this.readableText(color));
      let handle: SVGGElement;
      let w: number;
      if (isCol) {
        const cb = collapsedBox(box, areaNameWidth(grp.name));
        w = cb.w;
        el.classList.add("dbml-area-collapsed");
        el.setAttribute("transform", `translate(${cb.x},${cb.y})`);
        const body = this.rect(0, 0, cb.w, cb.h, "dbml-area-body");
        body.setAttribute("rx", "6");
        el.appendChild(body);
        const n = grp.tables.length;
        el.appendChild(
          this.text(
            12,
            AREA_HEAD_H + 16,
            n === 1 ? t("areaOneTable") : t("areaTables", { n: String(n) }),
            "dbml-area-count"
          )
        );
        handle = el;
      } else {
        w = box.w;
        el.setAttribute("transform", `translate(${box.x},${box.y})`);
        const bg = this.rect(0, 0, box.w, box.h, "dbml-area-bg");
        bg.setAttribute("rx", "8");
        el.appendChild(bg);
        handle = activeDocument.createElementNS(NS, "g");
        el.appendChild(handle);
      }
      // barra de encabezado: esquinas de arriba redondeadas, de abajo rectas
      const head = this.rect(0, 0, w, AREA_HEAD_H, "dbml-area-head");
      head.setAttribute("rx", isCol ? "6" : "8");
      handle.appendChild(head);
      handle.appendChild(this.rect(0, AREA_HEAD_H - 8, w, 8, "dbml-area-head"));
      const hit = this.rect(4, 2, 20, AREA_HEAD_H - 4, "dbml-area-toggle-hit");
      const tip = activeDocument.createElementNS(NS, "title");
      tip.textContent = isCol ? t("expandArea") : t("collapseArea");
      hit.appendChild(tip);
      handle.appendChild(hit);
      handle.appendChild(this.text(9, AREA_HEAD_H / 2 + 4, isCol ? "▸" : "▾", "dbml-area-toggle"));
      handle.appendChild(
        this.text(AREA_LABEL_X, AREA_HEAD_H / 2 + 4, grp.name, "dbml-area-txt")
      );
      this.enableAreaDrag(handle, el, grp.name);
      this.areaLayer.appendChild(el);
    }
  }

  // Arrastrar el asa de un área mueve todas sus tablas (también las ocultas si
  // está colapsada). Durante el arrastre el área se traslada entera, sin
  // redibujarla, para no perder la captura del puntero. Un toque sin arrastre
  // sobre el triángulo colapsa o expande.
  private enableAreaDrag(handle: SVGGElement, el: SVGGElement, name: string) {
    handle.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      const onToggle = !!(ev.target as Element).closest(".dbml-area-toggle-hit");
      const grp = this.model.groups.find((g) => g.name === name);
      if (!grp) return;
      const start = grp.tables
        .filter((tb) => this.pos[tb])
        .map((tb) => ({ tb, x: this.pos[tb].x, y: this.pos[tb].y }));
      const tm = /translate\(([-\d.e]+),([-\d.e]+)\)/.exec(el.getAttribute("transform") || "");
      const bx = tm ? parseFloat(tm[1]) : 0;
      const by = tm ? parseFloat(tm[2]) : 0;
      const sx = ev.clientX;
      const sy = ev.clientY;
      let moved = false;
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      const mv = (e: PointerEvent) => {
        if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        moved = true;
        const dx = (e.clientX - sx) / this.view.k;
        const dy = (e.clientY - sy) / this.view.k;
        for (const s of start) {
          this.pos[s.tb].x = s.x + dx;
          this.pos[s.tb].y = s.y + dy;
          this.movedTables.add(s.tb);
          this.nodeEls
            .get(s.tb)
            ?.setAttribute("transform", `translate(${this.pos[s.tb].x},${this.pos[s.tb].y})`);
        }
        el.setAttribute("transform", `translate(${bx + dx},${by + dy})`);
        this.redrawEdges();
        if (this.selectedEdge) this.redrawHandles();
      };
      const up = (e: PointerEvent) => {
        handle.removeEventListener("pointermove", mv);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        if (moved) {
          this.redrawAreas();
          this.scheduleSaveLayout();
        } else if (e.type === "pointercancel") {
          // gesto abortado: nada
        } else if (onToggle) {
          e.stopPropagation();
          this.toggleArea(name);
        } else {
          // toque fuera del triángulo: menú del área (mismo patrón que el
          // encabezado de tabla, para que el Menu no se cierre al instante)
          e.stopPropagation();
          e.preventDefault();
          const ev2 = e;
          setTimeout(() => this.openAreaMenu(name, ev2), 0);
        }
      };
      handle.addEventListener("pointermove", mv);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // ---- edición de áreas y tablas desde el canvas ----
  // Las escrituras viven en edits.ts (funciones puras); aquí solo se piden
  // datos al usuario, se validan y se escribe en una sola operación.

  private openAreaMenu(name: string, evt: MouseEvent) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const grp = this.model.groups.find((g) => g.name === name);
    if (!grp) return;
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle(t("renameArea")).setIcon("pencil").onClick(() => this.renameArea(name))
    );
    menu.addItem((i) =>
      i
        .setTitle(t("pickColor"))
        .setIcon("palette")
        .onClick(() => this.pickColorFor(grp.color ?? "", (c) => this.setAreaColor(name, c)))
    );
    if (grp.color)
      menu.addItem((i) =>
        i.setTitle(t("removeColor")).setIcon("rotate-ccw").onClick(() => this.setAreaColor(name, null))
      );
    menu.addItem((i) =>
      i.setTitle(t("newTableInArea")).setIcon("table").onClick(() => this.promptNewTable(name))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(t("removeAreaMenu"))
        .setIcon("trash-2")
        .onClick(() =>
          this.confirm(t("removeAreaTitle"), t("removeAreaBody", { name }), t("removeBtn"), () =>
            this.editStructure((l, s, e) => removeGroupInBlock(l, s, e, name), {})
          )
        )
    );
    menu.showAtMouseEvent(evt);
  }

  // posiciones actuales de todas las tablas (también las ocultas en áreas
  // colapsadas), con las indicadas reemplazadas
  private pinsWith(extra: Record<string, Pt>): Record<string, Pt> {
    const out: Record<string, Pt> = {};
    for (const tb of this.model.tables) {
      const p = this.pos[tb.name];
      if (p) out[tb.name] = { x: p.x, y: p.y };
    }
    return { ...out, ...extra };
  }

  // Cambio estructural (crear o mover tablas, crear o quitar áreas): en la misma
  // escritura fija la posición actual de todas las tablas, así ELK recalcula
  // pero nada salta. `extra` da la posición de la tabla creada o movida.
  private editStructure(
    mutate: (lines: string[], start: number, end: number) => boolean,
    extra: Record<string, Pt>
  ) {
    const pins = this.pinsWith(extra);
    this.editBlock((l, s, e) => {
      const before = l.length;
      if (!mutate(l, s, e)) return false;
      return setPositionsInBlock(l, s, e + (l.length - before), pins);
    }, t("editBlockFail"));
  }

  // centro de la vista actual, en coordenadas del diagrama, para una tabla nueva
  private viewCenterSpot(): Pt {
    const r = this.svg.getBoundingClientRect();
    const cx = ((r.width || 600) / 2 - this.view.x) / this.view.k;
    const cy = ((r.height || 400) / 2 - this.view.y) / this.view.k;
    return { x: cx - NODE_W / 2, y: cy - HEAD_H };
  }

  // debajo de la tabla más baja del área, junto al margen izquierdo del recuadro
  private spotInArea(area: string, except?: string): Pt | undefined {
    const rects = this.memberRects(area, except);
    const box = areaBox(rects);
    if (!box) return undefined;
    const bottom = Math.max(...rects.map((r) => r.y + r.h));
    return { x: box.x + AREA_PAD, y: bottom + 40 };
  }

  private promptNewTable(area?: string) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    this.promptText(t("newTablePrompt"), "", (v) => this.createTable(v, area));
  }

  private createTable(name: string, area?: string) {
    if (!NAME_RE.test(name)) {
      new Notice(t("invalidName"));
      return;
    }
    if (this.model.tables.some((x) => x.name === name)) {
      new Notice(t("tableExists", { name }));
      return;
    }
    const at = (area && this.spotInArea(area)) || this.viewCenterSpot();
    this.editStructure(
      (l, s, e) => {
        const before = l.length;
        if (!addTableInBlock(l, s, e, name)) return false;
        return area ? moveTableToGroupInBlock(l, s, e + (l.length - before), name, area) : true;
      },
      { [name]: at }
    );
  }

  // Mueve una tabla a un área (o la saca con null). Entra debajo de las tablas
  // del área destino; al salir queda a la derecha del área que deja.
  private moveTableToArea(table: string, area: string | null) {
    const cur = this.groupOf.get(table);
    if ((cur ?? null) === area) return;
    let at: Pt | undefined;
    if (area) at = this.spotInArea(area, table);
    else if (cur) {
      const box = this.areaBoxOf(cur);
      if (box) at = { x: box.x + box.w + 40, y: box.y };
    }
    this.editStructure(
      (l, s, e) => moveTableToGroupInBlock(l, s, e, table, area),
      at ? { [table]: at } : {}
    );
  }

  private createAreaWithTable(areaName: string, table: string) {
    if (!NAME_RE.test(areaName)) {
      new Notice(t("invalidName"));
      return;
    }
    if (this.model.groups.some((g) => g.name === areaName)) {
      new Notice(t("areaExists", { name: areaName }));
      return;
    }
    const color = nextAreaColor(this.model);
    this.editStructure((l, s, e) => addGroupInBlock(l, s, e, areaName, [table], color), {});
  }

  // lista con buscador: otras áreas y "Nueva área…"
  private chooseArea(table: string) {
    if (!this.plugin) return;
    const cur = this.groupOf.get(table);
    const items: AreaChoice[] = this.model.groups
      .filter((g) => g.name !== cur)
      .map((g) => ({ label: g.name, area: g.name }));
    items.push({ label: t("newArea"), area: null });
    new AreaSuggestModal(this.plugin.app, items, (c) => {
      if (c.area) this.moveTableToArea(table, c.area);
      else this.promptText(t("newAreaPrompt"), "", (v) => this.createAreaWithTable(v, table));
    }).open();
  }

  private renameArea(oldName: string) {
    this.promptText(t("renameAreaPrompt"), oldName, (v) => {
      if (v === oldName) return;
      if (!NAME_RE.test(v)) {
        new Notice(t("invalidName"));
        return;
      }
      if (this.model.groups.some((g) => g.name === v)) {
        new Notice(t("areaExists", { name: v }));
        return;
      }
      this.editBlock((l, s, e) => renameGroupInBlock(l, s, e, oldName, v), t("editBlockFail"));
    });
  }

  private setAreaColor(name: string, color: string | null) {
    this.editBlock(
      (l, s, e) => setGroupColorInBlock(l, s, e, name, color),
      t("editBlockFail")
    );
  }

  // Colapsa o expande un área: redibuja al instante (sin ELK) y guarda la
  // línea `// @group <nombre> collapsed` en el bloque.
  private toggleArea(name: string) {
    if (this.collapsed.has(name)) this.collapsed.delete(name);
    else this.collapsed.add(name);
    this.visCache = undefined;
    if (this.selectedEdge) {
      const r = this.model.refs.find((x) => this.edgeKey(x) === this.selectedEdge);
      if (r && (this.isHidden(r.from) || this.isHidden(r.to))) this.selectedEdge = undefined;
    }
    this.redrawAreas();
    this.drawNodes();
    this.redrawEdges();
    this.redrawHandles();
    this.scheduleSaveLayout();
  }

  // ---- dibujo de nodos ----
  // Redibujable: limpia la capa y omite las tablas de áreas colapsadas.
  private drawNodes() {
    while (this.nodeLayer.firstChild)
      this.nodeLayer.removeChild(this.nodeLayer.firstChild);
    this.nodeEls.clear();
    this.model.tables.forEach((t) => {
      const P = this.pos[t.name];
      if (!P || this.isHidden(t.name)) return;
      const g = activeDocument.createElementNS(NS, "g");
      g.classList.add("dbml-node");
      g.setAttribute("transform", `translate(${P.x},${P.y})`);
      const h = HEAD_H + t.cols.length * ROW_H;
      const w = P.w || NODE_W;

      const body = this.rect(0, 0, w, h, "dbml-body");
      body.setAttribute("rx", "6");
      g.appendChild(body);

      t.cols.forEach((_, i) => {
        const rr = this.rect(
          1,
          HEAD_H + i * ROW_H,
          w - 2,
          ROW_H,
          i % 2 ? "dbml-row alt" : "dbml-row"
        );
        rr.setAttribute("data-col", String(i));
        g.appendChild(rr);
      });

      const head = this.rect(0, 0, w, HEAD_H, "dbml-head");
      head.setAttribute("rx", "6");
      g.appendChild(head);
      const headFix = this.rect(0, HEAD_H - 8, w, 8, "dbml-head");
      g.appendChild(headFix);
      const headTxt = this.text(14, HEAD_H / 2 + 4, t.name, "dbml-head-txt");
      g.appendChild(headTxt);
      if (t.headerColor) {
        // variables CSS (no estilos estáticos inline): styles.css las consume
        g.style.setProperty("--dbml-head-fill", t.headerColor);
        const tc = this.readableText(t.headerColor);
        if (tc) g.style.setProperty("--dbml-head-txt-fill", tc);
      }

      t.cols.forEach((c, i) => {
        const y = HEAD_H + i * ROW_H + ROW_H / 2 + 4;
        const nm = this.text(
          14,
          y,
          c.name,
          "dbml-col" + (c.pk ? " pk" : "")
        );
        nm.setAttribute("data-col", String(i));
        g.appendChild(nm);
        if (c.pk || c.fk) {
          // misma medida que tableWidth usó para reservarle espacio al ícono
          const ic = this.text(
            14 + colNameWidth(c) + 8,
            y,
            c.pk ? "🔑" : "🔗",
            "dbml-icon"
          );
          ic.setAttribute("data-col", String(i));
          g.appendChild(ic);
        }
        let tx = w - 14;
        if (c.nn) {
          const bw = 22;
          const b = this.rect(w - 14 - bw, y - 13, bw, 15, "dbml-badge");
          b.setAttribute("rx", "3");
          b.setAttribute("data-col", String(i));
          g.appendChild(b);
          const bt = this.text(w - 14 - bw / 2, y - 1.5, "NN", "dbml-badge-txt");
          bt.setAttribute("data-col", String(i));
          g.appendChild(bt);
          tx = w - 14 - bw - 8;
        }
        const ty = this.text(tx, y, c.type, "dbml-type");
        ty.setAttribute("data-col", String(i));
        g.appendChild(ty);
      });

      this.enableDrag(g, t.name);
      this.nodeEls.set(t.name, g);
      this.nodeLayer.appendChild(g);
    });
  }

  // elige color de texto legible (blanco u oscuro) según la luminancia del fondo.
  // Resuelve hex/rgb()/hsl()/nombres normalizando con un canvas.
  private readableText(color: string): string {
    const rgb = this.toRgb(color);
    if (!rgb) return "#ffffff";
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return lum > 0.6 ? "#1a1a1a" : "#ffffff";
  }

  private static colorCtx?: CanvasRenderingContext2D | null;
  private toRgb(color: string): [number, number, number] | null {
    const raw = color.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(raw)) {
      const h = raw
        .split("")
        .map((c) => c + c)
        .join("");
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
    if (/^[0-9a-fA-F]{6}$/.test(raw))
      return [
        parseInt(raw.slice(0, 2), 16),
        parseInt(raw.slice(2, 4), 16),
        parseInt(raw.slice(4, 6), 16),
      ];
    // rgb()/hsl()/nombre: normaliza con canvas
    if (Diagram.colorCtx === undefined) {
      const cv = activeDocument.createElement("canvas");
      cv.width = cv.height = 1;
      Diagram.colorCtx = cv.getContext("2d");
    }
    const ctx = Diagram.colorCtx;
    if (!ctx) return null;
    ctx.fillStyle = "#000000";
    ctx.fillStyle = color;
    const norm = ctx.fillStyle; // "#rrggbb" o "rgba(r, g, b, a)"
    if (norm.startsWith("#")) {
      const h = norm.slice(1);
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
    const mm = norm.match(/(\d+(?:\.\d+)?)/g);
    if (mm && mm.length >= 3)
      return [Number(mm[0]), Number(mm[1]), Number(mm[2])];
    return null;
  }

  private rect(x: number, y: number, w: number, h: number, cls: string) {
    const r = activeDocument.createElementNS(NS, "rect");
    r.setAttribute("x", "" + x);
    r.setAttribute("y", "" + y);
    r.setAttribute("width", "" + w);
    r.setAttribute("height", "" + h);
    cls.split(" ").forEach((c) => c && r.classList.add(c));
    return r;
  }
  private text(x: number, y: number, str: string, cls: string) {
    const t = activeDocument.createElementNS(NS, "text");
    t.setAttribute("x", "" + x);
    t.setAttribute("y", "" + y);
    cls.split(" ").forEach((c) => c && t.classList.add(c));
    t.textContent = str;
    return t;
  }

  // ---- interacción ----
  private enableDrag(g: SVGGElement, name: string) {
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      dragging = false,
      moved = false,
      onHeader = false,
      colIdx = -1;
    // Pointer capture: mv/up se enganchan al propio nodo (elemento propio que
    // se libera con el DOM al descargar), no a window -> sin fugas de listeners.
    g.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      dragging = true;
      moved = false;
      const tgt = ev.target as Element;
      onHeader =
        tgt.classList.contains("dbml-head") ||
        tgt.classList.contains("dbml-head-txt");
      const ca = tgt.getAttribute("data-col");
      colIdx = ca !== null ? parseInt(ca, 10) : -1;
      sx = ev.clientX;
      sy = ev.clientY;
      ox = this.pos[name].x;
      oy = this.pos[name].y;
      try {
        g.setPointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      const mv = (e: PointerEvent) => {
        if (!dragging) return;
        if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        moved = true;
        this.movedTables.add(name);
        this.pos[name].x = ox + (e.clientX - sx) / this.view.k;
        this.pos[name].y = oy + (e.clientY - sy) / this.view.k;
        g.setAttribute(
          "transform",
          `translate(${this.pos[name].x},${this.pos[name].y})`
        );
        // su área crece o se achica con ella
        if (this.groupOf.has(name)) this.redrawAreas();
        this.redrawEdges();
        if (this.selectedEdge) this.redrawHandles();
      };
      const up = (e: PointerEvent) => {
        dragging = false;
        g.removeEventListener("pointermove", mv);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        try {
          g.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        if (moved) {
          this.scheduleSaveLayout();
        } else if (e.type === "pointercancel") {
          // gesto abortado: no abrir menú
        } else if (onHeader || colIdx >= 0) {
          // Evita que este pointerup llegue a document: el Menu de Obsidian
          // registra ahí su listener de auto-cierre y, en táctil, el mismo
          // evento (o un click/touchend sintético) cerraría el menú al instante.
          e.stopPropagation();
          e.preventDefault();
          const ev = e;
          if (onHeader) {
            setTimeout(() => this.openHeaderMenu(name, ev), 0);
          } else {
            setTimeout(() => this.openColumnMenu(name, colIdx, ev), 0);
          }
        }
      };
      g.addEventListener("pointermove", mv);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
  }

  private openHeaderMenu(name: string, evt: PointerEvent) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(t("renameTable"))
        .setIcon("pencil")
        .onClick(() =>
          this.promptText(t("renameTablePrompt"), name, (v) =>
            this.renameTable(name, v)
          )
        )
    );
    menu.addItem((i) =>
      i
        .setTitle(t("pickColor"))
        .setIcon("palette")
        .onClick(() => this.pickColor(name))
    );
    menu.addItem((i) =>
      i
        .setTitle(t("removeColor"))
        .setIcon("rotate-ccw")
        .onClick(() => this.setHeaderColor(name, null))
    );
    // áreas: la pertenencia solo cambia por menú (arrastrar no la cambia)
    menu.addItem((i) =>
      i.setTitle(t("moveToArea")).setIcon("folder-input").onClick(() => this.chooseArea(name))
    );
    const curArea = this.groupOf.get(name);
    if (curArea)
      menu.addItem((i) =>
        i
          .setTitle(t("leaveArea", { name: curArea }))
          .setIcon("folder-minus")
          .onClick(() => this.moveTableToArea(name, null))
      );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(t("deleteTableMenu"))
        .setIcon("trash-2")
        .onClick(() =>
          this.confirm(
            t("deleteTableTitle"),
            t("deleteTableBody", { name }),
            t("deleteBtn"),
            () => this.deleteTable(name)
          )
        )
    );
    menu.showAtMouseEvent(evt);
  }

  private openColumnMenu(table: string, colIdx: number, evt: PointerEvent) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const tbl = this.model.tables.find((x) => x.name === table);
    const col = tbl?.cols[colIdx];
    if (!col) return;
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(t("renameColumn"))
        .setIcon("pencil")
        .onClick(() =>
          this.promptText(t("renameColumnPrompt"), col.name, (v) =>
            this.renameColumn(table, col.name, v)
          )
        )
    );
    menu.addItem((i) =>
      i
        .setTitle(t("changeType"))
        .setIcon("type")
        .onClick(() =>
          this.promptText(t("changeTypePrompt"), col.type, (v) =>
            this.setColType(table, col.name, v)
          )
        )
    );
    menu.showAtMouseEvent(evt);
  }

  private promptText(title: string, initial: string, cb: (v: string) => void) {
    if (!this.plugin) return;
    new EditModal(this.plugin.app, title, initial, cb).open();
  }

  private confirm(
    title: string,
    body: string,
    confirmText: string,
    cb: () => void
  ) {
    if (!this.plugin) return;
    new ConfirmModal(this.plugin.app, title, body, confirmText, cb).open();
  }

  private isFence(line: string | undefined): boolean {
    return !!line && /^\s*(```|~~~)/.test(line);
  }

  // Valida que lineStart sea una cerca y localiza la cerca de cierre escaneando
  // hacia adelante (robusto a que el bloque haya crecido con líneas @pos/@view
  // desde que se cacheó el sectionInfo). Devuelve [open, close] o null.
  private blockRange(
    lines: string[],
    lineStart: number
  ): [number, number] | null {
    if (!this.isFence(lines[lineStart])) return null;
    for (let i = lineStart + 1; i < lines.length; i++) {
      if (this.isFence(lines[i])) return [lineStart, i];
    }
    return null;
  }

  // ---- edición de textos (rename / tipo) ----
  private async editBlock(
    mutate: (lines: string[], start: number, end: number) => boolean,
    notFoundMsg: string
  ) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const info = this.ctx.getSectionInfo(this.blockEl);
    if (!info) {
      new Notice(t("locateBlockFail"));
      return;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(
      this.ctx.sourcePath
    );
    if (!(file instanceof TFile)) return;
    let ok = true;
    // vault.process: lectura-modificación-escritura atómica (no pisa ediciones
    // concurrentes entre read y modify).
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const range = this.blockRange(lines, info.lineStart);
      if (!range) {
        ok = false;
        return data;
      }
      if (!mutate(lines, range[0], range[1])) {
        ok = false;
        return data;
      }
      return lines.join("\n");
    });
    if (!ok) new Notice(notFoundMsg);
  }

  private renameTable(oldName: string, newName: string) {
    if (newName === oldName) return;
    this.editBlock(
      (l, s, e) => renameTableInBlock(l, s, e, oldName, newName),
      t("renameTableFail", { name: oldName })
    );
  }

  private deleteTable(name: string) {
    this.editBlock(
      (l, s, e) => deleteTableInBlock(l, s, e, name),
      t("deleteTableFail", { name })
    );
  }

  private renameColumn(table: string, oldCol: string, newCol: string) {
    if (newCol === oldCol) return;
    this.editBlock(
      (l, s, e) => renameColumnInBlock(l, s, e, table, oldCol, newCol),
      t("renameColumnFail")
    );
  }

  private setColType(table: string, col: string, newType: string) {
    this.editBlock(
      (l, s, e) => setColumnTypeInBlock(l, s, e, table, col, newType),
      t("changeTypeFail")
    );
  }

  // ---- guardado de posiciones / vista ----
  private scheduleSaveLayout() {
    if (this.saveTimer) activeWindow.clearTimeout(this.saveTimer);
    this.saveTimer = activeWindow.setTimeout(() => this.saveLayout(), 600);
  }

  private async saveLayout() {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const info = this.ctx.getSectionInfo(this.blockEl);
    if (!info) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(
      this.ctx.sourcePath
    );
    if (!(file instanceof TFile)) return;
    // Evita reescrituras idénticas: cada vault.process dispara un evento
    // "modify" que hace re-renderizar el bloque (nueva instancia => se pierde
    // la selección y parpadea, incluso en bucle). Solo persistimos si el
    // contenido del bloque realmente cambió.
    const current = await this.plugin.app.vault.read(file);
    const next = this.buildLayoutContent(current, info.lineStart);
    if (next === null || next === current) return;
    await this.plugin.app.vault.process(
      file,
      (data) => this.buildLayoutContent(data, info.lineStart) ?? data
    );
  }

  // reconstruye el contenido completo del archivo con las líneas @pos/@view/
  // @size/@edge actualizadas dentro del bloque dbml. Devuelve null si el bloque
  // no se encuentra (no se debe tocar el archivo).
  private buildLayoutContent(data: string, lineStart: number): string | null {
    const lines = data.split("\n");
    const range = this.blockRange(lines, lineStart);
    if (!range) return null;
    {
      const [open, close] = range;
      const body = lines
        .slice(open + 1, close)
        .filter((l) => !/^\s*\/\/\s*@(pos|view|size|edge|group)\b/.test(l));
      // solo persiste posición de tablas que el usuario movió (las demás
      // siguen con auto-layout); la vista siempre se persiste.
      const posLines = this.model.tables
        .filter((t) => this.pos[t.name] && this.movedTables.has(t.name))
        .map((t) => {
          const p = this.pos[t.name];
          return `// @pos ${t.name} ${Math.round(p.x)} ${Math.round(p.y)}`;
        });
      const viewLine = `// @view ${Math.round(this.view.x)} ${Math.round(
        this.view.y
      )} ${this.view.k.toFixed(3)}`;
      // tamaño solo si el usuario lo fijó (px inline); ancho 100% no se persiste.
      const sw = this.readPx(this.hostEl?.style.width);
      const sh = this.readPx(this.hostEl?.style.height);
      const sizeLines =
        Number.isFinite(sw) && Number.isFinite(sh)
          ? [`// @size ${sw} ${sh}`]
          : [];
      // rutas de aristas editadas a mano (solo waypoints intermedios)
      const edgeLines = this.model.refs
        .map((r) => ({ r, key: this.edgeKey(r) }))
        .filter((x) => this.customEdges[x.key]?.length)
        // se guardan en frame actual (mapeados) para que coincidan con @pos; al
        // recargar el frame base se recaptura y el mapeo arranca en identidad.
        .map(({ r, key }) => {
          const pts = this.mappedInterior(r, key);
          return (
            `// @edge ${r.from} ${r.fromCol} ${r.to} ${r.toCol} ` +
            pts.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(" ")
          );
        });
      // áreas colapsadas que existen en el modelo (las de áreas renombradas o
      // borradas en el texto se descartan solas)
      const groupLines = this.model.groups
        .filter((g) => this.collapsed.has(g.name))
        .map((g) => `// @group ${g.name} collapsed`);
      return [
        ...lines.slice(0, open + 1),
        ...body,
        ...posLines,
        ...edgeLines,
        ...groupLines,
        viewLine,
        ...sizeLines,
        ...lines.slice(close),
      ].join("\n");
    }
  }

  private pickColor(name: string) {
    const current =
      this.model.tables.find((t) => t.name === name)?.headerColor || "";
    this.pickColorFor(current, (c) => this.setHeaderColor(name, c));
  }

  // selector de color nativo; `apply` recibe el color elegido (#rrggbb)
  private pickColorFor(current: string, apply: (color: string) => void) {
    this.colorInput?.remove();
    const input = activeDocument.createElement("input");
    this.colorInput = input;
    input.type = "color";
    input.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#5c7fa3";
    input.classList.add("dbml-color-input");
    activeDocument.body.appendChild(input);
    const cleanup = () => {
      input.remove();
      if (this.colorInput === input) this.colorInput = undefined;
    };
    this.registerDomEvent(input, "change", () => {
      apply(input.value);
      cleanup();
    });
    this.registerDomEvent(input, "blur", cleanup);
    input.click();
  }

  private async setHeaderColor(name: string, color: string | null) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const info = this.ctx.getSectionInfo(this.blockEl);
    if (!info) {
      new Notice(t("locateBlockFail"));
      return;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(
      this.ctx.sourcePath
    );
    if (!(file instanceof TFile)) return;
    let done = false;
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const range = this.blockRange(lines, info.lineStart);
      if (!range) return data;
      for (let i = range[0]; i <= range[1] && i < lines.length; i++) {
        const updated = setHeaderColorInLine(lines[i], name, color);
        if (updated !== null) {
          lines[i] = updated;
          done = true;
          break;
        }
      }
      return done ? lines.join("\n") : data;
    });
    if (!done) new Notice(t("tableNotFound", { name }));
  }

  // lee px inline explícitos; ignora "", "100%", "auto", etc.
  private readPx(v?: string): number {
    // acepta px fraccionarios (p.ej. "400.5px") y redondea: el navegador puede
    // fijar tamaños sub-pixel al redimensionar; si no, @size no se persistía y
    // la altura revertía al default en cada re-render.
    const m = /^(\d+(?:\.\d+)?)px$/.exec(v ?? "");
    return m ? Math.round(parseFloat(m[1])) : NaN;
  }

  // persiste el tamaño del lienzo cuando el usuario lo redimensiona (handle CSS).
  private bindResize(host: HTMLElement) {
    const ro = new ResizeObserver(() => {
      const w = this.readPx(host.style.width);
      const h = this.readPx(host.style.height);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return; // sin px inline aún
      const key = `${w} ${h}`;
      if (key === this.lastSize) return; // sin cambio real → evita bucle/carga
      this.lastSize = key;
      this.scheduleSaveLayout();
    });
    ro.observe(host);
    this.register(() => ro.disconnect());
  }

  private bindPanZoom(host: HTMLElement) {
    let panning = false,
      psx = 0,
      psy = 0,
      pvx = 0,
      pvy = 0;
    this.registerDomEvent(host, "pointerdown", (e: PointerEvent) => {
      const tgt = e.target as Element;
      if (tgt.closest(".dbml-node")) return;
      if (tgt.closest(".dbml-edge-hit") || tgt.closest(".dbml-edge-handle"))
        return;
      // clic en vacío: deselecciona la arista activa
      if (this.selectedEdge) {
        this.selectedEdge = undefined;
        this.refresh();
      }
      panning = true;
      host.addClass("panning");
      psx = e.clientX;
      psy = e.clientY;
      pvx = this.view.x;
      pvy = this.view.y;
    });
    this.registerDomEvent(activeWindow, "pointermove", (e: PointerEvent) => {
      if (!panning) return;
      this.view.x = pvx + (e.clientX - psx);
      this.view.y = pvy + (e.clientY - psy);
      this.applyView();
    });
    this.registerDomEvent(activeWindow, "pointerup", () => {
      if (!panning) return;
      panning = false;
      host.removeClass("panning");
      this.scheduleSaveLayout();
    });
    this.registerDomEvent(host, "wheel", (e: WheelEvent) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 0.89;
      const r = host.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      this.view.x = mx - (mx - this.view.x) * f;
      this.view.y = my - (my - this.view.y) * f;
      this.view.k *= f;
      this.applyView();
      this.redrawHandles();
      this.scheduleSaveLayout();
    });
  }

  private zoom(f: number) {
    this.view.k *= f;
    this.applyView();
    this.redrawHandles();
    this.scheduleSaveLayout();
  }
  private applyView() {
    this.vp.setAttribute(
      "transform",
      `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`
    );
  }
  private fit(persist = false) {
    const r = this.svg.getBoundingClientRect();
    if (r.width === 0) return;
    let minX = 1e9,
      minY = 1e9,
      maxX = -1e9,
      maxY = -1e9;
    // encuadra tablas visibles y áreas (expandidas o colapsadas)
    const boxes: Rect[] = [];
    for (const t of this.model.tables) {
      const P = this.pos[t.name];
      if (!P || this.isHidden(t.name)) continue;
      boxes.push(P);
    }
    for (const g of this.model.groups) {
      const b = this.collapsed.has(g.name)
        ? this.collapsedBoxOf(g.name)
        : this.areaBoxOf(g.name);
      if (b) boxes.push(b);
    }
    for (const P of boxes) {
      minX = Math.min(minX, P.x);
      minY = Math.min(minY, P.y);
      maxX = Math.max(maxX, P.x + P.w);
      maxY = Math.max(maxY, P.y + P.h);
    }
    const pad = 40;
    const k = Math.min(
      (r.width - pad * 2) / (maxX - minX),
      (r.height - pad * 2) / (maxY - minY),
      1.4
    );
    this.view.k = isFinite(k) && k > 0 ? k : 1;
    this.view.x =
      pad - minX * this.view.k +
      (r.width - pad * 2 - (maxX - minX) * this.view.k) / 2;
    this.view.y = pad - minY * this.view.k;
    this.applyView();
    if (persist) this.scheduleSaveLayout();
  }
}

// Opción de la lista "Mover a área…": un área existente o "Nueva área…" (null).
interface AreaChoice {
  label: string;
  area: string | null;
}

// Lista con buscador para elegir el área destino de una tabla.
class AreaSuggestModal extends FuzzySuggestModal<AreaChoice> {
  private items: AreaChoice[];
  private onPick: (c: AreaChoice) => void;
  constructor(app: App, items: AreaChoice[], onPick: (c: AreaChoice) => void) {
    super(app);
    this.items = items;
    this.onPick = onPick;
    this.setPlaceholder(t("moveToAreaPlaceholder"));
  }
  getItems(): AreaChoice[] {
    return this.items;
  }
  getItemText(c: AreaChoice): string {
    return c.label;
  }
  onChooseItem(c: AreaChoice): void {
    this.onPick(c);
  }
}

// Modal mínimo con un campo de texto (Enter guarda, Esc cancela).
class ConfirmModal extends Modal {
  private titleText: string;
  private bodyText: string;
  private confirmText: string;
  private onConfirm: () => void;
  constructor(
    app: App,
    titleText: string,
    bodyText: string,
    confirmText: string,
    onConfirm: () => void
  ) {
    super(app);
    this.titleText = titleText;
    this.bodyText = bodyText;
    this.confirmText = confirmText;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.titleText });
    contentEl.createEl("p", { text: this.bodyText });
    const bar = contentEl.createDiv({ cls: "dbml-edit-actions" });
    const ok = bar.createEl("button", { text: this.confirmText });
    ok.classList.add("mod-warning");
    ok.onclick = () => {
      this.close();
      this.onConfirm();
    };
    const cancel = bar.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.close();
    cancel.focus();
  }
  onClose() {
    this.contentEl.empty();
  }
}

class EditModal extends Modal {
  private titleText: string;
  private initial: string;
  private onSubmit: (v: string) => void;
  constructor(
    app: App,
    titleText: string,
    initial: string,
    onSubmit: (v: string) => void
  ) {
    super(app);
    this.titleText = titleText;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.titleText });
    const input = contentEl.createEl("input", { type: "text" });
    input.classList.add("dbml-edit-input");
    input.value = this.initial;
    input.focus();
    input.select();
    const submit = () => {
      const v = input.value.trim();
      this.close();
      if (v) this.onSubmit(v);
    };
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        this.close();
      }
    });
    const bar = contentEl.createDiv({ cls: "dbml-edit-actions" });
    const ok = bar.createEl("button", { text: t("save") });
    ok.classList.add("mod-cta");
    ok.onclick = submit;
    const cancel = bar.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Settings tab: language selector (English default). Changing it updates the
// active language for menus/dialogs/notices opened afterwards.
class DbmlErdSettingTab extends PluginSettingTab {
  private plugin: DbmlErdPlugin;
  constructor(app: App, plugin: DbmlErdPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName(t("settingsLanguage"))
      .setDesc(t("settingsLanguageDesc"))
      .addDropdown((dd) => {
        for (const { value, label } of LANGS) dd.addOption(value, label);
        dd.setValue(this.plugin.settings.lang).onChange(async (v) => {
          this.plugin.settings.lang = v as Lang;
          await this.plugin.saveSettings();
          this.display(); // re-render the tab in the new language
        });
      });
  }
}
