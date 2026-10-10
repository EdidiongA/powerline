import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// One self-contained HTML per MCP App view. vite-plugin-singlefile only supports a
// single entry per build, so the page is selected with UI_PAGE (see package.json).
const page = process.env.UI_PAGE ?? "card";

export default defineConfig({
  root: "src/ui",
  define: { __POWERLINE_VERSION__: JSON.stringify(version) },
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: false,
    rollupOptions: { input: `src/ui/${page}.html` },
  },
});
