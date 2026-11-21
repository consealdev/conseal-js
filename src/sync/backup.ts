// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { fromBase64, generateAesKey, seal, toBase64, unseal, unwrapKey, wrapKey } from '../core/index.js';
import { toArrayBuffer } from './encoding.js';
import { ArchiveError, WrongPasscodeError } from './errors.js';
import type { ByteSource } from './zip.js';

/**
 * A sealed backup: an export's bytes under a passcode, in chunks so it streams both ways. It is `sealEnvelope`'s
 * construction, chunked: a random AES-256-GCM key, wrapped under the passcode by conseal's `wrapKey` (PBKDF2, run
 * once per backup), seals each chunk. The file is a JSON header line, then each chunk as IV ‖ ciphertext. Every chunk
 * but the last holds `chunkBytes` of the export; the AAD binds each to the backup, its position and whether it's the
 * last, so a chunk moved, dropped, repeated, taken from another backup or cut short fails to open.
 */

export const BACKUP_FORMAT = 'conseal-sync-backup';
const BACKUP_VERSION = 1;
const CHUNK_BYTES = 1024 * 1024;
const MIN_CHUNK_BYTES = 4096;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const OVERHEAD = IV_BYTES + TAG_BYTES;

interface BackupHeader
{
    format: string;
    version: number;
    backupId: string;
    chunkBytes: number;
    salt: string;
    wrappedKey: string;
}

/** Seals an export's bytes under `passcode`, chunk by chunk, as they come. */
export async function* sealBackup(archive: AsyncIterable<Uint8Array>, passcode: string): AsyncGenerator<Uint8Array>
{
    const key = await generateAesKey(true);
    const { wrappedKey, salt } = await wrapKey(passcode, key);
    const header: BackupHeader = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        backupId: crypto.randomUUID(),
        chunkBytes: CHUNK_BYTES,
        salt: toBase64(salt),
        wrappedKey: toBase64(wrappedKey),
    };
    yield new TextEncoder().encode(`${JSON.stringify(header)}\n`);

    // A full chunk waits until more bytes come: only then is it known not to be the last.
    const chunk = new Uint8Array(CHUNK_BYTES);
    let filled = 0;
    let index = 0;
    for await (const bytes of archive)
    {
        let at = 0;
        while (at < bytes.byteLength)
        {
            if (filled === CHUNK_BYTES)
            {
                yield await sealChunk(key, header.backupId, index++, chunk, false);
                filled = 0;
            }
            const taken = Math.min(CHUNK_BYTES - filled, bytes.byteLength - at);
            chunk.set(bytes.subarray(at, at + taken), filled);
            filled += taken;
            at += taken;
        }
    }
    yield await sealChunk(key, header.backupId, index, chunk.subarray(0, filled), true);
}

/** Opens a sealed backup with its passcode, as the export it holds, decrypted a chunk at a time as it's read. */
export async function openBackup(file: Blob, passcode: string): Promise<ByteSource>
{
    const { header, headerBytes } = await readHeader(file);
    let key: CryptoKey;
    try
    {
        key = await unwrapKey(passcode, toArrayBuffer(fromBase64(header.wrappedKey)), fromBase64(header.salt));
    }
    catch
    {
        throw new WrongPasscodeError('That passcode doesn\'t open this backup.');
    }

    const stride = header.chunkBytes + OVERHEAD;
    const body = file.size - headerBytes;
    const chunks = Math.ceil(body / stride);
    const lastBytes = body - (chunks - 1) * stride;
    if (chunks === 0 || lastBytes < OVERHEAD) throw new ArchiveError('The backup was cut short.');

    let cached: { index: number; plaintext: Uint8Array } | undefined;
    const chunkAt = async (index: number): Promise<Uint8Array> =>
    {
        if (cached?.index === index) return cached.plaintext;
        const last = index === chunks - 1;
        const start = headerBytes + index * stride;
        const sealed = new Uint8Array(await file.slice(start, start + (last ? lastBytes : stride)).arrayBuffer());
        let plaintext: Uint8Array;
        try
        {
            plaintext = new Uint8Array(await unseal(
                key,
                toArrayBuffer(sealed.subarray(IV_BYTES)),
                sealed.slice(0, IV_BYTES),
                chunkAad(header.backupId, index, last),
            ));
        }
        catch
        {
            throw new ArchiveError('The backup is damaged, cut short or altered: part of it doesn\'t open.');
        }
        cached = { index, plaintext };
        return plaintext;
    };

    return {
        size: (chunks - 1) * header.chunkBytes + lastBytes - OVERHEAD,
        read: async (offset, length) =>
        {
            const out = new Uint8Array(length);
            let filled = 0;
            while (filled < length)
            {
                const position = offset + filled;
                const index = Math.floor(position / header.chunkBytes);
                if (index >= chunks) break;
                const plaintext = await chunkAt(index);
                const from = position - index * header.chunkBytes;
                const taken = Math.min(plaintext.byteLength - from, length - filled);
                if (taken <= 0) break;
                out.set(plaintext.subarray(from, from + taken), filled);
                filled += taken;
            }
            return out.subarray(0, filled);
        },
    };
}

/** Whether `file` starts like a sealed backup. */
export async function isBackup(file: Blob): Promise<boolean>
{
    try
    {
        await readHeader(file);
        return true;
    }
    catch
    {
        return false;
    }
}

async function readHeader(file: Blob): Promise<{ header: BackupHeader; headerBytes: number }>
{
    const start = new Uint8Array(await file.slice(0, MAX_HEADER_BYTES).arrayBuffer());
    const newline = start.indexOf(0x0a);
    if (newline < 0) throw new ArchiveError('The file isn\'t a sealed backup.');

    let header: Partial<BackupHeader>;
    try
    {
        header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(start.subarray(0, newline))) as Partial<BackupHeader>;
    }
    catch
    {
        throw new ArchiveError('The file isn\'t a sealed backup.');
    }
    if (header.format !== BACKUP_FORMAT) throw new ArchiveError('The file isn\'t a sealed backup.');
    if (header.version !== BACKUP_VERSION)
    {
        throw new ArchiveError(`The backup is version ${String(header.version)}, which this version of the app can't read.`);
    }
    const valid = typeof header.backupId === 'string'
        && typeof header.salt === 'string'
        && typeof header.wrappedKey === 'string'
        && Number.isInteger(header.chunkBytes)
        && (header.chunkBytes as number) >= MIN_CHUNK_BYTES
        && (header.chunkBytes as number) <= MAX_CHUNK_BYTES;
    if (!valid) throw new ArchiveError('The backup\'s header is damaged.');
    return { header: header as BackupHeader, headerBytes: newline + 1 };
}

async function sealChunk(key: CryptoKey, backupId: string, index: number, plaintext: Uint8Array, last: boolean): Promise<Uint8Array>
{
    const { ciphertext, iv } = await seal(key, toArrayBuffer(plaintext), chunkAad(backupId, index, last));
    const bytes = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    bytes.set(iv, 0);
    bytes.set(new Uint8Array(ciphertext), iv.byteLength);
    return bytes;
}

function chunkAad(backupId: string, index: number, last: boolean): Uint8Array
{
    return new TextEncoder().encode(`${BACKUP_FORMAT}:v${BACKUP_VERSION}:${backupId}:${index}:${last ? 1 : 0}`);
}
