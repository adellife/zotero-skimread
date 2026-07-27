// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    {
      // Snippets pasted into Zotero's Run JavaScript console, which evaluates
      // them as a function body and displays the returned value.
      files: ["scripts/**/*.js"],
      languageOptions: {
        sourceType: "script",
        parserOptions: { ecmaFeatures: { globalReturn: true } },
        globals: { Zotero: "readonly" },
      },
    },
  ],
});
