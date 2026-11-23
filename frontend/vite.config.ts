import { defineConfig } from "vite";
export default defineConfig({
  server: {
    proxy: Object.fromEntries(
      ["/api", "/auth", "/ops"].map((path) => [path, "http://localhost:3000"]),
    ),
  },
});
