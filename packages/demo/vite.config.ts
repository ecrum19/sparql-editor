/// <reference types="vitest/config" />
import {defineConfig} from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  root: "src",
  server: {
    port: 3000,
  },
});
