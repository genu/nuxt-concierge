import { createConfigForNuxt } from "@nuxt/eslint-config/flat";

export default createConfigForNuxt()
  .append({
    ignores: [
      "dist",
      "node_modules",
      ".nuxt",
      ".output",
      "playground/.nuxt",
      "docs/.nuxt",
    ],
  })
  .append({
    rules: {
      "vue/multi-word-component-names": "off",
    },
  });
