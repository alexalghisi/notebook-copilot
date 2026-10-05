import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".woff2": "font/woff2",
};

/** Serves the built web app; unknown paths fall back to index.html for client-side routing. */
export function staticHandler(root: string) {
    const base = normalize(root + sep);
    return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        if (req.method !== "GET" && req.method !== "HEAD") return false;
        const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
        let file = normalize(join(base, pathname));
        if (!file.startsWith(base)) return false;
        let info = await stat(file).catch(() => null);
        if (!info || info.isDirectory()) {
            file = join(base, "index.html");
            info = await stat(file).catch(() => null);
            if (!info) return false;
        }
        const immutable = pathname.startsWith("/assets/");
        res.writeHead(200, {
            "content-type": TYPES[extname(file)] ?? "application/octet-stream",
            "content-length": info.size,
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        });
        if (req.method === "HEAD") res.end();
        else createReadStream(file).pipe(res);
        return true;
    };
}
