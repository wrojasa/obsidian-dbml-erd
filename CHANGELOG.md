# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/).

## [0.1.17] - 2026-06-20

### Cambiado

- **Ruteo siempre ortogonal (90°)**: arrastrar un punto de quiebre ya no produce ángulos oblicuos. El punto se mueve libre en cualquier dirección, pero la línea se *ortogonaliza* al dibujarla: entre cada par de puntos que no estén alineados se inserta un codo (`(b.x, a.y)`, "horizontal primero"), de modo que cada quiebre que arrastrás queda como esquina real de 90° (entra en vertical, sale en horizontal). Los dos extremos (puertos de columna) no se modifican; solo se adapta la ruta intermedia. Se eliminan puntos colineales/duplicados para conservar las esquinas redondeadas. Reemplaza el imán suave de 0.1.16, que permitía ángulos arbitrarios.

## [0.1.16] - 2026-06-20

### Corregido

- **Parpadeo al re-renderizar (causa real)**: cada re-render del bloque recalculaba el layout ELK de forma asíncrona, mostrando el placeholder "Renderizando ERD…" un instante; ese hueco era el parpadeo visible. Ahora el layout se cachea por estructura DBML (ignorando las anotaciones `@pos`/`@view`/`@size`/`@edge`), de modo que los re-render provocados por guardar la disposición reutilizan el layout y se dibujan de forma síncrona, sin pausa.
- **Mover quiebres: imán ortogonal demasiado agresivo**: el ajuste en "L" forzaba *siempre* el punto arrastrado a un codo, impidiendo moverlo libre/horizontal/verticalmente y colapsándolo sobre un vecino (parecía que se "eliminaban"), además de dejar esquinas rectas. Ahora el punto se mueve libre y solo se engancha a un eje cuando queda cerca (umbral de ~7px de pantalla) de alinearse con un vecino, conservando las esquinas redondeadas.
- **Redimensionar el lienzo hacia abajo**: `@size` no se persistía cuando el navegador fijaba tamaños sub-pixel (p.ej. `400.5px`), así que la altura revertía al valor por defecto en cada re-render. Ahora se aceptan px fraccionarios y se redondean.

## [0.1.15] - 2026-06-19

### Corregido

- **Parpadeo y deselección continua**: `saveLayout` reescribía el bloque en cada llamada aunque el contenido no hubiera cambiado; cada escritura dispara un evento `modify` de Obsidian que re-renderiza el code block (nueva instancia → se pierde la arista seleccionada y sus handles, con parpadeo periódico). Ahora se lee el contenido actual y solo se persiste si el bloque realmente cambió (guarda idempotente), cortando el bucle de re-render.
- **No se podían crear quiebres con un clic**: los tiradores de inserción ("+" en medio de cada tramo) solo añadían un punto al *arrastrar* (umbral de 3px); un toque/clic sin movimiento no hacía nada. Ahora un clic sobre un tirador de inserción crea el quiebre en ese punto, además del arrastre que ya existía.
- **La selección de arista sobrevive al re-render**: la arista con handles visibles se recuerda por bloque (`sourcePath#línea`) y se restaura al re-montar el diagrama, de modo que guardar el layout (o añadir varios nodos seguidos) ya no oculta los handles.

## [0.1.14] - 2026-06-19

### Corregido

- **Los quiebres ahora se mueven con las tablas**: antes, al crear un punto de quiebre en una conexión, esos puntos quedaban fijos en coordenadas absolutas; al mover una tabla solo se reanclaban los extremos y la ruta se veía rota/congelada. Ahora los waypoints intermedios se guardan respecto a un *frame base* (las anclas de los dos extremos cuando se autorizó la ruta) y se estiran afín-mente (interpolación independiente en X e Y) cuando se mueve cualquiera de las dos tablas, deformando toda la conexión de forma natural. Al empezar a arrastrar un tirador la ruta se "rebakea" al frame actual para que el arrastre y el imán ortogonal trabajen en las mismas coordenadas que se ven. Las rutas `@edge` se serializan ya mapeadas al frame actual, así coinciden con `@pos` y al recargar el mapeo arranca en identidad.

## [0.1.13] - 2026-06-19

### Cambiado

- **Imán ortogonal al arrastrar tiradores**: al mover un punto de quiebre de una conexión, ahora se ajusta automáticamente al codo en "L" más cercano respecto a sus vecinos (uno de los ejes hereda la X del punto previo y el otro la Y del siguiente, o viceversa, según cuál quede más cerca). Mantiene los tramos perpendiculares estilo dbdiagram.io sin tener que alinear a mano. Los extremos se reanclan a los puertos de columna actuales con la misma lógica que el ruteo guardado.

## [0.1.12] - 2026-06-19

### Agregado

- **Conexiones editables a mano**: tocá una relación para seleccionarla; aparecen tiradores (handles) en cada quiebre y en el medio de cada tramo. Arrastrá un tirador para doblar la curva o usá el del medio de un tramo para insertar un nuevo punto. La ruta se guarda como comentario `// @edge` dentro del bloque (junto a `@pos`/`@view`/`@size`) y se restaura al reabrir la nota. Tocando otra vez una relación seleccionada se abre un menú con "Restablecer ruta" (volver a automático) y "Deseleccionar".

### Cambiado

- **Evasión de colisiones al mover tablas**: el ruteo manual (`manhattan`) ahora elige el canal vertical más cercano que no atraviese *otras* tablas, no solo las dos conectadas. Antes una conexión podía cruzar por encima de tablas intermedias tras mover una tabla.
- Las rutas `@edge` se actualizan al renombrar tablas o columnas, y se descartan si la relación deja de existir en el DBML.

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
