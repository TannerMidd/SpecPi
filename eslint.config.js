import stylistic from "@stylistic/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";

const sourceFiles = ["**/*.js", "**/*.mjs", "**/*.ts", "**/*.mts", "**/*.tsx"];

export default [
    {
        ignores: ["node_modules/**", ".specpi-test/**", "desktop/out/**", "desktop/dist/**"],
    },
    {
        files: sourceFiles,
        languageOptions: {
            ecmaVersion: "latest",
            parser: typescriptParser,
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
                sourceType: "module",
            },
            sourceType: "module",
        },
        plugins: {
            "@stylistic": stylistic,
        },
        rules: {
            curly: ["error", "all"],
            "@stylistic/max-statements-per-line": ["error", { max: 1 }],
            "@stylistic/padding-line-between-statements": [
                "error",
                {
                    blankLine: "always",
                    next: "*",
                    prev: "block-like",
                },
                {
                    blankLine: "always",
                    next: "return",
                    prev: "*",
                },
            ],
        },
    },
];
