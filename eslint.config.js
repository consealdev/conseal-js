// The house style for TypeScript: 4-space indents, Allman braces, semicolons, single quotes.
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import allmanBraces from './eslint/allman-braces.js';
import commentIndent from './eslint/comment-indent.js';
import licenseHeader from './eslint/license-header.js';

export default tseslint.config(
    { ignores: ['dist/', 'node_modules/'] },
    {
        files: ['**/*.ts', '**/*.js', '**/*.mjs'],
        languageOptions: { parser: tseslint.parser },
        plugins: {
            '@stylistic': stylistic,
            house: {
                rules: { 'allman-braces': allmanBraces, 'comment-indent': commentIndent, 'license-header': licenseHeader },
            },
        },
        rules: {
            // Lit templates indent by their markup, not by the code around them.
            '@stylistic/indent': ['error', 4, { ignoredNodes: ['TemplateLiteral *'] }],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
            '@stylistic/member-delimiter-style': 'error',
            'house/allman-braces': 'error',
            'house/comment-indent': 'error',
        },
    },
    // The package's source carries the license header; tests and tooling needn't.
    {
        files: ['src/**/*.ts'],
        rules: { 'house/license-header': 'error' },
    },
);
