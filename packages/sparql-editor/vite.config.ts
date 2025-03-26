/// <reference types="vitest/config" />
import {defineConfig} from "vite";
import typescript from "@rollup/plugin-typescript";
// import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 3000,
  },
  build: {
    outDir: "dist",
    target: ["es2020"],
    lib: {
      entry: "src/sparql-editor.ts",
      name: "@sib-swiss/sparql-editor",
      fileName: "sparql-editor",
    },
    sourcemap: true,
    cssCodeSplit: true,
    rollupOptions: {
      plugins: [typescript()],
    },
  },
  // resolve: {
  //   alias: {
  //     '@sib-swiss/sparql-overview': resolve(__dirname, '../sparql-overview/src/sparql-overview.ts')
  //   }
  // }
  // test: {
  //   globals: true,
  //   environment: "jsdom",
  // },
});
