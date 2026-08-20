import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number.parseInt(process.argv[portIndex + 1], 10) : 4876;
const dist = path.join(process.cwd(), "dist");

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid port: ${port}`);
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error('dist/ is missing; run "npm run build" first');

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
  let relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const file = path.resolve(dist, relative);
  if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) {
    response.writeHead(400).end("bad request");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes.get(path.extname(file)) || "application/octet-stream",
  });
  fs.createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving ${dist} at http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
