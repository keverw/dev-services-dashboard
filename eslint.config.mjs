import js from "@eslint/js";
import { fixupPluginRules } from "@eslint/compat";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,

  // Backend / library TypeScript, the shared wire types, and the CLI. All three
  // are plain Node-targeted TypeScript, so they share one block. Without it the
  // default (espree) parser would be used and fail on TS syntax.
  {
    files: ["src/backend/**/*.ts", "src/cli/**/*.ts", "src/shared/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-undef": "off",
    },
  },

  // React frontend
  {
    files: ["src/frontend-react/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        WebSocket: "readonly",
        MessageEvent: "readonly",
        Event: "readonly",
        HTMLElement: "readonly",
        MutationObserver: "readonly",
        ResizeObserver: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      react: fixupPluginRules(reactPlugin),
      "react-hooks": fixupPluginRules(reactHooksPlugin),
      "jsx-a11y": jsxA11y,
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "no-undef": "off",
      // React Compiler rules (react-hooks v7): warn only, codebase predates compiler
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },

  {
    ignores: ["dist/**", "node_modules/**", "src/frontend-build/**"],
  },
];
