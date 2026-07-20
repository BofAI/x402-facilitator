// Flat config for the x402 facilitator. Uses typescript-eslint recommended rules
// over src/ and test/. Legacy/ and dist/ are ignored.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "legacy/", "node_modules/", "*.tsbuildinfo"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
);
