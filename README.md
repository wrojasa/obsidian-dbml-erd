# DBML ER Diagrams

Plugin de Obsidian que renderiza bloques de código ` ```dbml ` como **diagramas entidad-relación interactivos**, con **ruteo ortogonal estilo dbdiagram.io** (líneas en ángulo recto), notación crow's foot (pata de gallo / barra) y edición directa sobre el lienzo.

- **ID del plugin:** `dbml-erd`
- **Nombre:** DBML ER Diagrams
- **Autor:** Wilmar Rojas Avendaño · **Licencia:** MIT
- **Versión mínima de Obsidian:** 1.6.0 · Funciona en escritorio y móvil.

---

## Qué hace

Escribís un bloque ` ```dbml ` con tus tablas y relaciones y el plugin lo dibuja como un ERD en SVG, con layout automático, marcadores de cardinalidad y edición interactiva. Todos los cambios que hacés desde el diagrama (renombrar, mover, color, cardinalidad, borrar…) se escriben de vuelta en el propio bloque dbml de la nota — el bloque es la única fuente de verdad.

### Render y layout

- Render de bloques `dbml` / `DBML` a ERD en SVG.
- Layout automático con [elkjs](https://github.com/kieler/elkjs) (`elk.layered`) que minimiza cruces.
- **Ruteo ortogonal (90°)** estilo dbdiagram.io, con esquinas redondeadas; las líneas se re-rutean en vivo al mover tablas.
- Caché de layout por estructura: guardar la disposición no recalcula el layout ni produce parpadeo.
- Tema integrado con las variables de Obsidian (claro/oscuro automático).

### Notación

- **Cardinalidad de un símbolo por extremo**: pata de gallo en el lado "muchos"; en el lado "uno", barra (`│`) si la FK es `not null`, o círculo (`○`) si es nullable.
- Iconos **PK** (🔑) y **FK** (🔗), badge **`NN`** para columnas `not null`.
- Color de encabezado por tabla (el texto se ajusta a blanco u oscuro según el fondo).

### Navegación del lienzo

- **Pan** (arrastrar el vacío), **zoom** (rueda del ratón), botones `+` / `−` / `⊡` (ajustar).
- Lienzo **redimensionable** (ancho y alto).
- La posición de las tablas, el zoom/desplazamiento y el tamaño del lienzo se **persisten dentro del bloque** y se restauran al reabrir la nota.

### Edición interactiva (desde el diagrama)

Todo se guarda de vuelta en el bloque dbml:

- **Encabezado de tabla** (clic en la cabecera del nodo) → menú:
  - Renombrar tabla… (actualiza también las referencias).
  - Elegir color… / Quitar color.
  - Eliminar tabla… (con diálogo de confirmación; borra la tabla y las relaciones que la referencian).
- **Fila de columna** (clic en una columna) → menú:
  - Renombrar columna… (actualiza las referencias `tabla.col`).
  - Cambiar tipo…
- **Conexión / relación** (clic en la línea):
  - Primer clic: la **selecciona** y muestra los vértices de la ruta.
  - Segundo clic: menú con el **tipo de relación (cardinalidad)** — Uno a muchos, Muchos a uno, Uno a uno, Muchos a muchos (marca la actual) —, "Restablecer ruta" (si fue editada a mano) y "Deseleccionar".
- **Vértices de la ruta** (con la conexión seleccionada):
  - Añadir: tocá/arrastrá el tirador `+` en medio de un tramo.
  - Mover: arrastrá un vértice (la línea se re-ortogonaliza sola a 90°).
  - Eliminar: **clic derecho** sobre un vértice → "Eliminar vértice"; si era el último, la ruta vuelve al modo automático.

---

## Uso

Insertá un bloque de código con lenguaje `dbml`:

````markdown
```dbml
// height: 600

Table contrato {
  id_contrato     int          [pk]
  nombre_contrato varchar(120) [not null]
  id_cliente      int          [not null]
  estado          varchar(20)
}

Table cliente {
  id_cliente int          [pk]
  nombre     varchar(100) [not null]
}

Ref: contrato.id_cliente > cliente.id_cliente
```
````

### Sintaxis soportada

- `Table nombre { ... }` (y forma corta `nombre { ... }`).
- Columnas: `nombre tipo [pk, not null, note: '...', ref: > otra.col]`.
- Relaciones: línea `Ref: a.col > b.col`, inline `ref: > b.col`, o forma directa `a.col <> b.col`.
- Operadores de cardinalidad: `>` (muchos→uno), `<` (uno→muchos), `<>` (muchos↔muchos), `-` (uno↔uno).
- Color de encabezado por tabla: `Table nombre [headercolor: #2E7D32] { ... }`.
- Note de tabla y de columna (`Note: '...'`, `note: '...'`).
- Directiva opcional `// height: N` (alto del lienzo en px).
- Comentarios `//`.

> Subset deliberado de DBML, suficiente para esquemas controlados. No incluye aún enums, table groups ni claves compuestas.

### Anotaciones de disposición (gestionadas por el plugin)

El plugin guarda el estado visual como comentarios dentro del bloque; no hace falta editarlos a mano:

- `// @pos <tabla> <x> <y>` — posición de una tabla movida.
- `// @view <x> <y> <zoom>` — desplazamiento y zoom.
- `// @size <w> <h>` — tamaño del lienzo.
- `// @edge <from> <fromCol> <to> <toCol> <x1> <y1> …` — vértices de una ruta editada a mano.

---

## Generar el DBML automáticamente (skill `sql-to-dbml`)

Para no escribir el DBML a mano existe una skill de Claude Code, **`sql-to-dbml`**, que convierte scripts SQL `CREATE TABLE` (ANSI genérico) — o tablas que vas definiendo en la conversación — en DBML compatible con este plugin (degrada a lo que el plugin dibuja, nunca emite sintaxis que no entienda).

- Repositorio: <https://github.com/wrojasa/skill-sql-to-dbml>
- Disparadores típicos: "convierte este CREATE TABLE a dbml", "genera el dbml de estas tablas", "arma el ERD en dbml", "agrega esta tabla al dbml", "actualiza el dbml con…".

Pegás el bloque resultante en una nota dentro de ` ```dbml ` y el plugin lo renderiza.

---

## Instalación

### Manual

1. Descargá `main.js`, `manifest.json` y `styles.css` del último release.
2. Copiá los tres a `<vault>/.obsidian/plugins/dbml-erd/`.
3. Activá el plugin en **Ajustes → Complementos de la comunidad**.

---

## Desarrollo

```bash
npm install
npm run dev     # build con sourcemaps inline
npm run build   # build de producción minificado
```

Estructura del código:

- `src/main.ts` — plugin, render del bloque y la clase `Diagram` (SVG, interacción, persistencia).
- `src/parser.ts` — parser DBML (subset) y mutadores del bloque (renombrar, tipos, cardinalidad, borrar).
- `src/layout.ts` — layout con elkjs y constantes de geometría.
- `styles.css` — estilos integrados con las variables de tema de Obsidian.

## Release

Los releases se generan con GitHub Actions (`.github/workflows/release.yml`).
Para publicar una versión nueva: subí el `version` en `manifest.json` y `package.json`,
agregá la entrada en `versions.json` y `CHANGELOG.md`, creá un tag con ese número
exacto (sin prefijo `v`) y empujalo:

```bash
# usá el número exacto del manifest, sin prefijo v
git tag 0.1.19
git push origin 0.1.19
```

El workflow compila y adjunta `main.js`, `manifest.json` y `styles.css` al release.

## Licencia

MIT © 2026 Wilmar Rojas Avendaño
