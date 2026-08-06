// The same ruleset the Obsidian community directory runs against a submitted
// plugin. Running it here means version and API mistakes surface locally
// instead of in a review round: no-unsupported-api compares every API call
// against the minAppVersion in manifest.json, which TypeScript cannot do
// because it has no concept of @since.
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: [
      "main.js",
      "node_modules/**",
      "docs/**",
      "scripts/**",
      "esbuild.config.mjs",
      "eslint.config.mjs",
      "vitest.config.ts",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    // The recommended set includes rules that need type information, so the
    // parser has to be pointed at the TypeScript project.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Sentence case is the right rule; it just does not know our nouns.
      // Without this it asks for "Connect stashwise", wants the token
      // placeholder sw_at_... title cased, and capitalises "cursor" because it
      // reads it as the editor of the same name.
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Stashwise", "Obsidian", "Dataview"],
          acronyms: ["URL", "API", "MIT"],
          ignoreWords: ["cursor"],
          ignoreRegex: ["^sw_at_"],
        },
      ],
    },
  },
];
