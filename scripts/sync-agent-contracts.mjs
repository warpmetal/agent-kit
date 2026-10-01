import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const source = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Pass the reviewed frontend repository path.");
const require = createRequire(import.meta.url);
const ts = require(resolve(source, "node_modules/typescript/lib/typescript.js"));
const output = new URL("../src/contracts/", import.meta.url);
await mkdir(output, { recursive: true });
const manifest = { description: "Reviewed owner boundary adapters; mechanical TypeScript transpilation only", sources: {} };
const digest = value => createHash("sha256").update(value).digest("hex");
for (const name of ["work", "work-handoff", "insights", "manager", "session-handoff"]) {
  const relative = `worker/account/${name}.ts`;
  const original = await readFile(resolve(source, relative), "utf8");
  manifest.sources[relative] = digest(original);
  let text = original.replaceAll('.ts"', '.js"');
  if (name === "manager") {
    text = text.replace(/import contract from [^\n]+;/,
      'import { readFileSync } from "node:fs";\nconst contract = JSON.parse(readFileSync(new URL("./agent-manager-control-v1.schema.json", import.meta.url), "utf8"));');
  }
  const compiled = ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  } }).outputText;
  await writeFile(new URL(`${name}.js`, output), `// Generated from ${relative}; SHA-256 ${digest(original)}.\n${compiled}`);
}
const http = await readFile(resolve(source, "worker/account/http.ts"), "utf8");
const plain = http.match(/export function isPlainObject\([^]*?\n\}/)?.[0];
if (!plain) throw new Error("Reviewed isPlainObject helper not found.");
manifest.sources["worker/account/http.ts#isPlainObject"] = digest(plain);
await writeFile(new URL("http.js", output), ts.transpileModule(plain, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
} }).outputText);
const relative = "backend/contracts/agent-manager-control-v1.schema.json";
const schema = await readFile(resolve(source, relative));
manifest.sources[relative] = digest(schema);
await writeFile(new URL("agent-manager-control-v1.schema.json", output), schema);
await writeFile(new URL("sources.json", output), `${JSON.stringify(manifest, null, 2)}\n`);
