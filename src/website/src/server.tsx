import { renderToString } from "react-dom/server";
import { App } from "./App.tsx";

const port =
  Number(process.env.WEBSITE_PORT ?? process.env.PORT) || 3000;

const cssPath = new URL("../dist/tailwind.css", import.meta.url);

function htmlDocument(body: string, css: string) {
  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>compscibois</title>
    <style>${css}</style>
  </head>
  <body>${body}</body>
</html>`;
}

const server = Bun.serve({
  port,
  async fetch() {
    const cssFile = Bun.file(cssPath);
    if (!(await cssFile.exists())) {
      return new Response(
        "Missing dist/tailwind.css — run `bun run build:css` first.",
        { status: 500, headers: { "Content-Type": "text/plain" } },
      );
    }
    const css = await cssFile.text();
    const body = renderToString(<App />);
    return new Response(htmlDocument(body, css), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Listening on http://localhost:${server.port}`);
