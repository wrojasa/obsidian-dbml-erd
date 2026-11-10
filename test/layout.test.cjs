// Layout con ELK: invariantes sin áreas y con áreas (contenedores).
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDBML } = require("./.build/parser.cjs");
const { computeLayout } = require("./.build/layout.cjs");

const mk = (n, cols) => `Table ${n} {\n  id int [pk]\n${cols.map((c) => `  ${c} int`).join("\n")}\n}\n`;
const overlaps = (rects) => {
  let n = 0;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++;
    }
  return n;
};
// distancia máxima entre los extremos de cada arista y el puerto de su columna
const anchorError = (m, L) => {
  const rowY = (t, c) => 36 + m.tables.find((x) => x.name === t).cols.findIndex((x) => x.name === c) * 28 + 14;
  let max = 0;
  m.refs.forEach((r, i) => {
    const p = L.edges[i].pts;
    assert.ok(p.length >= 2, `arista ${i} sin ruta`);
    const A = L.nodes[r.from], B = L.nodes[r.to];
    const s = p[0], e = p[p.length - 1];
    max = Math.max(
      max,
      Math.min(Math.abs(s.x - A.x), Math.abs(s.x - A.x - A.w)) + Math.abs(s.y - A.y - rowY(r.from, r.fromCol)),
      Math.min(Math.abs(e.x - B.x), Math.abs(e.x - B.x - B.w)) + Math.abs(e.y - B.y - rowY(r.to, r.toCol))
    );
  });
  return max;
};

const BASE =
  mk("cliente", ["vendedor_id"]) + mk("pedido", ["cliente_id", "producto_id"]) + mk("linea", ["pedido_id", "producto_id"]) +
  mk("producto", ["categoria_id"]) + mk("categoria", []) + mk("vendedor", ["zona_id"]) + mk("zona", []) + mk("auditoria", ["usuario"]) +
  "Ref: pedido.cliente_id > cliente.id\nRef: linea.pedido_id > pedido.id\nRef: linea.producto_id > producto.id\n" +
  "Ref: pedido.producto_id > producto.id\nRef: producto.categoria_id > categoria.id\nRef: cliente.vendedor_id > vendedor.id\nRef: vendedor.zona_id > zona.id\n";
const GROUPS =
  "TableGroup ventas [color: #2e7d32] {\n  cliente\n  pedido\n  linea\n}\nTableGroup catalogo {\n  producto\n  categoria\n}\nTableGroup comercial {\n  vendedor\n  zona\n}\n";

test("sin áreas: todas las tablas ubicadas, sin solapes, aristas en sus puertos", async () => {
  const m = parseDBML(BASE);
  const L = await computeLayout(m);
  assert.equal(L.groups, undefined);
  assert.equal(Object.keys(L.nodes).length, m.tables.length);
  assert.equal(overlaps(Object.values(L.nodes)), 0);
  assert.ok(anchorError(m, L) <= 2);
});

test("con áreas: miembros dentro de su recuadro y áreas sin encimarse", async () => {
  const m = parseDBML(BASE + GROUPS);
  const L = await computeLayout(m);
  assert.deepEqual(Object.keys(L.groups), ["ventas", "catalogo", "comercial"]);
  for (const g of m.groups) {
    const b = L.groups[g.name];
    for (const t of g.tables) {
      const n = L.nodes[t];
      assert.ok(n.x >= b.x + 15.5 && n.y >= b.y + 43.5, `${t} respeta el margen de ${g.name}`);
      assert.ok(n.x + n.w <= b.x + b.w - 15.5 && n.y + n.h <= b.y + b.h - 15.5, `${t} cabe en ${g.name}`);
    }
  }
  assert.equal(overlaps([...Object.values(L.groups), L.nodes.auditoria]), 0);
  assert.ok(anchorError(m, L) <= 2);
});

test("área sin miembros válidos: layout plano", async () => {
  const L = await computeLayout(parseDBML(mk("a", []) + "TableGroup x {\n  zz\n}\n"));
  assert.equal(L.groups, undefined);
});
