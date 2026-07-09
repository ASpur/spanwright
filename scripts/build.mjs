import { cp, mkdir, rm } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const outputDirectory = new URL("dist/", projectRoot);
const publicFiles = ["index.html", "app.js", "styles.css"];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await Promise.all(
  publicFiles.map((file) =>
    cp(new URL(file, projectRoot), new URL(file, outputDirectory)),
  ),
);
