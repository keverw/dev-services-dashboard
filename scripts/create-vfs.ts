import fs from "fs";
import path from "path";

/**
 * Custom VFS (Virtual File System) generator
 *
 * Inspired by the excellent make-vfs package (https://www.npmjs.com/package/make-vfs)
 * This simplified implementation was created to handle specific edge cases we encountered
 * with multi-line content escaping in HTML files when using the original package.
 *
 * Credit to the make-vfs authors for the concept and approach.
 */

async function createVFS(): Promise<void> {
  const frontendDir = path.join(__dirname, "..", "src", "frontend");
  const outputFile = path.join(
    __dirname,
    "..",
    "src",
    "backend",
    "frontend-vfs.ts",
  );

  // Read all files in the frontend directory
  const files = fs.readdirSync(frontendDir);
  const vfsEntries: string[] = [];

  for (const file of files) {
    const filePath = path.join(frontendDir, file);
    const stats = fs.statSync(filePath);

    if (stats.isFile()) {
      const content = fs.readFileSync(filePath);
      const base64Content = content.toString("base64");
      vfsEntries.push(`  "${file}": Buffer.from("${base64Content}", "base64")`);
    }
  }

  const vfsContent = `export default {\n${vfsEntries.join(",\n")}\n};\n`;

  fs.writeFileSync(outputFile, vfsContent);
  console.log(`Generated VFS file: ${outputFile}`);
}

createVFS().catch(console.error);
