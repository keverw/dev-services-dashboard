import { IncomingMessage, ServerResponse } from "http";
import { createHash } from "crypto";
import * as mime from "mime-types";

interface VFSContent {
  [path: string]: Buffer;
}

interface VFSMiddlewareOptions {
  excludedPaths?: string[];
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

function generateETag(content: Buffer): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `"${hash.slice(0, 16)}"`; // Use first 16 chars of hash for a shorter ETag
}

function getMimeType(path: string): string {
  const mimeType = mime.lookup(path);

  // For HTML files, ensure we include charset
  if (mimeType === "text/html") {
    return "text/html; charset=utf-8";
  }

  return mimeType || "application/octet-stream";
}

/**
 * Creates middleware to serve files from a virtual file system (VFS).
 *
 * Features:
 * - Serves static files from an in-memory VFS
 * - Supports GET and HEAD requests
 * - Handles ETags for caching
 * - Automatically detects content types
 * - Allows excluding specific paths
 *
 * @param vfs - Virtual file system mapping paths to content
 * @param options - Configuration options
 * @param options.excludedPaths - Paths to exclude from VFS serving
 * @returns Middleware function that returns true if request was handled, false otherwise
 */
export function createVFSMiddleware(
  vfs: VFSContent,
  options: VFSMiddlewareOptions = {},
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const normalizedExcludedPaths =
    options.excludedPaths?.map(normalizePath) || [];

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    let path = normalizePath(url.pathname);

    // Skip if not a GET or HEAD request
    if (req.method !== "GET" && req.method !== "HEAD") {
      return false;
    }

    // Skip if path is in excluded paths
    if (normalizedExcludedPaths.includes(path)) {
      return false;
    }

    // Map root path to dev-ui.html
    if (path === "" || path === "/") {
      path = "dev-ui.html";
    }

    // Try to find the file in VFS
    const content = vfs[path];

    if (!content) {
      return false;
    }

    // Determine content type
    const contentType = getMimeType(path);

    // Generate ETag - needed for both GET and HEAD
    const etag = generateETag(content);

    // Check if client has a fresh copy
    const ifNoneMatch = req.headers["if-none-match"];

    if (ifNoneMatch === etag) {
      res.writeHead(304, {
        ETag: etag,
        "Cache-Control": "public, max-age=0, must-revalidate",
      });
      res.end();
      return true;
    }

    // Set response headers
    const headers: { [key: string]: string } = {
      "Content-Type": contentType,
      "Content-Length": content.length.toString(),
      ETag: etag,
      "Cache-Control": "public, max-age=0, must-revalidate",
    };

    res.writeHead(200, headers);

    // For HEAD requests, don't send the body
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(content);
    }

    return true;
  };
}
