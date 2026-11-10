// Ediciones del bloque desde el canvas: renombrar, borrar, tipo, cardinalidad
// y color, incluidas las trampas de nombres con prefijo y de áreas.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("./.build/parser.cjs");

const run = (src, fn) => {
  const L = src.split("\n");
  const ok = fn(L, 0, L.length - 1);
  const out = L.join("\n");
  return { ok, out, m: P.parseDBML(out) };
};
const names = (m) => m.tables.map((t) => t.name).join(",");
const refs = (m) => m.refs.map((r) => `${r.from}.${r.fromCol}${r.op}${r.to}.${r.toCol}`).join("|");

const PREFIX = "Table user_role {\n  user_id integer [not null, ref: > user.id]\n}\n\nTable user {\n  id integer [pk]\n}\n// @pos user 10 20\n// @pos user_role 30 40";

test("renombrar no ataca una tabla o columna con el mismo prefijo", () => {
  const r = run(PREFIX, (l, s, e) => P.renameTableInBlock(l, s, e, "user", "usuario"));
  assert.equal(names(r.m), "user_role,usuario");
  assert.equal(refs(r.m), "user_role.user_id>usuario.id");
  assert.match(r.out, /@pos usuario 10 20/);
});

test("borrar quita la tabla, sus @pos y los ref inline que la apuntan", () => {
  const r = run(PREFIX, (l, s, e) => P.deleteTableInBlock(l, s, e, "user"));
  assert.equal(names(r.m), "user_role");
  assert.match(r.out, /user_id integer \[not null\]/);
  assert.doesNotMatch(r.out, /@pos user /);
});

test("borrar limpia Ref con nombre, forma corta y Ref { } vacío", () => {
  const src = "Table d {\n  id int\n}\nTable x {\n  a int\n  b int\n  c int\n}\nRef fk: x.a > d.id\nx.b > d.id\nRef {\n  x.c > d.id\n}";
  const r = run(src, (l, s, e) => P.deleteTableInBlock(l, s, e, "d"));
  assert.equal(names(r.m), "x");
  assert.doesNotMatch(r.out, /d\.id|Ref \{/);
});

test("cambiar cardinalidad reescribe inline y Ref duplicados", () => {
  const src = "Table a {\n  id int\n}\nTable b {\n  a_id int [ref: > a.id]\n}\nRef: b.a_id > a.id";
  const r = run(src, (l, s, e) => P.setRefOpInBlock(l, s, e, { from: "b", fromCol: "a_id", to: "a", toCol: "id" }, "-"));
  assert.equal(refs(r.m), "b.a_id-a.id");
});

const GROUPED = "TableGroup ventas [color: #2e7d32] {\n  pedido\n  cliente\n}\n\nTable cliente {\n  id int [pk]\n}\n\nTable pedido {\n  id int [pk]\n  cliente_id int [ref: > cliente.id]\n}";

test("con un área declarada antes, las ediciones encuentran la tabla real", () => {
  let r = run(GROUPED, (l, s, e) => P.renameColumnInBlock(l, s, e, "pedido", "cliente_id", "id_cliente"));
  assert.ok(r.ok);
  assert.match(r.out, /id_cliente int \[ref: > cliente\.id\]/);
  r = run(GROUPED, (l, s, e) => P.setColumnTypeInBlock(l, s, e, "pedido", "id", "bigint"));
  assert.match(r.out, /^ {2}id bigint \[pk\]$/m);
  r = run(GROUPED, (l, s, e) => P.setRefOpInBlock(l, s, e, { from: "pedido", fromCol: "cliente_id", to: "cliente", toCol: "id" }, "-"));
  assert.match(r.out, /ref: - cliente\.id/);
  for (const line of GROUPED.split("\n")) {
    if (/^ {2}pedido$/.test(line)) assert.equal(P.setHeaderColorInLine(line, "pedido", "#112233"), null);
  }
});

test("renombrar una tabla actualiza su línea de miembro", () => {
  const r = run(GROUPED, (l, s, e) => P.renameTableInBlock(l, s, e, "pedido", "orden"));
  assert.deepEqual(r.m.groups[0].tables, ["orden", "cliente"]);
  assert.match(r.out, /Table orden \{/);
});

test("borrar una tabla la quita de su área", () => {
  const r = run(GROUPED, (l, s, e) => P.deleteTableInBlock(l, s, e, "pedido"));
  assert.deepEqual(r.m.groups[0].tables, ["cliente"]);
  assert.doesNotMatch(r.out, /pedido/);
});

test("borrar la última tabla de un área elimina el área y su @group", () => {
  const src = "Table a {\n  id int\n}\nTable b {\n  id int\n}\nTableGroup g {\n  a\n}\nTableGroup h {\n  b\n}\n// @group g collapsed\n// @group h collapsed";
  const r = run(src, (l, s, e) => P.deleteTableInBlock(l, s, e, "a"));
  assert.deepEqual(r.m.groups.map((g) => g.name), ["h"]);
  assert.doesNotMatch(r.out, /TableGroup g|@group g /);
  assert.match(r.out, /@group h collapsed/);
});

test("miembro user_role intacto al renombrar user", () => {
  const src = "Table user_role {\n  id int\n}\nTableGroup g {\n  user_role\n  user\n}\nTable user {\n  id int\n}";
  const r = run(src, (l, s, e) => P.renameTableInBlock(l, s, e, "user", "usuario"));
  assert.deepEqual(r.m.groups[0].tables, ["user_role", "usuario"]);
});
