// Corre las pruebas: empaqueta los módulos sin DOM de src/ con esbuild (ya es
// dependencia de desarrollo) en test/.build/ y ejecuta los *.test.cjs con el
// runner integrado de Node. No agrega dependencias ni toca el build del plugin.
import { build } from "esbuild";
import { mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, ".build");
mkdirSync(out, { recursive: true });

for (const name of ["parser", "layout", "areas"]) {
  await build({
    entryPoints: [join(root, "src", `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(out, `${name}.cjs`),
    logLevel: "warning",
  });
}

const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.cjs"))
  .map((f) => join(here, f));
const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
