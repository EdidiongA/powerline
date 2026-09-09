import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained HTML per MCP App view. vite-plugin-singlefile only supports a
// single entry per build, so the page is selected with UI_PAGE (see package.json).
const page = process.env.UI_PAGE ?? "card";

export default defineConfig({
  root: "src/ui",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: false,
    rollupOptions: { input: `src/ui/${page}.html` },
  },
});
