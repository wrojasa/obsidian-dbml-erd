# Edición visual de tablas y áreas — diseño

Fecha: 2026-11-10. Estado: aprobado e implementado en 0.3.0; falta la prueba manual en Obsidian.
Versión objetivo: 0.3.0. Parte de 0.2.0 (áreas: ver, colapsar, arrastrar).

## Objetivo

Crear tablas y áreas, editar áreas y cambiar la pertenencia de las tablas desde
el diagrama, escribiendo cada cambio en el bloque dbml, que sigue siendo la
fuente de verdad.

## Alcance

Incluido:

- Crear una tabla desde la barra de herramientas o desde el menú de un área.
- Menú del área: renombrar, elegir o quitar color, nueva tabla en el área, quitar el área.
- Menú de la tabla: mover a un área existente, a una nueva o sacarla de su área.
- Fijar las posiciones actuales en cada cambio estructural, para que nada se reacomode.

Fuera de alcance:

- Agregar, borrar o cambiar columnas más allá de lo que ya existe (renombrar y cambiar tipo).
- Crear relaciones desde el canvas.
- Cambiar la pertenencia arrastrando una tabla: arrastrar nunca cambia el área.
- Borrar las tablas de un área al quitarla: quitar un área conserva sus tablas.
- La interfaz `Host` para el port a VS Code. Este diseño la facilita, porque toda escritura vive en funciones puras, pero no la implementa.

## 1. Interacción en el canvas

### Crear tabla

- Botón nuevo en la barra de herramientas, con el ícono `table` de Obsidian (`setIcon`), distinto del `+` de zoom. Título: "New table" / "Nueva tabla".
- Pide el nombre en el modal de texto existente.
- Crea `Table <nombre> {` con `id integer [pk, not null]`, ubicada en el centro de la vista actual.

### Menú del área

Se abre con un clic sin arrastre en la barra de un área expandida, fuera del
triángulo, o en cualquier parte del recuadro de un área colapsada, salvo el
triángulo. Opciones, en este orden:

1. Renombrar área…
2. Elegir color… (selector de color existente)
3. Quitar color (solo si el área tiene color)
4. Nueva tabla en esta área…
5. Separador.
6. Quitar área…, con confirmación: "Las tablas se conservan".

El arrastre y el triángulo funcionan igual que en 0.2.0. Un toque sin arrastre
fuera del triángulo, que hoy no hace nada, pasa a abrir el menú.

### Menú de la tabla

Al menú actual del encabezado se agregan, antes del separador de borrar:

- **Mover a área…**: abre una lista con buscador (`FuzzySuggestModal`, disponible desde Obsidian 0.9.20) con las áreas, salvo la actual, y al final "Nueva área…".
- **Sacar de «área»**: solo si la tabla pertenece a un área.

"Nueva área…" pide el nombre y crea el área con esa tabla y el primer color de
la paleta que no use otra área. Paleta: `#20479e`, `#2e7d32`, `#c62828`,
`#6a1b9a`, `#ef6c00`, `#00838f`. Si todos están en uso, se repite el primero.

### Ubicación de la tabla afectada

- **Creada desde la barra**: centro de la vista.
- **Creada desde un área**: `x` = borde izquierdo del recuadro del área más su margen lateral (16 px); `y` = borde inferior de la tabla más baja del área más 40 px.
- **Movida a un área**: misma regla, con las tablas del área destino antes de agregarla.
- **Sacada de su área**: `x` = borde derecho del recuadro actual del área, todavía con la tabla, más 40 px; `y` = borde superior de ese recuadro.
- **Área destino colapsada**: la tabla se ubica igual y queda oculta dentro del área, que sigue colapsada.
- **Área nueva desde una tabla**: la tabla no se mueve; el área la envuelve.
- No hay detección de choques: si la tabla queda encima de otra, el usuario la arrastra.

### Posiciones fijadas

Crear una tabla, crear o quitar un área y mover una tabla de área cambian la
estructura del grafo. Hoy eso hace que ELK reacomode todas las tablas que no
tienen `@pos`. Para que nada salte, la escritura de esas acciones guarda
también la posición actual de todas las tablas como `// @pos`, más la de la
tabla creada o movida.

Consecuencia aceptada: con todas las tablas fijadas, las líneas usan el
ruteador del plugin, el mismo que se usa al mover tablas a mano, en vez de la
ruta de ELK. El trazado cambia un poco la primera vez.

Renombrar un área o cambiar su color no cambian la estructura y no fijan
posiciones.

### Validación y avisos

- Nombres de tabla y de área: `[A-Za-z0-9_]+`.
- Una tabla nueva no puede repetir el nombre de otra tabla. Un área no puede repetir el nombre de otra área. Un área sí puede llamarse igual que una tabla, como en dbdiagram.io.
- Si la escritura no se puede hacer, un aviso explica por qué y el bloque no cambia.

## 2. Escritura en el bloque

### Módulo `src/edits.ts`

Sin DOM ni Obsidian, portable al port a VS Code. Cada función recibe
`(lines, start, end, …)`, modifica `lines` y devuelve `true` si pudo, igual que
las funciones de edición de `parser.ts`. `start` y `end` delimitan el bloque,
incluidas las cercas.

| Función | Efecto |
| --- | --- |
| `addTableInBlock(nombre)` | Inserta `Table <nombre> {`, `  id integer [pk, not null]`, `}` después del cierre de la última tabla, precedida de una línea vacía. Falla si el nombre es inválido o ya existe. |
| `addGroupInBlock(nombre, tablas, color?)` | Saca esas tablas de sus áreas actuales y luego inserta `TableGroup <nombre> [color: #rrggbb] {`, una línea por tabla y `}`, después de la última área o, si no hay áreas, después de la última tabla. Falla si el nombre es inválido o ya existe. |
| `renameGroupInBlock(viejo, nuevo)` | Cambia el nombre en el encabezado del área y en su línea `// @group`. Falla si el nuevo es inválido o ya existe. |
| `setGroupColorInBlock(nombre, color \| null)` | Pone, cambia o quita `color:` en los settings del encabezado, conservando los demás. |
| `removeGroupInBlock(nombre)` | Borra el bloque del área y su línea `// @group`. Las tablas quedan. |
| `moveTableToGroupInBlock(tabla, área \| null)` | Quita la línea de miembro de su área actual y, si hay destino, la agrega después del último miembro del destino. |
| `setPositionsInBlock(posiciones)` | Para cada tabla indicada, reemplaza o agrega su línea `// @pos <tabla> <x> <y>`, con coordenadas redondeadas. No toca otras anotaciones. |

Regla común: si una acción deja un área sin tablas, el área se elimina junto
con su línea `@group`, porque no se dibuja ni se alcanza desde el canvas. Esto
aplica también a `deleteTableInBlock`; en 0.2.0 el área vaciada quedaba en el
texto.

### Utilidades del parser

`parser.ts` exporta, sin cambiar su comportamiento, tres funciones que hoy son
internas: el escape de nombres para expresiones regulares, la búsqueda del
rango de una tabla y el escaneo de bloques que no son tablas.

### Escritura desde `main.ts`

- Cada acción hace una sola escritura atómica con `vault.process`: la función de `edits.ts`, las posiciones fijadas si corresponde y la posición de la tabla creada o movida.
- Tras la escritura, Obsidian redibuja el bloque. La clave del caché de layout cambia y ELK recalcula, pero todas las tablas tienen `@pos` y no se mueven.
- El color del área reutiliza el selector de color de las tablas.

## 3. Pruebas, documentación y versión

### Pruebas automáticas

- `test/edits.test.cjs` cubre cada función de `edits.ts`:
  - Posición de inserción respecto de tablas, áreas, `Ref:` y anotaciones.
  - Validación de nombres inválidos y repetidos.
  - Renombrar y quitar un área con su línea `@group`.
  - Mover una tabla entre áreas, a un área nueva y fuera de su área.
  - Eliminación del área vaciada.
  - `setPositions` toca solo las líneas `@pos`.
  - Cada resultado se vuelve a leer con `parseDBML` para comprobar el modelo.
- `test/run.mjs` empaqueta también `src/edits.ts`.
- Caso nuevo en `edit.test.cjs`: borrar la última tabla de un área elimina el área.
- Las 26 pruebas existentes siguen pasando.

### Prueba de interfaz

En la carpeta temporal, con el banco jsdom de 0.2.0 y un vault simulado que
guarda lo escrito: crear tabla, mover a área, crear área, renombrar, colorear y
quitar área. Se verifica el texto escrito y que, al volver a dibujar con ese
texto, ninguna tabla cambie de posición.

### Prueba manual en Obsidian

1. Crear una tabla desde la barra y desde el menú de un área.
2. Mover una tabla a otra área, a un área nueva y sacarla.
3. Renombrar, colorear y quitar un área.
4. Comprobar que ninguna tabla salta tras cada cambio.
5. Revisar que un diagrama sin cambios se ve igual que en 0.2.0.

### Documentación y versión

- README: botón de nueva tabla, menú del área y opciones nuevas del menú de la tabla.
- CHANGELOG `[0.3.0]`, incluido el cambio de las áreas vaciadas.
- Versión 0.3.0 en `manifest.json`, `package.json` y `versions.json`, con `minAppVersion` 1.6.0.
- Textos de menús y avisos en inglés y español.

### Después de publicar

Actualizar `references/plugin-subset.md` en la skill: hoy dice que desde el
canvas no se crean tablas ni áreas.
