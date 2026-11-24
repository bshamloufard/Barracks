import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * In development the page is served by Vite and talks to the control plane
 * through Vite's proxy, so it can use its own origin for every request just
 * as it does when the control plane serves the built page. The browser's
 * Origin header passes through unchanged, which the control plane checks.
 */
const { BARRACK_CONTROL_PLANE_PORT: controlPlanePort = "8787" } = process.env;
const controlPlaneUrl = `http://127.0.0.1:${controlPlanePort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: controlPlaneUrl },
      "/threads": { target: controlPlaneUrl, ws: true },
      "/health": { target: controlPlaneUrl },
    },
  },
});
