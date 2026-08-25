import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectRoot, "artifacts", "github-pages");
const result = await build({
  entryPoints: [path.join(projectRoot, "apps", "standalone", "src", "app.ts")],
  bundle: true,
  platform: "browser",
  target: ["chrome100", "edge100", "firefox100", "safari15"],
  format: "iife",
  minify: true,
  write: false,
  legalComments: "inline",
});

const shell = await fs.readFile(
  path.join(projectRoot, "apps", "standalone", "src", "shell.html"),
  "utf8",
);
const bundle = new TextDecoder().decode(result.outputFiles[0].contents);
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, "index.html"),
  shell.replace("/*__APP_BUNDLE__*/", () => bundle),
);
