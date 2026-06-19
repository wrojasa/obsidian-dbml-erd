import {
  Plugin,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Menu,
  Modal,
  App,
  Notice,
  TFile,
} from "obsidian";
import {
  parseDBML,
  Model,
  Ref,
  setHeaderColorInLine,
  renameTableInBlock,
  renameColumnInBlock,
  setColumnTypeInBlock,
  parsePositions,
  parseView,
  parseSize,
  parseEdges,
} from "./parser";
import {
  computeLayout,
  LayoutResult,
  NodePos,
  Pt,
  ROW_H,
  HEAD_H,
  NODE_W,
} from "./layout";

const NS = "http://www.w3.org/2000/svg";

export default class DbmlErdPlugin extends Plugin {
  async onload() {
    const handler = (
      source: string,
      el: HTMLElement,
      ctx: MarkdownPostProcessorContext
    ) => this.renderBlock(source, el, ctx);
    this.registerMarkdownCodeBlockProcessor("dbml", handler);
    this.registerMarkdownCodeBlockProcessor("DBML", handler);
  }

  async renderBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ) {
    el.empty();
    const wrap = el.createDiv({ cls: "dbml-erd-wrap" });
    wrap.setText("Renderizando ERD…");
    let model: Model;
    try {
      model = parseDBML(source);
    } catch (e) {
      wrap.setText(
        "Error de parseo: " + (e instanceof Error ? e.message : String(e))
      );
      return;
    }
    if (model.tables.length === 0) {
      wrap.setText("DBML sin tablas.");
      return;
    }
    try {
      const layout = await computeLayout(model);
      wrap.empty();
      const hMatch = source.match(/\/\/\s*(?:canvas-)?height:\s*(\d+)/i);
      const height = hMatch ? parseInt(hMatch[1], 10) : undefined;
      const savedPos = parsePositions(source);
      const view = parseView(source);
      const size = parseSize(source);
      const savedEdges = parseEdges(source);
      ctx.addChild(
        new Diagram(wrap, model, layout, {
          height,
          plugin: this,
          ctx,
          el,
          savedPos,
          view: view ?? undefined,
          size: size ?? undefined,
          savedEdges,
        })
      );
    } catch (e) {
      wrap.setText(
        "Error de layout: " + (e instanceof Error ? e.message : String(e))
      );
    }
  }
}

class Diagram extends MarkdownRenderChild {
  private model: Model;
  private pos: Record<string, NodePos>;
  private elkEdges: Pt[][]; // ruta ELK original por ref
  private customEdges: Record<string, Pt[]> = {}; // waypoints intermedios por ref
  // frame de anclas (extremos + lados) con el que se autorizaron los waypoints
  // de cada ref; sirve para estirarlos afín-mente al mover tablas (base->actual).
  private customEdgeBase: Record<
    string,
    { ax: number; ay: number; bx: number; by: number; aR: boolean; bR: boolean }
  > = {};
  private selectedEdge?: string; // ref con handles visibles
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
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;
  private handleLayer: SVGGElement;

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
    }
  ) {
    super(parent);
    this.model = model;
    this.pos = layout.nodes;
    this.elkEdges = layout.edges.map((e) => e.pts);
    this.plugin = opts?.plugin;
    this.ctx = opts?.ctx;
    this.blockEl = opts?.el;

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
    this.edgeLayer = activeDocument.createElementNS(NS, "g");
    this.nodeLayer = activeDocument.createElementNS(NS, "g");
    this.handleLayer = activeDocument.createElementNS(NS, "g");
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

    this.drawNodes();
    this.redrawEdges();
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

  // rectángulos de tabla (obstáculos) excluyendo las indicadas
  private tableRects(
    ignore: string[]
  ): { x: number; y: number; w: number; h: number }[] {
    const ig = new Set(ignore);
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const t of this.model.tables) {
      if (ig.has(t.name)) continue;
      const p = this.pos[t.name];
      if (!p) continue;
      out.push({
        x: p.x,
        y: p.y,
        w: p.w || NODE_W,
        h: p.h || HEAD_H + t.cols.length * ROW_H,
      });
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
    const ay = A.y + this.colRowY(r.from, r.fromCol);
    const by = B.y + this.colRowY(r.to, r.toCol);
    const aCx = A.x + NODE_W / 2;
    const bCx = B.x + NODE_W / 2;
    // Si las tablas se solapan en X (apiladas), ambas salen por el mismo lado
    // y la línea rodea por fuera; si no, cada una mira hacia la otra.
    const overlapX = Math.abs(bCx - aCx) < NODE_W;
    const aRight = overlapX ? true : bCx >= aCx;
    const bRight = overlapX ? true : !aRight;
    const ax = aRight ? A.x + NODE_W : A.x;
    const bx = bRight ? B.x + NODE_W : B.x;
    const stub = 18;
    const ax2 = ax + (aRight ? stub : -stub);
    const bx2 = bx + (bRight ? stub : -stub);
    // canal vertical base (como antes); luego se busca uno libre de colisiones.
    const baseMid = overlapX ? Math.max(ax2, bx2) : (ax2 + bx2) / 2;
    const rects = this.tableRects([r.from, r.to]);
    // candidatos: base, stubs y bordes ±margen de cada tabla. Se prueba el más
    // cercano a baseMid que no cruce ninguna tabla en los 3 tramos.
    const margin = 22;
    const cands = [baseMid, ax2, bx2];
    for (const t of this.model.tables) {
      const p = this.pos[t.name];
      if (!p) continue;
      cands.push(p.x - margin, p.x + (p.w || NODE_W) + margin);
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
  private redrawEdges() {
    while (this.edgeLayer.firstChild)
      this.edgeLayer.removeChild(this.edgeLayer.firstChild);
    this.model.refs.forEach((r, i) => {
      const pts = this.edgePts(r, i);
      if (pts && pts.length >= 2) this.drawEdge(r, pts, this.edgeKey(r));
    });
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
    let aR: boolean, bR: boolean;
    if (base) {
      aR = base.aR;
      bR = base.bR;
    } else if (mid.length) {
      aR = mid[0].x >= A.x + NODE_W / 2;
      bR = mid[mid.length - 1].x >= B.x + NODE_W / 2;
    } else {
      aR = B.x + NODE_W / 2 >= A.x + NODE_W / 2;
      bR = !aR;
    }
    const ax = aR ? A.x + NODE_W : A.x;
    const bx = bR ? B.x + NODE_W : B.x;
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

  // localiza la columna FK (lado muchos) y si es nullable -> el lado uno es opcional
  private fkOptional(r: Ref): boolean {
    let table: string, col: string;
    if (r.op === "<") {
      table = r.to;
      col = r.toCol; // en <, el lado muchos es 'to'
    } else {
      table = r.from;
      col = r.fromCol; // en >, -, el FK está en 'from'
    }
    const t = this.model.tables.find((t) => t.name === table);
    const c = t?.cols.find((c) => c.name === col);
    return c ? !c.nn : false; // FK nullable => opcional; si no se halla, mandatorio
  }

  private drawEdge(r: Ref, pts: Pt[], key: string) {
    const d = this.roundedPath(pts);
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
    const fromMany = r.op === ">" || r.op === "<>";
    const toMany = r.op === "<" || r.op === "<>";
    const opt = this.fkOptional(r);
    this.edgeLayer.appendChild(
      this.marker(s.x, s.y, this.endpointSide(pts, "start"), fromMany ? "many" : "one", opt)
    );
    this.edgeLayer.appendChild(
      this.marker(e.x, e.y, this.endpointSide(pts, "end"), toMany ? "many" : "one", opt)
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
          .setTitle("Restablecer ruta")
          .setIcon("rotate-ccw")
          .onClick(() => this.resetEdge(key))
      );
    }
    menu.addItem((i) =>
      i
        .setTitle("Deseleccionar")
        .setIcon("x")
        .onClick(() => {
          this.selectedEdge = undefined;
          this.refresh();
        })
    );
    menu.showAtMouseEvent(evt);
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
    }
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
        mids[wp] = {
          x: ox + (e.clientX - sx) / this.view.k,
          y: oy + (e.clientY - sy) / this.view.k,
        };
        // snap a ortogonal: forma L con vecinos (un eje de cada). Durante el
        // arrastre seedCustom dejó base = actual, así que estos midpoints están
        // en el mismo frame que las anclas.
        const anc = this.currentAnchors(r, mids);
        if (anc) {
          const prevPt =
            wp === 0 ? { x: anc.ax, y: anc.ay } : mids[wp - 1];
          const nextPt =
            wp === mids.length - 1 ? { x: anc.bx, y: anc.by } : mids[wp + 1];
          const opt1 = { x: prevPt.x, y: nextPt.y };
          const opt2 = { x: nextPt.x, y: prevPt.y };
          const d1 = Math.hypot(mids[wp].x - opt1.x, mids[wp].y - opt1.y);
          const d2 = Math.hypot(mids[wp].x - opt2.x, mids[wp].y - opt2.y);
          mids[wp] = d1 < d2 ? opt1 : opt2;
        }
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
        if (started) this.scheduleSaveLayout();
        this.redrawHandles();
      };
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }

  // ---- dibujo de nodos ----
  private drawNodes() {
    this.model.tables.forEach((t) => {
      const P = this.pos[t.name];
      if (!P) return;
      const g = activeDocument.createElementNS(NS, "g");
      g.classList.add("dbml-node");
      g.setAttribute("transform", `translate(${P.x},${P.y})`);
      const h = HEAD_H + t.cols.length * ROW_H;

      const body = this.rect(0, 0, NODE_W, h, "dbml-body");
      body.setAttribute("rx", "6");
      g.appendChild(body);

      t.cols.forEach((_, i) => {
        const rr = this.rect(
          1,
          HEAD_H + i * ROW_H,
          NODE_W - 2,
          ROW_H,
          i % 2 ? "dbml-row alt" : "dbml-row"
        );
        rr.setAttribute("data-col", String(i));
        g.appendChild(rr);
      });

      const head = this.rect(0, 0, NODE_W, HEAD_H, "dbml-head");
      head.setAttribute("rx", "6");
      g.appendChild(head);
      const headFix = this.rect(0, HEAD_H - 8, NODE_W, 8, "dbml-head");
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
          const ic = this.text(
            14 + c.name.length * 7 + 8,
            y,
            c.pk ? "🔑" : "🔗",
            "dbml-icon"
          );
          ic.setAttribute("data-col", String(i));
          g.appendChild(ic);
        }
        let tx = NODE_W - 14;
        if (c.nn) {
          const bw = 22;
          const b = this.rect(NODE_W - 14 - bw, y - 13, bw, 15, "dbml-badge");
          b.setAttribute("rx", "3");
          b.setAttribute("data-col", String(i));
          g.appendChild(b);
          const bt = this.text(NODE_W - 14 - bw / 2, y - 1.5, "NN", "dbml-badge-txt");
          bt.setAttribute("data-col", String(i));
          g.appendChild(bt);
          tx = NODE_W - 14 - bw - 8;
        }
        const ty = this.text(tx, y, c.type, "dbml-type");
        ty.setAttribute("data-col", String(i));
        g.appendChild(ty);
      });

      this.enableDrag(g, t.name);
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
        .setTitle("Renombrar tabla…")
        .setIcon("pencil")
        .onClick(() =>
          this.promptText("Nuevo nombre de la tabla", name, (v) =>
            this.renameTable(name, v)
          )
        )
    );
    menu.addItem((i) =>
      i
        .setTitle("Elegir color…")
        .setIcon("palette")
        .onClick(() => this.pickColor(name))
    );
    menu.addItem((i) =>
      i
        .setTitle("Quitar color")
        .setIcon("rotate-ccw")
        .onClick(() => this.setHeaderColor(name, null))
    );
    menu.showAtMouseEvent(evt);
  }

  private openColumnMenu(table: string, colIdx: number, evt: PointerEvent) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const t = this.model.tables.find((t) => t.name === table);
    const col = t?.cols[colIdx];
    if (!col) return;
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Renombrar columna…")
        .setIcon("pencil")
        .onClick(() =>
          this.promptText("Nuevo nombre de la columna", col.name, (v) =>
            this.renameColumn(table, col.name, v)
          )
        )
    );
    menu.addItem((i) =>
      i
        .setTitle("Cambiar tipo…")
        .setIcon("type")
        .onClick(() =>
          this.promptText("Nuevo tipo de dato", col.type, (v) =>
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
      new Notice("DBML ERD: no se pudo ubicar el bloque para editar.");
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
      `No se pudo renombrar "${oldName}" (¿nombre válido? solo letras, números y _).`
    );
  }

  private renameColumn(table: string, oldCol: string, newCol: string) {
    if (newCol === oldCol) return;
    this.editBlock(
      (l, s, e) => renameColumnInBlock(l, s, e, table, oldCol, newCol),
      "No se pudo renombrar la columna."
    );
  }

  private setColType(table: string, col: string, newType: string) {
    this.editBlock(
      (l, s, e) => setColumnTypeInBlock(l, s, e, table, col, newType),
      "No se pudo cambiar el tipo (use letras, números, _ y paréntesis)."
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
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const range = this.blockRange(lines, info.lineStart);
      if (!range) return data;
      const [open, close] = range;
      const body = lines
        .slice(open + 1, close)
        .filter((l) => !/^\s*\/\/\s*@(pos|view|size|edge)\b/.test(l));
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
      return [
        ...lines.slice(0, open + 1),
        ...body,
        ...posLines,
        ...edgeLines,
        viewLine,
        ...sizeLines,
        ...lines.slice(close),
      ].join("\n");
    });
  }

  private pickColor(name: string) {
    const current =
      this.model.tables.find((t) => t.name === name)?.headerColor || "";
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
      this.setHeaderColor(name, input.value);
      cleanup();
    });
    this.registerDomEvent(input, "blur", cleanup);
    input.click();
  }

  private async setHeaderColor(name: string, color: string | null) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const info = this.ctx.getSectionInfo(this.blockEl);
    if (!info) {
      new Notice("DBML ERD: no se pudo ubicar el bloque para editar.");
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
    if (!done) new Notice(`DBML ERD: no se encontró la tabla "${name}".`);
  }

  // lee px inline explícitos; ignora "", "100%", "auto", etc.
  private readPx(v?: string): number {
    const m = /^(\d+)px$/.exec(v ?? "");
    return m ? parseInt(m[1], 10) : NaN;
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
    for (const t of this.model.tables) {
      const P = this.pos[t.name];
      if (!P) continue;
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

// Modal mínimo con un campo de texto (Enter guarda, Esc cancela).
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
    const ok = bar.createEl("button", { text: "Guardar" });
    ok.classList.add("mod-cta");
    ok.onclick = submit;
    const cancel = bar.createEl("button", { text: "Cancelar" });
    cancel.onclick = () => this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}
