import { defineConfig } from "vite";
import { commitShaSchema } from "./shared/deployment";

export default defineConfig(({ command }) => {
  if (command === "build") {
    commitShaSchema.parse(process.env.VITE_SOURCE_SHA);
  }

  return {
    base: "./",
    build: {
      emptyOutDir: true,
      outDir: "../dist/site",
    },
    root: "site",
  };
});
