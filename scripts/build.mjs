import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.resolve(projectDir, "../avatarcropper-pages");
const stagingDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "avatarcropper-build-"),
);

try {
  // Finish building before updating the deployment worktree.
  for (const file of ["index.html", "app.js", "engine.js"]) {
    await fs.copyFile(
      path.join(projectDir, file),
      path.join(stagingDir, file),
    );
  }

  await fs.cp(path.join(projectDir, "public"), stagingDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git",
  });

  execFileSync(
    process.execPath,
    [
      path.join(projectDir, "node_modules/@tailwindcss/cli/dist/index.mjs"),
      "-i",
      path.join(projectDir, "styles.css"),
      "-o",
      path.join(stagingDir, "styles.css"),
    ],
    { cwd: projectDir, stdio: "inherit" },
  );

  await build({
    absWorkingDir: projectDir,
    entryPoints: ["vendor-entry.js"],
    outfile: path.join(stagingDir, "vendor.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: false,
    legalComments: "inline",
  });

  await fs.mkdir(outputDir, { recursive: true });
  await fs.cp(stagingDir, outputDir, { recursive: true });

  console.log(`Built ${outputDir}`);
} finally {
  await fs.rm(stagingDir, { recursive: true, force: true });
}
