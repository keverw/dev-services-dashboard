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
  const frontendDir = path.join(__dirname, "..", "src", "frontend-build");
  const outputFile = path.join(
    __dirname,
    "..",
    "src",
    "backend",
    "frontend-vfs.ts",
  );

  // Check if frontend-build directory exists
  if (!fs.existsSync(frontendDir)) {
    console.error(`Frontend build directory not found: ${frontendDir}`);
    console.error(
      "Please run 'bun run build-frontend' first to build the React frontend.",
    );
    process.exit(1);
  }

  // Read all files in the frontend-build directory recursively
  const vfsEntries: string[] = [];

  function readDirRecursive(dir: string, basePath: string = "") {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      const relativePath = basePath ? path.join(basePath, file) : file;

      if (stats.isDirectory()) {
        readDirRecursive(filePath, relativePath);
      } else if (stats.isFile()) {
        const content = fs.readFileSync(filePath);
        const base64Content = content.toString("base64");
        // Use forward slashes for web paths
        const webPath = relativePath.replace(/\\/g, "/");
        vfsEntries.push(
          `  "${webPath}": Buffer.from("${base64Content}", "base64")`,
        );
      }
    }
  }

  readDirRecursive(frontendDir);

  const vfsContent = `export default {\n${vfsEntries.join(",\n")}\n};\n`;

  fs.writeFileSync(outputFile, vfsContent);
  console.log(`Generated VFS file: ${outputFile}`);
  console.log(`Included ${vfsEntries.length} files from React build`);
}

createVFS().catch(console.error);
