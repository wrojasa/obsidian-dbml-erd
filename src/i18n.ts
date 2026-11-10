// Minimal i18n: a flat dictionary per language and a t() lookup with {var}
// interpolation. The active language is module state set by the plugin from its
// settings (default English); menus/modals read it when they open.

export type Lang = "en" | "es";

export const LANGS: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

type Dict = Record<string, string>;

const en: Dict = {
  // render states / errors
  parseError: "Parse error: {msg}",
  noTables: "DBML has no tables.",
  rendering: "Rendering ERD…",
  layoutError: "Layout error: {msg}",
  // edge menu
  resetRoute: "Reset route",
  relOneToMany: "One to many (1 → ∞)",
  relManyToOne: "Many to one (∞ → 1)",
  relOneToOne: "One to one (1 → 1)",
  relManyToMany: "Many to many (∞ ↔ ∞)",
  deselect: "Deselect",
  changeRelTypeFail: "Could not change the relationship type.",
  deleteVertex: "Delete vertex",
  // header menu
  renameTable: "Rename table…",
  renameTablePrompt: "New table name",
  pickColor: "Pick color…",
  removeColor: "Remove color",
  deleteTableMenu: "Delete table…",
  deleteTableTitle: "Delete table",
  deleteTableBody:
    'Delete table "{name}" from the diagram? Its definition and the relationships that reference it will be removed.',
  deleteBtn: "Delete",
  // column menu
  renameColumn: "Rename column…",
  renameColumnPrompt: "New column name",
  changeType: "Change type…",
  changeTypePrompt: "New data type",
  // notices / failures
  locateBlockFail: "DBML ERD: could not locate the block to edit.",
  renameTableFail:
    'Could not rename "{name}" (valid name? letters, numbers and _ only).',
  deleteTableFail: 'Could not delete table "{name}".',
  renameColumnFail: "Could not rename the column.",
  changeTypeFail:
    "Could not change the type (use letters, numbers, _ and parentheses).",
  tableNotFound: 'DBML ERD: table "{name}" was not found.',
  // modals
  cancel: "Cancel",
  save: "Save",
  // areas (TableGroup)
  collapseArea: "Collapse area",
  expandArea: "Expand area",
  areaOneTable: "1 table",
  areaTables: "{n} tables",
  // visual editing (tables and areas)
  newTable: "New table",
  newTablePrompt: "New table name",
  newTableInArea: "New table in this area…",
  renameArea: "Rename area…",
  renameAreaPrompt: "New area name",
  removeAreaMenu: "Remove area…",
  removeAreaTitle: "Remove area",
  removeAreaBody: 'Remove area "{name}"? Its tables are kept.',
  removeBtn: "Remove",
  moveToArea: "Move to area…",
  moveToAreaPlaceholder: "Choose an area",
  newArea: "New area…",
  newAreaPrompt: "New area name",
  leaveArea: 'Remove from "{name}"',
  invalidName: "Use only letters, numbers and _.",
  tableExists: 'A table named "{name}" already exists.',
  areaExists: 'An area named "{name}" already exists.',
  editBlockFail: "DBML ERD: could not update the block.",
  // settings
  settingsLanguage: "Language",
  settingsLanguageDesc: "Interface language for menus, dialogs and notices.",
};

const es: Dict = {
  parseError: "Error de parseo: {msg}",
  noTables: "DBML sin tablas.",
  rendering: "Renderizando ERD…",
  layoutError: "Error de layout: {msg}",
  resetRoute: "Restablecer ruta",
  relOneToMany: "Uno a muchos (1 → ∞)",
  relManyToOne: "Muchos a uno (∞ → 1)",
  relOneToOne: "Uno a uno (1 → 1)",
  relManyToMany: "Muchos a muchos (∞ ↔ ∞)",
  deselect: "Deseleccionar",
  changeRelTypeFail: "No se pudo cambiar el tipo de relación.",
  deleteVertex: "Eliminar vértice",
  renameTable: "Renombrar tabla…",
  renameTablePrompt: "Nuevo nombre de la tabla",
  pickColor: "Elegir color…",
  removeColor: "Quitar color",
  deleteTableMenu: "Eliminar tabla…",
  deleteTableTitle: "Eliminar tabla",
  deleteTableBody:
    '¿Eliminar la tabla "{name}" del diagrama? Se borrará su definición y las relaciones que la referencian.',
  deleteBtn: "Eliminar",
  renameColumn: "Renombrar columna…",
  renameColumnPrompt: "Nuevo nombre de la columna",
  changeType: "Cambiar tipo…",
  changeTypePrompt: "Nuevo tipo de dato",
  locateBlockFail: "DBML ERD: no se pudo ubicar el bloque para editar.",
  renameTableFail:
    'No se pudo renombrar "{name}" (¿nombre válido? solo letras, números y _).',
  deleteTableFail: 'No se pudo eliminar la tabla "{name}".',
  renameColumnFail: "No se pudo renombrar la columna.",
  changeTypeFail:
    "No se pudo cambiar el tipo (use letras, números, _ y paréntesis).",
  tableNotFound: 'DBML ERD: no se encontró la tabla "{name}".',
  cancel: "Cancelar",
  save: "Guardar",
  collapseArea: "Colapsar área",
  expandArea: "Expandir área",
  areaOneTable: "1 tabla",
  areaTables: "{n} tablas",
  newTable: "Nueva tabla",
  newTablePrompt: "Nombre de la nueva tabla",
  newTableInArea: "Nueva tabla en esta área…",
  renameArea: "Renombrar área…",
  renameAreaPrompt: "Nuevo nombre del área",
  removeAreaMenu: "Quitar área…",
  removeAreaTitle: "Quitar área",
  removeAreaBody: '¿Quitar el área "{name}"? Sus tablas se conservan.',
  removeBtn: "Quitar",
  moveToArea: "Mover a área…",
  moveToAreaPlaceholder: "Elige un área",
  newArea: "Nueva área…",
  newAreaPrompt: "Nombre de la nueva área",
  leaveArea: 'Sacar de "{name}"',
  invalidName: "Use solo letras, números y _.",
  tableExists: 'Ya existe una tabla llamada "{name}".',
  areaExists: 'Ya existe un área llamada "{name}".',
  editBlockFail: "DBML ERD: no se pudo actualizar el bloque.",
  settingsLanguage: "Idioma",
  settingsLanguageDesc:
    "Idioma de la interfaz para menús, diálogos y avisos.",
};

const dicts: Record<Lang, Dict> = { en, es };

let current: Lang = "en";

export function setLang(l: Lang) {
  current = l === "es" ? "es" : "en";
}
export function getLang(): Lang {
  return current;
}

export function t(key: string, vars?: Record<string, string>): string {
  let s = dicts[current][key] ?? en[key] ?? key;
  if (vars)
    for (const [k, v] of Object.entries(vars))
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  return s;
}
