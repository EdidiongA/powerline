import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds src/ui/card.html into one self-contained HTML file (dist/ui/card.html)
// so the MCP server can serve it as a ui:// resource.
export default defineConfig({
  root: "src/ui",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
    rollupOptions: { input: "src/ui/card.html" },
  },
});
