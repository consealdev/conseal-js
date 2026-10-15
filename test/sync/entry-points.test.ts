import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** The package's own source files in a folder of `src/`. */
function sources(folder: string): string[]
{
    return readdirSync(join(SRC, folder), { recursive: true, encoding: 'utf8' })
        .filter(file => file.endsWith('.ts'))
        .map(file => join(SRC, folder, file));
}

/** Every module a file imports, by the specifier it names. */
function importsOf(file: string): string[]
{
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'/gm)]
        .map(match => match[1] ?? match[2] ?? '');
}

/** The imports of `files` that match none of `allowed`, as `file: specifier`. */
function outside(files: string[], allowed: RegExp[]): string[]
{
    return files.flatMap(file => importsOf(file)
        .filter(specifier => !allowed.some(pattern => pattern.test(specifier)))
        .map(specifier => `${relative(SRC, file)}: ${specifier}`));
}

describe('the root entry point', () => {
    it('loads in Node, with no DOM', async () => {
        expect(typeof document).toBe('undefined');

        const root = await import('../../src/core/index.js');

        expect(root.seal).toBeTypeOf('function');
        expect(root.initCircle).toBeTypeOf('function');
    });

    it('imports only its own modules and @scure/bip39', () => {
        const core = sources('core');

        expect(core.length).toBeGreaterThan(10);
        expect(outside(core, [/^\.\/[a-z0-9-]+\.js$/, /^@scure\/bip39(\/.*)?$/])).toEqual([]);
    });
});

describe('the sync entry point', () => {
    it('loads in Node, with no DOM', async () => {
        expect(typeof document).toBe('undefined');

        const sync = await import('../../src/sync/index.js');

        expect(sync.CircleClient).toBeTypeOf('function');
        expect(sync.SyncEngine).toBeTypeOf('function');
    });

    it('imports nothing from lit or the components', () => {
        const engine = sources('sync');

        const leaks = engine.flatMap(file => importsOf(file)
            .filter(specifier => specifier === 'lit' || specifier.startsWith('lit/') || specifier.includes('/ui/'))
            .map(specifier => `${relative(SRC, file)}: ${specifier}`));

        expect(engine.length).toBeGreaterThan(10);
        expect(leaks).toEqual([]);
    });
});

describe('the components', () => {
    const components = sources('ui');

    it('import only lit, each other, and the client\'s types and errors', () => {
        const allowed = [/^lit(\/.*)?$/, /^\.\/[a-z-]+\.js$/, /^\.\.\/sync\/(circle-client|circle-transport|errors|join-session)\.js$/];

        expect(components.length).toBeGreaterThanOrEqual(6);
        expect(outside(components, allowed)).toEqual([]);
    });

    it('do no crypto or HTTP of their own', () => {
        const calls = components.filter(file => /\bfetch\(|crypto\.subtle|XMLHttpRequest/.test(readFileSync(file, 'utf8')));

        expect(calls.map(file => relative(SRC, file))).toEqual([]);
    });
});
