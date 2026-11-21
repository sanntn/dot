import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

// Serves a task's worktree as a static site, for the preview page. Two doors open on it: a loopback server
// that the screenshot browser visits, and the signed link behind the Open page button. Both go through
// resolveInside, so neither can reach a file outside the worktree.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export const contentTypeOf = (file: string) => TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

// The file a URL path names inside a folder, or null. Directories answer with their index.html. Anything that
// resolves outside the folder, symlinks included, is refused, and so are git's own files and .env files.
export function resolveInside(root: string, urlPath: string): string | null {
  try {
    const base = realpathSync(root);
    const path = decodeURIComponent(urlPath);
    let file = resolve(base, `.${path.startsWith("/") ? path : `/${path}`}`);
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    file = realpathSync(file);
    if (file !== base && !file.startsWith(base + sep)) return null;
    if (!statSync(file).isFile()) return null;
    const parts = relative(base, file).split(sep);
    if (parts.includes(".git") || parts.some((p) => p.startsWith(".env"))) return null;
    return file;
  } catch {
    return null;
  }
}

// One "bytes=a-b" range. Null means send the whole file: no header, or a form this does not handle.
// "invalid" means the range lies outside the file.
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    // The last N bytes.
    const last = Number(match[2]);
    if (last === 0) return "invalid";
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start >= size || start > end ? "invalid" : { start, end };
}

// A file as a streamed response, with Range support so audio and video can seek.
export function fileResponse(file: string, method: string, rangeHeader: string | null | undefined, extra: Record<string, string> = {}): Response {
  const size = statSync(file).size;
  const range = parseRange(rangeHeader, size);
  const headers: Record<string, string> = { "Content-Type": contentTypeOf(file), "Accept-Ranges": "bytes", ...extra };
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  headers["Content-Length"] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (method === "HEAD" || size === 0) return new Response(null, { status, headers });
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream, { status, headers });
}

// Serves a folder over HTTP on a free loopback port, under `prefix`. Only paths below the prefix answer, so a
// page that links its assets with an absolute path fails here as it does behind the Open page link.
export function serveFolder(root: string, prefix = "/"): Promise<{ url: URL; close: () => void }> {
  const server = createServer((req, res) => {
    const deny = () => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    };
    if (req.method !== "GET" && req.method !== "HEAD") return deny();
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!pathname.startsWith(prefix)) return deny();
    const file = resolveInside(root, `/${pathname.slice(prefix.length)}`);
    if (!file) return deny();
    res.writeHead(200, { "content-type": contentTypeOf(file), "cache-control": "no-store" });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("The preview server has no port"));
      resolveServer({
        url: new URL(prefix, `http://127.0.0.1:${address.port}`),
        // The browser keeps its connections open, which would hold the server up after the picture.
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
