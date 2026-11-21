// Every file under src/ starts with the SPDX license identifier. `eslint --fix` adds it, or brings an older one up to date.

const HEADER = '// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial';

export default {
    meta: {
        type: 'problem',
        fixable: 'code',
        messages: { missing: 'Start the file with the license header: {{ header }}' },
        schema: [],
    },
    create(context)
    {
        return {
            Program()
            {
                const source = context.sourceCode;
                const first = source.lines[0] ?? '';
                if (first === HEADER) return;
                context.report({
                    loc: { line: 1, column: 0 },
                    messageId: 'missing',
                    data: { header: HEADER },
                    fix: fixer => first.startsWith('// SPDX-License-Identifier:')
                        ? fixer.replaceTextRange([0, first.length], HEADER)
                        : fixer.insertTextBeforeRange([0, 0], `${HEADER}\n\n`),
                });
            },
        };
    },
};
