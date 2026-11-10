// Ediciones estructurales desde el canvas (src/edits.ts): crear tablas y
// áreas, editar áreas, mover tablas entre áreas y fijar posiciones.
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./.build/edits.cjs");
const { parseDBML, parseGroupState, parsePositions } = require("./.build/parser.cjs");

// bloque con cercas, como lo recibe el plugin
const fence = (body) => "```dbml\n" + body + "\n```";
const run = (body, fn) => {
  const L = fence(body).split("\n");
  const ok = fn(L, 0, L.length - 1);
  const out = L.join("\n");
  return { ok, out, m: parseDBML(out) };
};
const groups = (m) => m.groups.map((g) => `${g.name}${g.color ? "[" + g.color + "]" : ""}:${g.tables.join(",")}`).join(" | ");

const BASE =
  "Table cliente {\n  id integer [pk, not null]\n}\n\nTable pedido {\n  id integer [pk, not null]\n  cliente_id integer [ref: > cliente.id]\n}\n\n" +
  "TableGroup ventas [color: #2e7d32] {\n  cliente\n  pedido\n}\n\nRef: pedido.cliente_id > cliente.id\n// @pos cliente 10 20\n// @group ventas collapsed\n// @view 0 0 1.000";

test("crear tabla: va después de la última tabla", () => {
  const r = run(BASE, (l, s, e) => E.addTableInBlock(l, s, e, "producto"));
  assert.ok(r.ok);
  assert.deepEqual(r.m.tables.map((t) => t.name), ["cliente", "pedido", "producto"]);
  assert.ok(r.out.indexOf("Table producto") < r.out.indexOf("TableGroup ventas"), "antes del área");
  assert.equal(r.m.tables[2].cols[0].pk && r.m.tables[2].cols[0].nn, true);
  assert.match(r.out, /\}\n\nTable producto \{\n {2}id integer \[pk, not null\]\n\}\n\nTableGroup/);
});

test("crear tabla: nombre inválido o repetido no cambia nada", () => {
  for (const bad of ["con espacio", "año", "pedido", ""]) {
    const r = run(BASE, (l, s, e) => E.addTableInBlock(l, s, e, bad));
    assert.equal(r.ok, false, bad);
    assert.equal(r.out, fence(BASE));
  }
});

test("crear tabla en un bloque vacío", () => {
  const r = run("", (l, s, e) => E.addTableInBlock(l, s, e, "a"));
  assert.ok(r.ok);
  assert.deepEqual(r.m.tables.map((t) => t.name), ["a"]);
  assert.match(r.out, /^```dbml\nTable a \{/);
});

test("crear área con una tabla que estaba en otra: el área vieja vaciada se elimina", () => {
  const src = BASE.replace("  cliente\n  pedido\n", "  cliente\n");
  const r = run(src, (l, s, e) => E.addGroupInBlock(l, s, e, "clientes", ["cliente"], "#20479e"));
  assert.ok(r.ok);
  assert.equal(groups(r.m), "clientes[#20479e]:cliente");
  assert.doesNotMatch(r.out, /TableGroup ventas|@group ventas/);
  assert.ok(r.out.indexOf("TableGroup clientes") < r.out.indexOf("Ref:"), "antes de los Ref");
});

test("crear área: validaciones", () => {
  assert.equal(run(BASE, (l, s, e) => E.addGroupInBlock(l, s, e, "ventas", ["cliente"])).ok, false, "nombre repetido");
  assert.equal(run(BASE, (l, s, e) => E.addGroupInBlock(l, s, e, "mal nombre", ["cliente"])).ok, false, "nombre inválido");
  assert.equal(run(BASE, (l, s, e) => E.addGroupInBlock(l, s, e, "x", ["zz"])).ok, false, "sin tablas válidas");
  assert.equal(run(BASE, (l, s, e) => E.addGroupInBlock(l, s, e, "x", ["cliente"], "red")).ok, false, "color inválido");
});

test("renombrar área: encabezado y línea @group", () => {
  const r = run(BASE, (l, s, e) => E.renameGroupInBlock(l, s, e, "ventas", "comercial"));
  assert.ok(r.ok);
  assert.equal(groups(r.m), "comercial[#2e7d32]:cliente,pedido");
  assert.deepEqual([...parseGroupState(r.out)], ["comercial"]);
  assert.equal(run(BASE, (l, s, e) => E.renameGroupInBlock(l, s, e, "nada", "x")).ok, false);
});

test("color de área: poner, cambiar y quitar sin tocar otros settings", () => {
  let r = run(BASE, (l, s, e) => E.setGroupColorInBlock(l, s, e, "ventas", "#c62828"));
  assert.equal(groups(r.m), "ventas[#c62828]:cliente,pedido");
  r = run(BASE, (l, s, e) => E.setGroupColorInBlock(l, s, e, "ventas", null));
  assert.equal(groups(r.m), "ventas:cliente,pedido");
  assert.match(r.out, /^TableGroup ventas \{$/m);
  const withNote = BASE.replace("[color: #2e7d32]", "[note: 'a, b', color: #2e7d32]");
  r = run(withNote, (l, s, e) => E.setGroupColorInBlock(l, s, e, "ventas", "#00838f"));
  assert.match(r.out, /^TableGroup ventas \[note: 'a, b', color: #00838f\] \{$/m);
});

test("quitar área: conserva las tablas y borra su @group", () => {
  const r = run(BASE, (l, s, e) => E.removeGroupInBlock(l, s, e, "ventas"));
  assert.ok(r.ok);
  assert.equal(r.m.groups.length, 0);
  assert.deepEqual(r.m.tables.map((t) => t.name), ["cliente", "pedido"]);
  assert.doesNotMatch(r.out, /@group|TableGroup/);
  assert.doesNotMatch(r.out, /\n\n\n/, "sin líneas vacías dobles");
});

test("mover tabla entre áreas, a una nueva y fuera", () => {
  const src = BASE + "\n";
  const two = src.replace("Ref:", "TableGroup otra {\n  cliente\n}\n\nRef:").replace("  cliente\n  pedido\n", "  pedido\n");
  let r = run(two, (l, s, e) => E.moveTableToGroupInBlock(l, s, e, "pedido", "otra"));
  assert.ok(r.ok);
  assert.equal(groups(r.m), "otra:cliente,pedido", "ventas quedó vacía y se eliminó");
  assert.doesNotMatch(r.out, /@group ventas/);
  r = run(BASE, (l, s, e) => E.moveTableToGroupInBlock(l, s, e, "pedido", null));
  assert.equal(groups(r.m), "ventas[#2e7d32]:cliente");
  r = run(BASE, (l, s, e) => E.moveTableToGroupInBlock(l, s, e, "pedido", "ventas"));
  assert.ok(r.ok, "ya es miembro: sin cambios");
  assert.equal(r.out, fence(BASE));
  assert.equal(run(BASE, (l, s, e) => E.moveTableToGroupInBlock(l, s, e, "pedido", "nada")).ok, false);
});

test("fijar posiciones: reemplaza y agrega solo líneas @pos", () => {
  const r = run(BASE, (l, s, e) => E.setPositionsInBlock(l, s, e, { cliente: { x: 1.4, y: 2.6 }, pedido: { x: 300, y: 40 } }));
  assert.deepEqual(parsePositions(r.out), { cliente: { x: 1, y: 3 }, pedido: { x: 300, y: 40 } });
  assert.match(r.out, /@group ventas collapsed/);
  assert.match(r.out, /@view 0 0 1\.000/);
  assert.match(r.out, /\/\/ @pos pedido 300 40\n```$/, "las nuevas, antes de la cerca de cierre");
});

test("CRLF: las líneas nuevas conservan el fin de línea", () => {
  const L = fence(BASE).split("\n").map((l) => l + "\r");
  E.addTableInBlock(L, 0, L.length - 1, "producto");
  assert.ok(L.every((l) => l.endsWith("\r")));
});
