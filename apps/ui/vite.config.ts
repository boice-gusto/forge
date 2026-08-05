import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * `/v1` is proxied rather than called cross-origin.
 *
 * The session cookie is `HttpOnly` and `SameSite=Strict`, which only works if
 * the UI and the control plane share an origin. A deployment puts both behind
 * one reverse proxy; the dev server does the same job here, so development and
 * production exercise the same cookie rules — instead of development needing
 * cross-origin credential sharing that production would rightly refuse.
 */
export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: { "/v1": process.env.FORGE_API_URL ?? "http://127.0.0.1:3100" },
  },
});
