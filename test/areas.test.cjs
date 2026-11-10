// Lógica de áreas sin DOM: recuadros, marcas y aristas hacia áreas colapsadas.
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("./.build/areas.cjs");

test("recuadros de área", () => {
  assert.equal(A.areaBox([]), null);
  assert.deepEqual(
    A.areaBox([{ x: 100, y: 200, w: 216, h: 92 }, { x: 400, y: 150, w: 216, h: 120 }]),
    { x: 84, y: 106, w: 548, h: 202 }
  );
  assert.deepEqual(A.collapsedBox({ x: 10, y: 20, w: 500, h: 300 }, 40), { x: 10, y: 20, w: 160, h: 52 });
  assert.equal(A.collapsedBox({ x: 0, y: 0, w: 1, h: 1 }, 200).w, 240);
});

test("color de un área nueva: el primero libre de la paleta", () => {
  const m = (colors) => ({ tables: [], refs: [], groups: colors.map((c, i) => ({ name: "g" + i, color: c, tables: ["t"] })) });
  assert.equal(A.nextAreaColor(m([])), "#20479e");
  assert.equal(A.nextAreaColor(m(["#20479E", "#2e7d32"])), "#c62828", "sin distinguir mayúsculas");
  assert.equal(A.nextAreaColor(m(A.AREA_PALETTE)), "#20479e", "todos en uso: el primero");
});

test("marcas de cardinalidad", () => {
  const draw = (m) => (m.kind === "many" ? "many" : m.optional ? "circle" : "bar");
  const cases = [
    // op, FK not null, FK pk, extremo from, extremo to
    [">", true, false, "many", "bar"],
    [">", false, false, "many", "circle"],
    [">", false, true, "many", "bar"],
    ["-", false, false, "circle", "circle"],
    ["-", false, true, "bar", "bar"],
    ["<", false, false, "circle", "many"],
    ["<", true, false, "bar", "many"],
    ["<>", false, false, "many", "many"],
  ];
  for (const [op, nn, pk, ef, et] of cases) {
    const model = {
      tables: [
        { name: "a", cols: [{ name: "id", pk: true, nn: true }] },
        { name: "b", cols: [{ name: "a_id", pk, nn }] },
      ],
      refs: [],
      groups: [],
    };
    const r = op === "<"
      ? { from: "a", fromCol: "id", to: "b", toCol: "a_id", op }
      : { from: "b", fromCol: "a_id", to: "a", toCol: "id", op };
    const mk = A.refMarks(model, r);
    assert.deepEqual([draw(mk.from), draw(mk.to)], [ef, et], `${op} nn=${nn} pk=${pk}`);
  }
});

const tb = (name, cols) => ({ name, cols: cols.map((c) => ({ name: c, pk: c === "id", nn: c === "id" })) });
const MODEL = {
  tables: [tb("cliente", ["id"]), tb("pedido", ["id", "cliente_id"]), tb("linea", ["id", "pedido_id", "producto_id"]), tb("producto", ["id"]), tb("zona", ["id", "producto_id"])],
  refs: [
    { from: "pedido", fromCol: "cliente_id", to: "cliente", toCol: "id", op: ">" },
    { from: "linea", fromCol: "pedido_id", to: "pedido", toCol: "id", op: ">" },
    { from: "linea", fromCol: "producto_id", to: "producto", toCol: "id", op: ">" },
    { from: "zona", fromCol: "producto_id", to: "producto", toCol: "id", op: "-" },
  ],
  groups: [{ name: "ventas", tables: ["cliente", "pedido", "linea"] }, { name: "catalogo", tables: ["producto"] }],
};

test("sin áreas colapsadas: una arista por relación, en orden", () => {
  const v = A.visibleEdges(MODEL, new Set());
  assert.deepEqual(v.map((e) => [e.refs, e.aggregated]), [[[0], false], [[1], false], [[2], false], [[3], false]]);
});

test("área colapsada: internas ocultas y externas al recuadro", () => {
  const v = A.visibleEdges(MODEL, new Set(["ventas"]));
  assert.equal(v.length, 2);
  assert.deepEqual(v[1].from, { kind: "area", area: "ventas" });
  assert.equal(v[1].aggregated, true);
});

test("dos áreas colapsadas: una línea por par", () => {
  const v = A.visibleEdges(MODEL, new Set(["ventas", "catalogo"]));
  const between = v.filter((e) => e.from.kind === "area" && e.to.kind === "area");
  assert.equal(between.length, 1);
});

test("unificación y marcas", () => {
  const m = {
    tables: [tb("x", ["id"]), tb("p", ["id", "x_id"]), tb("q", ["id", "x_id"])],
    refs: [
      { from: "p", fromCol: "x_id", to: "x", toCol: "id", op: ">" },
      { from: "q", fromCol: "x_id", to: "x", toCol: "id", op: ">" },
    ],
    groups: [{ name: "g", tables: ["p", "q"] }],
  };
  let v = A.visibleEdges(m, new Set(["g"]));
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].refs, [0, 1]);
  assert.equal(v[0].fromMark.kind, "many");
  m.refs[1].op = "-";
  v = A.visibleEdges(m, new Set(["g"]));
  assert.equal(v[0].fromMark, null, "marcas distintas: sin marca");
});
