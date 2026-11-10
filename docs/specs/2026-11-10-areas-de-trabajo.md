# Áreas de trabajo (TableGroup) — diseño

Fecha: 2026-11-10. Estado: aprobado e implementado en 0.2.0; falta la prueba manual en Obsidian.

## Objetivo

Dibujar los `TableGroup` de DBML como áreas: un recuadro con encabezado de
color y fondo tenue que envuelve a sus tablas, se puede arrastrar y se puede
colapsar. La referencia visual es el plugin CarterMcAlister/obsidian-dbml, sin
reutilizar su código.

## Alcance

Incluido:

- Leer `TableGroup` con nombre, color, miembros y nota.
- Ubicar juntas las tablas de cada área con ELK.
- Dibujar áreas expandidas y colapsadas.
- Arrastrar un área para mover todas sus tablas.
- Colapsar y expandir, con el estado guardado en el bloque.
- Mantener correctas las ediciones existentes del canvas cuando hay áreas.

Fuera de alcance en esta versión:

- Crear, renombrar, recolorear o borrar áreas desde el canvas.
- Meter o sacar tablas de un área arrastrándolas.
- Mostrar la nota del área.
- Áreas anidadas, que DBML no admite.

## 1. Sintaxis y modelo de datos

Sintaxis estándar de DBML, compatible con dbdiagram.io:

```dbml
TableGroup ventas [color: #2e7d32] {
  cliente
  pedido
  Note: 'opcional, se lee pero no se dibuja'
}
```

Reglas:

- El nombre cumple `[A-Za-z0-9_]+`, con comillas dobles opcionales. La palabra `TableGroup` no distingue mayúsculas.
- El color sale de `color: #rgb` o `color: #rrggbb`. Sin color, el área usa un tono neutro del tema.
- Cada línea del cuerpo con un nombre de tabla es un miembro. Se ignoran en silencio los nombres que no existen, las líneas `Note:` y las líneas vacías.
- Una tabla listada en dos áreas pertenece a la primera.
- `Group.tables` contiene solo miembros válidos, sin duplicados, en el orden del texto.
- Un área sin miembros válidos no se dibuja ni entra a ELK.
- `TableGroup {` sin nombre sigue ignorado, como en 0.1.22.
- El cuerpo de un área nunca se lee como relaciones.

Modelo:

```ts
interface Group { name: string; color?: string; tables: string[] }
interface Model { tables: Table[]; refs: Ref[]; groups: Group[] }
```

Estado en el bloque:

- `// @group <nombre> collapsed` marca un área colapsada. Si la línea no existe, el área está expandida.
- La posición del área no se guarda: siempre se deriva de las posiciones de sus tablas.

## 2. Layout

- Sin áreas con miembros válidos, el grafo que recibe ELK es idéntico al de 0.1.22. Los diagramas existentes no cambian.
- Con áreas, cada área es un nodo contenedor con id `group:<nombre>`. Los `:` no son válidos en nombres de tabla, así que no hay colisión. Sus miembros son hijos del contenedor.
- Margen interno del contenedor: 44 px arriba, para el encabezado, y 16 px a los lados y abajo.
- La raíz usa `elk.hierarchyHandling: INCLUDE_CHILDREN`. Las relaciones se siguen definiendo en la raíz con los mismos puertos de columna.
- Las posiciones de los hijos se convierten a absolutas sumando la posición del contenedor. Las secciones de cada arista son relativas a `edge.container` y también se convierten a absolutas.
- `LayoutResult` no cambia de forma: nodos y aristas en coordenadas absolutas.
- La clave del caché de layout ignora también las líneas `// @group`. Colapsar o expandir nunca vuelve a correr ELK.

Prueba previa con ELK, con puertos fijos y relaciones entre áreas: 1 px de error entre puerto y arista, igual que el layout plano, y sin solapes entre áreas. Tiempos de la primera corrida:

| Tamaño | Plano | Con áreas |
| --- | --- | --- |
| 20 tablas, 3 áreas | 44 ms | 49 ms |
| 60 tablas, 6 áreas | 44 ms | 96 ms |
| 120 tablas, 10 áreas | 85 ms | 218 ms |

## 3. Dibujo

Capas, de abajo hacia arriba: áreas, relaciones, tablas.

Área expandida:

- Recuadro igual al rectángulo que envuelve a sus miembros, más el mismo margen que usa ELK. Se recalcula en cada redibujo, así que crece o se achica al arrastrar una tabla.
- Fondo con el color del área a baja opacidad, borde fino del mismo color y esquinas redondeadas.
- Barra de encabezado de 28 px con el color del área, el triángulo ▾ y el nombre. El texto usa el ajuste de contraste que ya tienen las tablas.

Área colapsada:

- Recuadro compacto en la esquina superior izquierda del área expandida: barra con ▸ y el nombre, más una línea con "N tables" o "N tablas".
- Ancho mínimo de 160 px, o el que pida el nombre medido con la misma fuente que los encabezados de tabla.
- Sus tablas no se dibujan.

Relaciones cuando hay áreas colapsadas:

- Extremo en un miembro de un área colapsada: el extremo pasa al recuadro de esa área, al costado izquierdo o derecho y a media altura. Se dibuja con el ruteador ortogonal existente.
- Varias relaciones con el mismo extremo externo, tabla y columna, hacia la misma área colapsada se dibujan como una sola.
- Las relaciones con ambos extremos en la misma área colapsada no se dibujan.
- Entre dos áreas colapsadas, la línea va de recuadro a recuadro, una sola por par.
- Cada extremo conserva su marca de cardinalidad solo si todas las relaciones unificadas coinciden en ese extremo; si no, ese extremo va sin marca. Con una sola relación, los dos extremos conservan su marca.
- Las rutas manuales (`@edge`) de relaciones que tocan un área colapsada se ignoran mientras dure el colapso, pero no se borran.
- Esas relaciones no se pueden seleccionar ni editar mientras el área está colapsada.

Ajustar a la vista incluye las áreas en el encuadre.

## 4. Interacciones

- **Arrastrar por la barra de encabezado** del área expandida, o por cualquier parte del recuadro colapsado, mueve todos los miembros con el mismo desplazamiento. Al soltar, los miembros quedan marcados como movidos y se guardan sus `@pos` con el guardado diferido existente.
- **Fondo del área**: arrastrar ahí desplaza el lienzo, igual que el espacio vacío.
- **▾ / ▸**: alterna el colapso, redibuja al instante y guarda la línea `@group`.
- **Arrastrar una tabla** funciona como hoy. La pertenencia no cambia aunque la tabla salga del recuadro.
- **Clic en la barra** fuera del triángulo no abre menú en esta versión.

## 5. Edición del bloque

- `findTableRange` ignora las líneas dentro de cuerpos `TableGroup`, `enum`, `Note`, `Project` y `Ref`. Sin esto, una línea de miembro como `  pedido` dentro de un área declarada antes de la tabla parecería una declaración abreviada, y renombrar, borrar, cambiar tipo o cambiar cardinalidad atacarían esa línea.
- `renameTableInBlock` renombra también la línea de miembro en los cuerpos `TableGroup`.
- `deleteTableInBlock` quita también la línea de miembro. Si el área queda vacía, se conserva y no se dibuja.
- `setHeaderColorInLine` ya ignora líneas sin `Table` ni `{`, así que las líneas de miembro están protegidas.
- `buildLayoutContent` agrega `@group` a las anotaciones que filtra y reescribe al final del bloque. Escribe una línea por cada área colapsada que exista en el modelo, así que las líneas de áreas renombradas en el texto se descartan solas.

## 6. Organización del código

- `src/parser.ts`: lectura de `TableGroup`, `parseGroupState` para las líneas `@group`, y los cambios de la sección 5.
- `src/layout.ts`: grafo con contenedores y conversión a coordenadas absolutas.
- `src/areas.ts`, módulo nuevo y sin DOM:
  - `areaBox`: recuadro expandido a partir de los rectángulos de los miembros.
  - `collapsedBox`: recuadro colapsado.
  - `visibleEdges`: a partir de las relaciones, las áreas colapsadas y la pertenencia, devuelve las aristas a dibujar con sus extremos, sea tabla o área, ya unificadas, y la marca de cada extremo.
- `src/main.ts`: capa de áreas, arrastre por encabezado, triángulo de colapso, dibujo de aristas desde `visibleEdges`, ajuste del encuadre y guardado de `@group`.
- `src/i18n.ts`: `nTables` y `collapseArea` / `expandArea` en inglés y español.

## 7. Rendimiento

- Nada nuevo se carga al iniciar Obsidian. ELK sigue cargándose al primer diagrama.
- Una corrida de ELK por estructura, cacheada. Colapsar, expandir y arrastrar no corren ELK.
- Al arrastrar un área se reubican solo sus miembros y las aristas que los tocan.
- Medición antes y después con 120 tablas y 10 áreas: primera corrida y redibujo completo.

## 8. Pruebas

Pruebas automáticas en `test/`, con `node:test` y sin dependencias nuevas. Un script `npm test` empaqueta `src/parser.ts`, `src/layout.ts` y `src/areas.ts` con esbuild en `test/.build/`, que va en `.gitignore`, y corre las pruebas. El workflow de publicación no cambia.

Cobertura:

- **Parser de áreas**: nombre, color, miembros, inexistentes, duplicados, notas, `TableGroup {` sin nombre, `@group`.
- **Regresión del parser**: los casos de 0.1.22.
- **Layout**: sin áreas, salida idéntica a la de 0.1.22. Con áreas, miembros dentro de su contenedor, sin solapes en la raíz y aristas con origen en su puerto.
- **`areas.ts`**: recuadros, unificación de aristas, ocultamiento de internas y marcas de extremo.
- **Edición del bloque**: renombrar, borrar, cambiar tipo y cardinalidad con áreas declaradas antes y después de sus tablas; reescritura de `@group`.

Prueba manual en Obsidian, con los pasos en la entrega:

1. Arrastrar un área y verificar que se mueven sus tablas.
2. Colapsar y expandir, y revisar las relaciones hacia el área colapsada.
3. Renombrar y borrar desde el canvas una tabla que pertenece a un área.
4. Reabrir la nota y verificar que el estado colapsado y las posiciones se conservan.
5. Revisar un diagrama sin áreas y confirmar que no cambió.

## 9. Documentación y versión

- README: sintaxis de `TableGroup`, anotación `@group`, y retirar "does not yet include … table groups".
- CHANGELOG: entrada de la versión 0.2.0.
- Versión 0.2.0 en `manifest.json`, `package.json` y `versions.json`, con `minAppVersion` 1.6.0.

## 10. Después de esta versión

- Skill sql-to-dbml: permitir `TableGroup`, por ejemplo agrupando por esquema o módulo cuando el usuario lo pida, y actualizar `plugin-subset.md`. Se hace después de publicar 0.2.0.
- Funciones inspiradas en dbml-studio, como proyectos aparte:
  - Segunda fase: niveles de detalle, búsqueda de tabla, reordenar automático, exportar SVG o PNG.
  - Tercera fase, opcional: ocultar relaciones por tabla, relaciones con el color de su tabla, animación al pasar el cursor, selección múltiple.
