import { describe, expect, it } from 'vitest';
import { ArchiveError } from '../../src/sync/errors.js';
import { blobSource, crc32, readZipDirectory, readZipEntry, ZipWriter } from '../../src/sync/zip.js';

function zipOf(files: Record<string, string>): Uint8Array<ArrayBuffer>
{
    const zip = new ZipWriter(new Date(2026, 9, 14, 9, 30, 12));
    const parts = Object.entries(files).map(([name, text]) => zip.file(name, new TextEncoder().encode(text)));
    parts.push(zip.end());
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let at = 0;
    for (const part of parts)
    {
        bytes.set(part, at);
        at += part.byteLength;
    }
    return bytes;
}

describe('zip', () => {
    it('computes the standard CRC-32', () => {
        expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
        expect(crc32(new Uint8Array())).toBe(0);
    });

    it('reads back what it writes, names in UTF-8 included', async () => {
        const source = blobSource(new Blob([zipOf({ 'notes/0001.json': '[]', 'café/0001.json': '[1]', 'manifest.json': '{}' })]));
        const entries = await readZipDirectory(source);

        expect([...entries.keys()]).toEqual(['notes/0001.json', 'café/0001.json', 'manifest.json']);
        expect(new TextDecoder().decode(await readZipEntry(source, entries.get('café/0001.json')!))).toBe('[1]');
    });

    it('refuses an entry that was compressed or encrypted after export', async () => {
        const bytes = zipOf({ 'manifest.json': '{}' });
        const directory = bytes.length - 22 - 46 - 'manifest.json'.length;

        const compressed = bytes.slice();
        new DataView(compressed.buffer).setUint16(directory + 10, 8, true);
        await expect(readZipDirectory(blobSource(new Blob([compressed])))).rejects.toThrow(/compressed or encrypted/);

        const encrypted = bytes.slice();
        new DataView(encrypted.buffer).setUint16(directory + 8, 0x0801, true);
        await expect(readZipDirectory(blobSource(new Blob([encrypted])))).rejects.toThrow(/compressed or encrypted/);
    });

    it('refuses an entry whose checksum doesn\'t match', async () => {
        const bytes = zipOf({ 'manifest.json': '{"format":1}' });
        bytes[30 + 'manifest.json'.length] = 0x5b;
        const source = blobSource(new Blob([bytes]));

        await expect(readZipEntry(source, (await readZipDirectory(source)).get('manifest.json')!)).rejects.toBeInstanceOf(ArchiveError);
    });
});
