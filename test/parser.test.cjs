// Parser DBML: tablas, columnas, relaciones, robustez y áreas (TableGroup).
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDBML, parseGroupState, parsePositions, parseView, parseSize, parseEdges } = require("./.build/parser.cjs");

const names = (m) => m.tables.map((t) => t.name);
const cols = (m, t) => m.tables.find((x) => x.name === t).cols;
const refs = (m) => m.refs.map((r) => `${r.from}.${r.fromCol}${r.op}${r.to}.${r.toCol}`);
const two = "Table a {\n  id integer [pk]\n}\nTable b {\n  a_id integer\n}\n";

test("tablas, columnas y settings", () => {
  const m = parseDBML(
    "table a [headercolor: #112233] {\n  id integer [PK]\n  n varchar(10) [not  null, note: 'it\\'s pk']\n  t timestamp with time zone\n}\nTable b\n{\n  x int\n}"
  );
  assert.deepEqual(names(m), ["a", "b"]);
  assert.equal(m.tables[0].headerColor, "#112233");
  const [id, n, t] = cols(m, "a");
  assert.equal(id.pk, true);
  assert.equal(n.nn, true);
  assert.equal(n.pk, false, "el texto de la nota no es un setting");
  assert.equal(n.note, "it's pk");
  assert.equal(t.type, "timestamp with time zone");
});

test("relaciones en todas sus formas", () => {
  assert.deepEqual(refs(parseDBML(two + "Ref fk: b.a_id > a.id [delete: cascade]")), ["b.a_id>a.id"]);
  assert.deepEqual(refs(parseDBML("Ref: b.a_id > a.id\n" + two)), ["b.a_id>a.id"]);
  assert.deepEqual(refs(parseDBML(two + "Ref {\n  b.a_id - a.id\n}")), ["b.a_id-a.id"]);
  assert.deepEqual(refs(parseDBML(two.replace("a_id integer", "a_id integer [ref: > a.id]"))), ["b.a_id>a.id"]);
});

test("relaciones inválidas o duplicadas", () => {
  assert.deepEqual(refs(parseDBML(two + "Ref: b.a_id > zz.id")), [], "destino inexistente");
  assert.deepEqual(refs(parseDBML("Table A {\n  id int\n}\nTable b {\n  a_id int [ref: > a.id]\n}")), [], "case distinto");
  const dup = two.replace("a_id integer", "a_id integer [ref: > a.id]") + "Ref: b.a_id > a.id";
  assert.equal(parseDBML(dup).refs.length, 1);
});

test("marca FK en el lado muchos", () => {
  const m = parseDBML(two + "Ref: a.id < b.a_id");
  assert.equal(cols(m, "b")[0].fk, true);
  assert.equal(cols(m, "a")[0].fk, false);
});

test("comentarios, bloques que no son tablas y BOM", () => {
  const m = parseDBML(
    "﻿/* Table g {\n id int\n} */\nTableGroup {\n  a\n}\nenum {\n  x\n}\nNote n {\n  'b.a_id > a.id'\n}\n" + two
  );
  assert.deepEqual(names(m), ["a", "b"]);
  assert.equal(m.refs.length, 0);
});

test("notas que no crean columnas ni relaciones", () => {
  const m = parseDBML(
    "Table a {\n  id int\n  x int [note: 'antes ref: > a.id']\n  Note {\n    'texto'\n  }\n  Note: '''\n  uno\n  dos\n  '''\n}"
  );
  assert.deepEqual(cols(m, "a").map((c) => c.name), ["id", "x"]);
  assert.equal(m.refs.length, 0);
  assert.equal(m.tables[0].note, "uno dos");
});

test("áreas: nombre, color y miembros", () => {
  const m = parseDBML(
    "TableGroup ventas [color: #2e7d32] {\n  b\n  a\n  zz\n  a\n  Note: 'x'\n}\n" + two
  );
  assert.deepEqual(m.groups, [{ name: "ventas", color: "#2e7d32", tables: ["b", "a"] }]);
});

test("áreas: reglas de pertenencia y casos límite", () => {
  const t3 = two + "Table c {\n  id int\n}\n";
  assert.deepEqual(
    parseDBML(t3 + "TableGroup g1 {\n  a\n}\nTableGroup g2 {\n  a\n  b\n}").groups.map((g) => g.tables),
    [["a"], ["b"]],
    "una tabla pertenece a la primera área"
  );
  assert.deepEqual(parseDBML(two + "TableGroup v {\n  zz\n}").groups, [], "área sin miembros válidos");
  assert.deepEqual(parseDBML(two + "TableGroup g {\n  a\n}\nTableGroup g {\n  b\n}").groups.length, 1, "nombre repetido");
  assert.deepEqual(
    parseDBML(two + "tablegroup x [COLOR: #abc]\n{\n  public.a\n}").groups,
    [{ name: "x", color: "#abc", tables: ["a"] }],
    "palabra clave sin mayúsculas, llave abajo y esquema"
  );
  assert.equal(parseDBML(two + "TableGroup x {\n  b\n  b.a_id > a.id\n}").refs.length, 0, "el cuerpo no se lee como relaciones");
  assert.deepEqual(parseDBML(two).groups, [], "sin áreas");
});

test("anotaciones del bloque", () => {
  const src = "Table a {\n id int\n}\n// @pos a 10 20\n// @edge a id b id 1 2 3 4\n// @view 5 6 1.250\n// @size 800 600\n// @group ventas collapsed\n// @group otra expanded";
  assert.deepEqual(parsePositions(src), { a: { x: 10, y: 20 } });
  assert.deepEqual(parseView(src), { x: 5, y: 6, k: 1.25 });
  assert.deepEqual(parseSize(src), { w: 800, h: 600 });
  assert.deepEqual(parseEdges(src), { "a.id->b.id": [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  assert.deepEqual([...parseGroupState(src)], ["ventas"]);
});
