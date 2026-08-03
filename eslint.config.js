import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.browser.json",
          "./tsconfig.tools.json",
          "./tsconfig.worker.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      eqeqeq: ["error", "always", { null: "never" }],
    },
  },
  {
    ignores: [
      ".agents/**",
      ".wrangler/**",
      "dist/**",
      "eslint.config.js",
      "node_modules/**",
      "worker-configuration.d.ts",
    ],
  },
  prettier,
);
