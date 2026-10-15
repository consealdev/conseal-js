import { ArchiveError, SyncError } from './errors.js';

/**
 * The ZIP subset exports use: files stored without compression, sizes in every local header, no ZIP64. Any unzip
 * tool opens it; the reader opens only this subset, which is what this package writes.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_DIRECTORY_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const VERSION = 20;
const UTF8_NAMES = 0x0800;
const ENCRYPTED = 0x0001;
const STORED = 0;
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
/** The most the reader holds at once: no export part or directory comes near it. */
const MAX_READ_BYTES = 64 * 1024 * 1024;

/** Bytes read by position, so a reader needn't hold a whole file: a `Blob`, or a sealed backup as it decrypts. */
export interface ByteSource
{
    readonly size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
}

/** A `Blob`, such as a `File` the user picked, read in slices. */
export function blobSource(blob: Blob): ByteSource
{
    return {
        size: blob.size,
        read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
    };
}

/** One file in a ZIP's central directory. */
export interface ZipEntry
{
    name: string;
    offset: number;
    size: number;
    crc: number;
}

interface CentralEntry extends ZipEntry
{
    nameBytes: Uint8Array;
}

/** Writes a ZIP a file at a time: `file` returns each file's bytes to emit, and `end` the directory that closes it. */
export class ZipWriter
{
    private readonly _time: number;
    private readonly _date: number;
    private readonly _entries: CentralEntry[] = [];
    private _offset = 0;

    constructor(modified: Date)
    {
        this._time = (modified.getHours() << 11) | (modified.getMinutes() << 5) | Math.floor(modified.getSeconds() / 2);
        this._date = ((Math.max(modified.getFullYear(), 1980) - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
    }

    public file(name: string, data: Uint8Array): Uint8Array
    {
        if (this._entries.length === MAX_ENTRIES) throw new SyncError(`An export holds at most ${MAX_ENTRIES} files.`);

        const nameBytes = new TextEncoder().encode(name);
        const entry: CentralEntry = { name, nameBytes, offset: this._offset, size: data.byteLength, crc: crc32(data) };
        const bytes = new Uint8Array(LOCAL_HEADER_BYTES + nameBytes.byteLength + data.byteLength);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, LOCAL_HEADER, true);
        view.setUint16(4, VERSION, true);
        view.setUint16(6, UTF8_NAMES, true);
        view.setUint16(8, STORED, true);
        view.setUint16(10, this._time, true);
        view.setUint16(12, this._date, true);
        view.setUint32(14, entry.crc, true);
        view.setUint32(18, entry.size, true);
        view.setUint32(22, entry.size, true);
        view.setUint16(26, nameBytes.byteLength, true);
        view.setUint16(28, 0, true);
        bytes.set(nameBytes, LOCAL_HEADER_BYTES);
        bytes.set(data, LOCAL_HEADER_BYTES + nameBytes.byteLength);

        this._advance(bytes.byteLength);
        this._entries.push(entry);
        return bytes;
    }

    public end(): Uint8Array
    {
        const directoryBytes = this._entries.reduce((total, entry) => total + CENTRAL_HEADER_BYTES + entry.nameBytes.byteLength, 0);
        const bytes = new Uint8Array(directoryBytes + END_OF_DIRECTORY_BYTES);
        const view = new DataView(bytes.buffer);
        let at = 0;
        for (const entry of this._entries)
        {
            view.setUint32(at, CENTRAL_HEADER, true);
            view.setUint16(at + 4, VERSION, true);
            view.setUint16(at + 6, VERSION, true);
            view.setUint16(at + 8, UTF8_NAMES, true);
            view.setUint16(at + 10, STORED, true);
            view.setUint16(at + 12, this._time, true);
            view.setUint16(at + 14, this._date, true);
            view.setUint32(at + 16, entry.crc, true);
            view.setUint32(at + 20, entry.size, true);
            view.setUint32(at + 24, entry.size, true);
            view.setUint16(at + 28, entry.nameBytes.byteLength, true);
            view.setUint32(at + 42, entry.offset, true);
            bytes.set(entry.nameBytes, at + CENTRAL_HEADER_BYTES);
            at += CENTRAL_HEADER_BYTES + entry.nameBytes.byteLength;
        }

        view.setUint32(at, END_OF_DIRECTORY, true);
        view.setUint16(at + 8, this._entries.length, true);
        view.setUint16(at + 10, this._entries.length, true);
        view.setUint32(at + 12, directoryBytes, true);
        view.setUint32(at + 16, this._offset, true);
        this._advance(bytes.byteLength);
        return bytes;
    }

    private _advance(bytes: number): void
    {
        this._offset += bytes;
        if (this._offset > MAX_UINT32) throw new SyncError('The export is over 4 GiB, more than a ZIP without ZIP64 holds.');
    }
}

/** The files a ZIP's central directory lists, by name. */
export async function readZipDirectory(source: ByteSource): Promise<Map<string, ZipEntry>>
{
    const tailLength = Math.min(source.size, END_OF_DIRECTORY_BYTES + MAX_COMMENT_BYTES);
    const tail = await source.read(source.size - tailLength, tailLength);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let end = -1;
    for (let at = tail.byteLength - END_OF_DIRECTORY_BYTES; at >= 0; at--)
    {
        if (tailView.getUint32(at, true) === END_OF_DIRECTORY && at + END_OF_DIRECTORY_BYTES + tailView.getUint16(at + 20, true) === tail.byteLength)
        {
            end = at;
            break;
        }
    }
    if (end < 0) throw new ArchiveError('The file isn\'t a ZIP, or it was cut short.');

    const count = tailView.getUint16(end + 10, true);
    const directorySize = tailView.getUint32(end + 12, true);
    const directoryOffset = tailView.getUint32(end + 16, true);
    if (directoryOffset + directorySize > source.size - tailLength + end || directorySize > MAX_READ_BYTES)
    {
        throw new ArchiveError('The ZIP\'s directory points past the end of the file.');
    }

    const directory = await source.read(directoryOffset, directorySize);
    const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const names = new TextDecoder('utf-8', { fatal: true });
    const entries = new Map<string, ZipEntry>();
    let at = 0;
    for (let index = 0; index < count; index++)
    {
        if (at + CENTRAL_HEADER_BYTES > directory.byteLength || view.getUint32(at, true) !== CENTRAL_HEADER)
        {
            throw new ArchiveError('The ZIP\'s directory is damaged.');
        }
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const size = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
        if ((flags & ENCRYPTED) !== 0 || method !== STORED || view.getUint32(at + 24, true) !== size)
        {
            throw new ArchiveError('The ZIP was compressed or encrypted after export, so it can\'t be imported. Use the file as exported.');
        }

        let name: string;
        try
        {
            name = names.decode(directory.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength));
        }
        catch
        {
            throw new ArchiveError('A file name in the ZIP isn\'t UTF-8.');
        }
        if (entries.has(name)) throw new ArchiveError(`The ZIP holds ${name} twice.`);
        entries.set(name, { name, offset: view.getUint32(at + 42, true), size, crc: view.getUint32(at + 16, true) });
        at += CENTRAL_HEADER_BYTES + skip;
    }
    return entries;
}

/** A file's bytes, checked against its CRC-32. */
export async function readZipEntry(source: ByteSource, entry: ZipEntry): Promise<Uint8Array>
{
    if (entry.size > MAX_READ_BYTES) throw new ArchiveError(`${entry.name} is larger than any file an export holds.`);
    const header = await source.read(entry.offset, LOCAL_HEADER_BYTES);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (header.byteLength < LOCAL_HEADER_BYTES || view.getUint32(0, true) !== LOCAL_HEADER)
    {
        throw new ArchiveError(`The ZIP's entry for ${entry.name} is damaged.`);
    }

    const start = entry.offset + LOCAL_HEADER_BYTES + view.getUint16(26, true) + view.getUint16(28, true);
    if (start + entry.size > source.size) throw new ArchiveError(`${entry.name} runs past the end of the file.`);
    const data = await source.read(start, entry.size);
    if (crc32(data) !== entry.crc) throw new ArchiveError(`${entry.name} is damaged: its checksum doesn't match.`);
    return data;
}

let crcTable: Uint32Array | undefined;

/** The CRC-32 a ZIP stores for each file (the IEEE polynomial, reflected). */
export function crc32(data: Uint8Array): number
{
    crcTable ??= makeCrcTable();
    let crc = MAX_UINT32;
    for (const byte of data)
    {
        crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
    }
    return (crc ^ MAX_UINT32) >>> 0;
}

function makeCrcTable(): Uint32Array
{
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++)
    {
        let c = n;
        for (let k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
}
