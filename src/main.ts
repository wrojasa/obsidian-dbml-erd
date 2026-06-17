import {
  Plugin,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Menu,
  Notice,
  TFile,
} from "obsidian";
import { parseDBML, Model, Ref, setHeaderColorInLine } from "./parser";
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
      ctx.addChild(
        new Diagram(wrap, model, layout, { height, plugin: this, ctx, el })
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
  private view = { x: 30, y: 30, k: 1 };
  private movedTables = new Set<string>();
  private plugin?: DbmlErdPlugin;
  private ctx?: MarkdownPostProcessorContext;
  private blockEl?: HTMLElement;
  private svg: SVGSVGElement;
  private vp: SVGGElement;
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;

  constructor(
    parent: HTMLElement,
    model: Model,
    layout: LayoutResult,
    opts?: {
      height?: number;
      plugin?: DbmlErdPlugin;
      ctx?: MarkdownPostProcessorContext;
      el?: HTMLElement;
    }
  ) {
    super(parent);
    this.model = model;
    this.pos = layout.nodes;
    this.elkEdges = layout.edges.map((e) => e.pts);
    this.plugin = opts?.plugin;
    this.ctx = opts?.ctx;
    this.blockEl = opts?.el;

    const host = parent.createDiv({ cls: "dbml-erd-canvas" });
    if (opts?.height) host.style.height = opts.height + "px";
    this.svg = activeDocument.createElementNS(NS, "svg");
    this.svg.classList.add("dbml-erd-svg");
    this.vp = activeDocument.createElementNS(NS, "g");
    this.edgeLayer = activeDocument.createElementNS(NS, "g");
    this.nodeLayer = activeDocument.createElementNS(NS, "g");
    this.vp.appendChild(this.edgeLayer);
    this.vp.appendChild(this.nodeLayer);
    this.svg.appendChild(this.vp);
    host.appendChild(this.svg);

    // toolbar
    const bar = host.createDiv({ cls: "dbml-erd-toolbar" });
    this.btn(bar, "+", () => this.zoom(1.15));
    this.btn(bar, "−", () => this.zoom(0.87));
    this.btn(bar, "⊡", () => this.fit());

    this.drawNodes();
    this.drawAllEdges();
    this.bindPanZoom(host);
    this.applyView();
    // ajustar tras montar (necesita medidas del host)
    activeWindow.requestAnimationFrame(() => this.fit());
  }

  private btn(bar: HTMLElement, label: string, cb: () => void) {
    const b = bar.createEl("button", { text: label });
    b.onclick = cb;
  }

  // ---- geometría ----
  private colRowY(table: string, col: string): number {
    const t = this.model.tables.find((t) => t.name === table)!;
    const i = t.cols.findIndex((c) => c.name === col);
    return HEAD_H + i * ROW_H + ROW_H / 2;
  }

  // ruteo manhattan (para drag): Z entre puertos de columna
  private manhattan(r: Ref): { pts: Pt[]; aSide: string; bSide: string } | null {
    const A = this.pos[r.from];
    const B = this.pos[r.to];
    if (!A || !B) return null;
    const ay = A.y + this.colRowY(r.from, r.fromCol);
    const by = B.y + this.colRowY(r.to, r.toCol);
    const aCx = A.x + NODE_W / 2;
    const bCx = B.x + NODE_W / 2;
    const aRight = bCx >= aCx;
    const ax = aRight ? A.x + NODE_W : A.x;
    const bRight = aCx > bCx;
    const bx = bRight ? B.x + NODE_W : B.x;
    const stub = 18;
    const ax2 = ax + (aRight ? stub : -stub);
    const bx2 = bx + (bRight ? stub : -stub);
    const midX = (ax2 + bx2) / 2;
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
  private drawAllEdges() {
    while (this.edgeLayer.firstChild)
      this.edgeLayer.removeChild(this.edgeLayer.firstChild);
    this.model.refs.forEach((r, i) => {
      const pts = this.elkEdges[i];
      if (pts && pts.length >= 2) this.drawEdge(r, pts);
    });
  }

  // redibuja aristas: si cualquiera de sus extremos fue movido, usa manhattan
  // (posición actual); si no, conserva la ruta ELK original (esquiva).
  private redrawEdges() {
    while (this.edgeLayer.firstChild)
      this.edgeLayer.removeChild(this.edgeLayer.firstChild);
    this.model.refs.forEach((r, i) => {
      if (this.movedTables.has(r.from) || this.movedTables.has(r.to)) {
        const m = this.manhattan(r);
        if (m) this.drawEdge(r, m.pts);
      } else {
        const pts = this.elkEdges[i];
        if (pts && pts.length >= 2) this.drawEdge(r, pts);
      }
    });
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

  private drawEdge(r: Ref, pts: Pt[]) {
    const path = activeDocument.createElementNS(NS, "path");
    path.setAttribute("d", this.roundedPath(pts));
    path.classList.add("dbml-edge");
    this.edgeLayer.appendChild(path);
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
        head.style.fill = t.headerColor;
        headFix.style.fill = t.headerColor;
        const tc = this.readableText(t.headerColor);
        if (tc) headTxt.style.fill = tc;
      }

      t.cols.forEach((c, i) => {
        const y = HEAD_H + i * ROW_H + ROW_H / 2 + 4;
        const nm = this.text(
          14,
          y,
          c.name,
          "dbml-col" + (c.pk ? " pk" : "")
        );
        g.appendChild(nm);
        if (c.pk || c.fk) {
          const ic = this.text(
            14 + c.name.length * 7 + 8,
            y,
            c.pk ? "🔑" : "🔗",
            "dbml-icon"
          );
          g.appendChild(ic);
        }
        let tx = NODE_W - 14;
        if (c.nn) {
          const bw = 22;
          const b = this.rect(NODE_W - 14 - bw, y - 13, bw, 15, "dbml-badge");
          b.setAttribute("rx", "3");
          g.appendChild(b);
          g.appendChild(
            this.text(NODE_W - 14 - bw / 2, y - 1.5, "NN", "dbml-badge-txt")
          );
          tx = NODE_W - 14 - bw - 8;
        }
        g.appendChild(this.text(tx, y, c.type, "dbml-type"));
      });

      this.enableDrag(g, t.name);
      this.nodeLayer.appendChild(g);
    });
  }

  // elige color de texto legible (blanco u oscuro) según la luminancia del fondo
  private readableText(color: string): string {
    const raw = color.trim().replace("#", "");
    const hex =
      raw.length === 3
        ? raw
            .split("")
            .map((c) => c + c)
            .join("")
        : raw;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "#ffffff"; // color con nombre/rgb: asume oscuro
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? "#1a1a1a" : "#ffffff";
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
      onHeader = false;
    g.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      dragging = true;
      moved = false;
      const tgt = ev.target as Element;
      onHeader =
        tgt.classList.contains("dbml-head") ||
        tgt.classList.contains("dbml-head-txt");
      sx = ev.clientX;
      sy = ev.clientY;
      ox = this.pos[name].x;
      oy = this.pos[name].y;
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
      };
      const up = (e: PointerEvent) => {
        dragging = false;
        window.removeEventListener("pointermove", mv);
        window.removeEventListener("pointerup", up);
        if (!moved && onHeader) this.openHeaderMenu(name, e);
      };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
    });
  }

  private openHeaderMenu(name: string, evt: PointerEvent) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const menu = new Menu();
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

  private pickColor(name: string) {
    const current =
      this.model.tables.find((t) => t.name === name)?.headerColor || "";
    const input = activeDocument.createElement("input");
    input.type = "color";
    input.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#5c7fa3";
    input.classList.add("dbml-color-input");
    activeDocument.body.appendChild(input);
    input.addEventListener("change", () => {
      this.setHeaderColor(name, input.value);
      input.remove();
    });
    input.addEventListener("blur", () => input.remove());
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
    const content = await this.plugin.app.vault.read(file);
    const lines = content.split("\n");
    let done = false;
    for (let i = info.lineStart; i <= info.lineEnd && i < lines.length; i++) {
      const updated = setHeaderColorInLine(lines[i], name, color);
      if (updated !== null) {
        lines[i] = updated;
        done = true;
        break;
      }
    }
    if (!done) {
      new Notice(`DBML ERD: no se encontró la tabla "${name}".`);
      return;
    }
    await this.plugin.app.vault.modify(file, lines.join("\n"));
  }

  private bindPanZoom(host: HTMLElement) {
    let panning = false,
      psx = 0,
      psy = 0,
      pvx = 0,
      pvy = 0;
    this.registerDomEvent(host, "pointerdown", (e: PointerEvent) => {
      if ((e.target as Element).closest(".dbml-node")) return;
      panning = true;
      host.addClass("panning");
      psx = e.clientX;
      psy = e.clientY;
      pvx = this.view.x;
      pvy = this.view.y;
    });
    this.registerDomEvent(window, "pointermove", (e: PointerEvent) => {
      if (!panning) return;
      this.view.x = pvx + (e.clientX - psx);
      this.view.y = pvy + (e.clientY - psy);
      this.applyView();
    });
    this.registerDomEvent(window, "pointerup", () => {
      panning = false;
      host.removeClass("panning");
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
    });
  }

  private zoom(f: number) {
    this.view.k *= f;
    this.applyView();
  }
  private applyView() {
    this.vp.setAttribute(
      "transform",
      `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`
    );
  }
  private fit() {
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
  }
}
