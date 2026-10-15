// The lines of a multi-line block comment line up under its opening `/*`: each starts one space past its column,
// at the `*`. ESLint's indent rule moves a comment's first line and leaves the rest where they were.

export default {
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: { align: 'Line this comment line up under its opening `/*`.' },
        schema: [],
    },
    create(context)
    {
        const source = context.sourceCode;
        return {
            Program()
            {
                for (const comment of source.getAllComments())
                {
                    if (comment.type !== 'Block' || comment.loc.start.line === comment.loc.end.line) continue;
                    const pad = ' '.repeat(comment.loc.start.column + 1);
                    for (let line = comment.loc.start.line + 1; line <= comment.loc.end.line; line++)
                    {
                        const text = source.lines[line - 1];
                        const lead = text.match(/^\s*/)[0];
                        if (!text.slice(lead.length).startsWith('*') || lead === pad) continue;
                        const start = source.getIndexFromLoc({ line, column: 0 });
                        context.report({
                            loc: { line, column: 0 },
                            messageId: 'align',
                            fix: fixer => fixer.replaceTextRange([start, start + lead.length], pad),
                        });
                    }
                }
            },
        };
    },
};
