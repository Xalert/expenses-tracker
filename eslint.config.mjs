import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Playwright fixtures call their `use` callback, which the React hooks rule mistakes for React's `use`.
  { files: ["e2e/**"], rules: { "react-hooks/rules-of-hooks": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone claude.ai Artifact (plain browser JS, not part of the Next.js app); covered by its harness and
    // tests/statement-importer-csv.test.ts.
    "tools/**",
    ".claude/**",
    // Playwright's output (e2e tests).
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
