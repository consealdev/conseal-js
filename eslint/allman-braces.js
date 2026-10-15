// Allman braces as the house style has them, which ESLint's brace-style can't express: the opening brace of a
// declaration or a statement goes on its own line, and `else`, `catch` and `finally` start theirs. Arrow-function
// bodies, object literals and type literals stay inline, and a block that fits on one line may stay on it.

/** The indentation of the line `token` is on. */
function indentOf(source, token)
{
    return source.lines[token.loc.start.line - 1].match(/^\s*/)[0];
}

export default {
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: {
            brace: 'Put the opening brace on its own line.',
            keyword: 'Put `{{keyword}}` on its own line.',
        },
        schema: [],
    },
    create(context)
    {
        const source = context.sourceCode;

        /** Moves `open` to a line of its own, at the indentation of `owner`'s first line. */
        function brace(open, close, owner)
        {
            if (!open || open.value !== '{' || open.loc.start.line === close.loc.end.line) return;
            const before = source.getTokenBefore(open, { includeComments: true });
            if (before.loc.end.line !== open.loc.start.line) return;
            context.report({
                loc: open.loc,
                messageId: 'brace',
                fix: fixer => fixer.replaceTextRange([before.range[1], open.range[0]], `\n${indentOf(source, owner)}`),
            });
        }

        /** Moves the keyword after a closing brace to a line of its own, at the indentation of `owner`'s first line. */
        function keyword(block, owner)
        {
            const word = source.getTokenAfter(block);
            const close = source.getLastToken(block);
            if (close.value !== '}' || word.loc.start.line !== close.loc.end.line) return;
            context.report({
                loc: word.loc,
                messageId: 'keyword',
                data: { keyword: word.value },
                fix: fixer => fixer.replaceTextRange([close.range[1], word.range[0]], `\n${indentOf(source, owner)}`),
            });
        }

        const block = (node, owner) => brace(source.getFirstToken(node), source.getLastToken(node), owner);

        return {
            BlockStatement(node)
            {
                const parent = node.parent;
                switch (parent.type)
                {
                    case 'FunctionDeclaration':
                    case 'FunctionExpression':
                    case 'ForStatement':
                    case 'ForInStatement':
                    case 'ForOfStatement':
                    case 'WhileStatement':
                    case 'DoWhileStatement':
                    case 'CatchClause':
                        block(node, source.getFirstToken(parent));
                        break;
                    case 'IfStatement':
                        // An else's block lines up with `else`, which has a line of its own.
                        block(node, node === parent.alternate ? source.getTokenBefore(node) : source.getFirstToken(parent));
                        break;
                    case 'TryStatement':
                        block(node, node === parent.finalizer ? source.getTokenBefore(node) : source.getFirstToken(parent));
                        break;
                }
            },
            ClassBody(node)
            {
                block(node, source.getFirstToken(node.parent));
            },
            TSInterfaceBody(node)
            {
                block(node, source.getFirstToken(node.parent));
            },
            TSModuleBlock(node)
            {
                block(node, source.getFirstToken(node.parent));
            },
            TSEnumDeclaration(node)
            {
                const open = source.getTokenAfter(node.id);
                brace(open, source.getLastToken(node), source.getFirstToken(node));
            },
            SwitchStatement(node)
            {
                const open = source.getTokenAfter(node.discriminant, token => token.value === '{');
                brace(open, source.getLastToken(node), source.getFirstToken(node));
            },
            IfStatement(node)
            {
                if (node.alternate && node.consequent.type === 'BlockStatement') keyword(node.consequent, source.getFirstToken(node));
            },
            TryStatement(node)
            {
                if (node.handler) keyword(node.block, source.getFirstToken(node));
                if (node.finalizer) keyword(node.handler ? node.handler.body : node.block, source.getFirstToken(node));
            },
        };
    },
};
