import fg from "fast-glob";
import { createResolver, useNuxt } from "@nuxt/kit";

export const scanFolder = async (path: string): Promise<string[]> => {
  const nuxt = useNuxt();
  const { resolve } = createResolver(import.meta.url);
  const resolvedPath = resolve(nuxt.options.srcDir, path);

  const files: string[] = [];

  const updatedFiles = await fg("**/*.{ts,js,mjs}", {
    cwd: resolvedPath,
    absolute: true,
    onlyFiles: true,
  });

  files.push(...new Set(updatedFiles));

  return files;
};
