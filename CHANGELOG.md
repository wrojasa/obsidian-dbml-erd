# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/).

## [0.1.11] - 2026-06-19

### Corregido

- **Menús de edición en móvil (Android)**: el menú emergente de "Renombrar tabla/columna" y "Elegir color" aparecía y se cerraba al instante en táctil. El `pointerup` que abría el menú seguía propagándose hasta `document`, donde el menú de Obsidian registra su listener de auto-cierre. Ahora se detiene la propagación (`stopPropagation`/`preventDefault`) y la apertura se difiere un tick, de modo que el menú permanece abierto.

## [0.1.10] - 2026-06-18

### Agregado

- **Persistencia del tamaño del lienzo**: al redimensionar el diagrama arrastrando su esquina (ahora `resize: both`, ancho y alto), el tamaño se guarda como comentario `// @size <ancho> <alto>` dentro del bloque, junto a `// @view` y `// @pos`. Al reabrir la nota el lienzo recupera el tamaño elegido. Solo se persisten dimensiones fijadas por el usuario (px en línea), de modo que cambiar el ancho del panel de Obsidian no altera lo guardado.

## [0.1.9] - 2026-06-17

### Agregado

- **Edición de textos desde el diagrama**: clic en el encabezado de una tabla → "Renombrar tabla…"; clic en una columna → "Renombrar columna…" o "Cambiar tipo…". Los cambios se escriben de vuelta en el bloque DBML. Al renombrar tablas o columnas, se actualizan también las referencias (`Ref:` e inline) para no romper las relaciones.
- **Persistencia de posiciones**: las tablas que mueves se guardan como comentarios `// @pos` dentro del bloque (y la vista como `// @view`), de modo que al cerrar y reabrir la nota quedan donde las dejaste. El guardado ocurre al soltar la tabla (con debounce) y la vista se restaura para evitar saltos al re-renderizar.

### Cambiado

- `minAppVersion` sube a `1.6.0`: la edición y el guardado usan `vault.process` (lectura-modificación-escritura atómica) en vez de `read`+`modify`.
- Listeners del arrastre migrados a *pointer capture* sobre el propio nodo; el resto usa `registerDomEvent`/`activeWindow` (sin fugas, compatible con ventanas emergentes).
- Colores de encabezado y alto del lienzo aplicados vía variables CSS (`--dbml-head-fill`, `--dbml-erd-height`) en vez de estilos en línea.

### Corregido

- El parser ya no se rompe con `//` ni llaves dentro de cadenas (`note: '...'`), bloques `indexes { }`, apóstrofos sueltos ni notas triple-comilla; el cuerpo de la tabla se delimita contando llaves.
- Referencias a tablas/columnas inexistentes se descartan en vez de tirar todo el diagrama; las relaciones duplicadas se deduplican.
- Renombrar una tabla ya no corrompe el texto de notas que contienen `nombre.`; los colores con nombre/`rgb()` calculan bien el color de texto legible.
- El color de encabezado se puede fijar aunque la `{` esté en la línea siguiente.

## [0.1.8] - 2026-06-17

### Corregido

- Los estilos estáticos del input de color (`position`, `left`) se movieron a la clase CSS `.dbml-color-input`, resolviendo el error `obsidianmd/no-static-styles-assignment` de la revisión de Obsidian.

## [0.1.7] - 2026-06-17

### Cambiado

- Limpieza para la revisión de Obsidian: tipos de ELK sin `any` (`ElkNode`/`ElkPort`/`ElkExtendedEdge`), `document`/`requestAnimationFrame` reemplazados por `activeDocument`/`activeWindow` (compatibilidad con ventanas emergentes), aserciones de tipo innecesarias removidas, nombre del plugin sin mayúsculas totales.
- Workflow de release con atestación de procedencia de artefactos (`attest-build-provenance`).

## [0.1.6] - 2026-06-17

### Agregado

- Paleta interactiva: clic en el encabezado de una tabla abre un menú para **elegir** o **quitar** color. El plugin escribe `[headercolor: #hex]` de vuelta en el bloque DBML (queda persistente y portable).

## [0.1.5] - 2026-06-17

### Agregado

- Color de encabezado por tabla con `[headercolor: #hex]` (compatible con dbdiagram). El color del texto del encabezado se ajusta solo (blanco u oscuro) según la luminancia.

## [0.1.4] - 2026-06-17

### Cambiado

- Eventos migrados a pointer events: el drag y el pan ahora funcionan también en móvil (táctil).
- Los listeners globales se registran con `registerDomEvent` y se limpian al cerrar/re-renderizar la nota (sin fugas de memoria).
- `touch-action: none` en el lienzo para que el arrastre táctil no haga scroll de la página.

## [0.1.3] - 2026-06-17

### Cambiado

- Notación de cardinalidad de un solo símbolo por extremo, igual a dbdiagram.io.
- El lado "uno" se deriva de la nullabilidad de la FK: barra (`│`) si es `not null`, círculo (`○`) si es nullable.
- El lado "muchos" dibuja solo la pata de gallo (el esquema no conoce el mínimo).

## [0.1.2] - 2026-06-17

### Agregado

- Lienzo redimensionable (manija) y directiva `// height: N` por diagrama.
- Variable CSS `--dbml-erd-height` para altura global.

### Cambiado

- Notación de relaciones a círculo + barra (0..1) en el lado "uno".

## [0.1.1] - 2026-06-17

### Corregido

- Las relaciones de tablas ya movidas dejaban de seguir sus extremos al arrastrar otra tabla. Ahora toda arista que toque una tabla movida se re-rutea con manhattan.

## [0.1.0] - 2026-06-17

### Agregado

- Render de bloques `dbml` / `DBML` a ERD en SVG.
- Layout automático con elkjs (`elk.layered`, ruteo ortogonal).
- Ruteo híbrido: ELK al cargar, manhattan al arrastrar.
- Tablas arrastrables, pan, zoom, ajustar.
- Iconos PK / FK, badge `NN`, tema integrado con variables de Obsidian.
