import stylistic from "@stylistic/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";

const sourceFiles = ["**/*.js", "**/*.mjs", "**/*.ts", "**/*.mts", "**/*.tsx"];

export default [
    {
        // Eval task workspaces are fixtures, not source. Their bytes are
        // hashed by the task checkers, and several of them are wrong on
        // purpose, so an --fix pass over them would both invalidate
        // FIXTURES.json and quietly repair the defects under test.
        ignores: [
            "node_modules/**",
            ".specpi-test/**",
            "desktop/out/**",
            "desktop/dist/**",
            "evals/tasks/*/workspace/**",
            "evals/archive/*/workspace/**",
        ],
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
