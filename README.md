# DBML ERD

Plugin de Obsidian que renderiza bloques de código ` ```dbml ` como diagramas entidad-relación interactivos, con **ruteo ortogonal estilo dbdiagram.io** (líneas en ángulo recto que esquivan tablas), notación crow's foot y tablas arrastrables.

/ Autor: **Wilmar Rojas Avendaño** · Licencia: MIT

## Características

- Render de bloques `dbml` / `DBML` a ERD en SVG.
- Layout automático con [elkjs](https://github.com/kieler/elkjs) (`elk.layered`) que minimiza cruces.
- **Ruteo híbrido**: al cargar, líneas ortogonales de ELK que esquivan tablas; al arrastrar una tabla, re-ruteo manhattan en vivo.
- Notación de cardinalidad de un símbolo por extremo (estilo dbdiagram): pata de gallo en el lado "muchos"; en el lado "uno", barra (`│`) si la FK es `not null` o círculo (`○`) si es nullable.
- Iconos PK / FK, badge `NN`.
- **Color de encabezado interactivo**: clic en el encabezado de una tabla → menú para elegir o quitar color; se guarda solo en el bloque DBML.

- Pan (arrastrar vacío), zoom (rueda), botón de ajustar, lienzo redimensionable.
- Tema integrado con las variables de Obsidian (claro/oscuro automático).

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
- Color de encabezado por tabla: `Table nombre [headercolor: #2E7D32] { ... }` (el texto se ajusta a blanco u oscuro automáticamente).
- Operadores de cardinalidad: `>` (muchos→uno), `<` (uno→muchos), `<>` (muchos↔muchos), `-` (uno↔uno).
- Directiva opcional `// height: N` (alto del lienzo en px).
- Comentarios `//`.

> Subset deliberado de DBML, suficiente para esquemas controlados. No incluye aún enums, table groups ni claves compuestas.

## Instalación manual

1. Descargá `main.js`, `manifest.json` y `styles.css` del último release.
2. Copiá los tres a `<vault>/.obsidian/plugins/dbml-erd/`.
3. Activá el plugin en Ajustes → Complementos de la comunidad.

## Desarrollo

```bash
npm install
npm run dev     # build con sourcemaps inline
npm run build   # build de producción minificado
```

## Release

Los releases se generan solos con GitHub Actions (`.github/workflows/release.yml`).
Para publicar una versión nueva: subí el `version` en `manifest.json` y `package.json`,
creá un tag con ese número exacto (sin prefijo `v`) y empujalo:

```bash
git tag 0.1.3
git push origin 0.1.3
```

El workflow compila y adjunta `main.js`, `manifest.json` y `styles.css` al release.

## Licencia

MIT © 2026 Wilmar Rojas Avendaño
