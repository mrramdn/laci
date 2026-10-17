import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    // Fonts stay separate files, so the CSS holds their names instead of their bytes. Any other
    // small asset keeps Vite's default limit.
    assetsInlineLimit: (file) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined,
  },
});
