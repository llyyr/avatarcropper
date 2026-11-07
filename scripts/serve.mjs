import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve("../avatarcropper-pages");
const port = Number(process.env.PORT) || 3000;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".zip": "application/zip",
};
const server = http.createServer(async (request, response) => {
  try {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    const url = new URL(request.url, "http://localhost");
    const requested = decodeURIComponent(url.pathname);
    const file = path.resolve(
      root,
      "." + (requested.endsWith("/") ? requested + "index.html" : requested),
    );
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const data = await fs.readFile(file);
    response.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch (error) {
    response
      .writeHead(error.code === "ENOENT" ? 404 : 500)
      .end("File not found");
  }
});
server.listen(port, "0.0.0.0", () =>
  console.log(
    `Open http://localhost:${port}\nPress Ctrl+C to stop. After editing source files, restart npm run dev.`,
  ),
);
