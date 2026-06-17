# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/).

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
