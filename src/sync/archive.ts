import { isBackup, openBackup } from './backup.js';
import { blobRefs, type BlobRef } from './blob-envelope.js';
import { isRecordId, type CollectionDefinition } from './collections.js';
import { ArchiveError, WrongPasscodeError } from './errors.js';
import type { RecordStore } from './record-store.js';
import { isPlainObject, withoutLocalOnly } from './values.js';
import { blobSource, readZipDirectory, readZipEntry, ZipWriter, type ByteSource, type ZipEntry } from './zip.js';

/**
 * An export is a ZIP: each collection's records as JSON parts, `<collection>/0001.json` and on, a JSON array of
 * `{ id, schemaVersion, value }` with one record per line, the blobs the records refer to as files of their own,
 * `blobs/<collection>/<recordId>/<blobId>`, and `manifest.json` last, once the counts are known. Values leave out
 * local-only fields; sync state and keys never go in, but for each blob's DEK, which its reference carries in the value.
 */

const EXPORT_FORMAT = 'conseal-sync-export';
const EXPORT_VERSION = 1;
const MANIFEST = 'manifest.json';
const PAGE_ITEMS = 500;
/** A part closes once it holds this much, so neither export nor import holds more than about one part at a time. */
const PART_BYTES = 4 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ZIP_START = [0x50, 0x4b, 0x03, 0x04];

/** A collection as export and import see it. */
export interface ArchiveCollection
{
    name: string;
    definition: CollectionDefinition;
    localOnly: readonly string[];
}

export interface ExportOptions
{
    /**
     * Seals the export under this passcode, as a backup that only the passcode opens. Without one, the export is
     * plain JSON: unencrypted, readable by anything, and by anyone who gets the file.
     */
    passcode?: string | undefined;
}

export interface ImportOptions
{
    /** The passcode a sealed backup was made with. */
    passcode?: string | undefined;
    /** Replaces records this device holds with another value. Without it, the device's values are kept. */
    replace?: boolean | undefined;
}

/** What an import did, record by record. */
export interface ImportReport
{
    /** Records this device didn't hold, or had deleted, now saved here. */
    added: number;
    /** Records whose value on this device the import replaced, with `replace`. */
    replaced: number;
    /** Records this device already holds with the same value. */
    unchanged: number;
    /** Records this device holds with another value, left as they are. */
    kept: number;
    /** Collections in the file that the registry doesn't have, so none of their records were imported. */
    skipped: { id: string; name: string; records: number }[];
    /** Blobs from the file, of the records added or replaced, waiting on this device to upload with them. */
    blobs: number;
}

/** What a file is: a plain export or a sealed backup. */
export type ArchiveKind = 'export' | 'backup';

/** One record as an export holds it. */
export interface ArchivedRecord
{
    id: string;
    schemaVersion: number;
    value: object;
}

/** An archive's contents for one registry, checked through before anything is written. */
export interface ArchivePlan<C extends ArchiveCollection>
{
    /** Each collection's parts, and its blob files by `<recordId>/<blobId>`. */
    parts: { collection: C; entries: ZipEntry[]; blobs: ReadonlyMap<string, ZipEntry> }[];
    skipped: ImportReport['skipped'];
}

/** Where export gets a blob's bytes, opened; undefined when the blob isn't there to export. */
export type BlobReader = (collection: ArchiveCollection, recordId: string, ref: BlobRef) => Promise<Uint8Array | undefined>;

interface ManifestCollection
{
    name: string;
    id: string;
    schemaVersion: number;
    records: number;
    parts: string[];
    /** The collection's blob files; absent from an export made before blobs. */
    blobs?: string[];
}

interface Manifest
{
    format: string;
    version: number;
    exportedAt: string;
    collections: ManifestCollection[];
}

/**
 * The export's bytes as they're made, a part at a time, read from the store a page at a time. Each blob a record refers
 * to goes in as it's read; one `readBlob` can't find is left out.
 */
export async function* exportArchive(
    collections: readonly ArchiveCollection[],
    store: RecordStore,
    exportedAt: Date,
    readBlob: BlobReader,
): AsyncGenerator<Uint8Array>
{
    const zip = new ZipWriter(exportedAt);
    const encoder = new TextEncoder();
    const directories = partDirectories(collections);
    const manifest: Manifest = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: exportedAt.toISOString(), collections: [] };

    for (const c of collections)
    {
        const listed: ManifestCollection = { name: c.name, id: c.definition.id, schemaVersion: c.definition.schemaVersion, records: 0, parts: [], blobs: [] };
        const blobs: string[] = [];
        // Each record's line, encoded, so a part's size is counted in bytes.
        let lines: Uint8Array[] = [];
        let size = 0;
        const part = (): Uint8Array =>
        {
            const path = `${directories.get(c.name)}/${String(listed.parts.length + 1).padStart(4, '0')}.json`;
            listed.parts.push(path);
            const bytes = zip.file(path, joinLines(lines));
            lines = [];
            size = 0;
            return bytes;
        };

        let after: string | undefined;
        while (true)
        {
            const page = await store.list(c.name, after, PAGE_ITEMS);
            for (const record of page)
            {
                // Deleted here, and not yet pushed: not the user's data any more.
                if (record.value === undefined) continue;
                const value = withoutLocalOnly(record.value, c.localOnly);
                const line = encoder.encode(JSON.stringify({ id: record.id, schemaVersion: record.schemaVersion, value }));
                lines.push(line);
                size += line.byteLength;
                listed.records++;

                for (const ref of blobRefs(value))
                {
                    const bytes = await readBlob(c, record.id, ref);
                    if (bytes === undefined) continue;
                    const path = `blobs/${directories.get(c.name)}/${record.id}/${ref.id}`;
                    blobs.push(path);
                    yield zip.file(path, bytes);
                }
                if (size >= PART_BYTES) yield part();
            }
            const last = page.at(-1);
            if (page.length < PAGE_ITEMS || last === undefined) break;
            after = last.id;
        }
        if (lines.length > 0) yield part();
        manifest.collections.push({ ...listed, blobs });
    }

    yield zip.file(MANIFEST, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
    yield zip.end();
}

/** Whether `file` is a plain export or a sealed backup, by how it starts; undefined when it's neither. */
export async function archiveKind(file: Blob): Promise<ArchiveKind | undefined>
{
    const start = new Uint8Array(await file.slice(0, ZIP_START.length).arrayBuffer());
    if (ZIP_START.every((byte, index) => start[index] === byte)) return 'export';
    return await isBackup(file) ? 'backup' : undefined;
}

/** The export a file holds, opened with the passcode when it's a sealed backup. */
export async function openArchive(file: Blob, passcode: string | undefined): Promise<ByteSource>
{
    switch (await archiveKind(file))
    {
        case 'export':
            return blobSource(file);
        case 'backup':
            if (passcode === undefined) throw new WrongPasscodeError('This backup is sealed: import it with its passcode.');
            return openBackup(file, passcode);
        default:
            throw new ArchiveError('The file isn\'t an export or a sealed backup.');
    }
}

/**
 * Reads the whole archive once, so a damaged or partial file is refused before anything is written: every part's
 * checksum, every record, each collection's count against the manifest, and every blob's checksum and size against
 * the reference its record holds.
 */
export async function readArchive<C extends ArchiveCollection>(source: ByteSource, collections: readonly C[]): Promise<ArchivePlan<C>>
{
    const entries = await readZipDirectory(source);
    const manifestEntry = entries.get(MANIFEST);
    if (manifestEntry === undefined) throw new ArchiveError('The ZIP has no manifest.json, so it isn\'t an export.');
    const manifest = parseManifest(await readZipEntry(source, manifestEntry));

    const byId = new Map(collections.map(c => [c.definition.id, c]));
    const seen = new Set<string>();
    const plan: ArchivePlan<C> = { parts: [], skipped: [] };
    for (const listed of manifest.collections)
    {
        if (seen.has(listed.id)) throw new ArchiveError(`The manifest lists collection ${listed.id} twice.`);
        seen.add(listed.id);

        const parts = listed.parts.map(path => {
            const entry = entries.get(path);
            if (entry === undefined) throw new ArchiveError(`The export is missing ${path}.`);
            return entry;
        });
        let records = 0;
        const refs = new Map<string, BlobRef>();
        for (const entry of parts)
        {
            for (const record of parseRecords(await readZipEntry(source, entry), entry.name))
            {
                records++;
                for (const ref of blobRefs(record.value)) refs.set(`${record.id}/${ref.id}`, ref);
            }
        }
        if (records !== listed.records)
        {
            throw new ArchiveError(`The manifest counts ${listed.records} records in ${listed.name}, and the export holds ${records}.`);
        }

        const blobs = new Map<string, ZipEntry>();
        for (const path of listed.blobs ?? [])
        {
            const entry = entries.get(path);
            if (entry === undefined) throw new ArchiveError(`The export is missing ${path}.`);
            const key = path.split('/').slice(-2).join('/');
            const ref = refs.get(key);
            if (ref === undefined || blobs.has(key)) throw new ArchiveError(`${path} isn't a blob of a record in ${listed.name}.`);
            if (entry.size !== ref.size) throw new ArchiveError(`${path} holds ${entry.size} bytes, and its record says ${ref.size}.`);
            await readZipEntry(source, entry);
            blobs.set(key, entry);
        }

        const collection = byId.get(listed.id);
        if (collection === undefined) plan.skipped.push({ id: listed.id, name: listed.name, records });
        else plan.parts.push({ collection, entries: parts, blobs });
    }
    return plan;
}

/** The records of a checked archive, a part at a time, each with its blob files by blob id. */
export async function* archiveRecords<C extends ArchiveCollection>(
    source: ByteSource,
    plan: ArchivePlan<C>,
): AsyncGenerator<{ collection: C; record: ArchivedRecord; blobs: ReadonlyMap<string, ZipEntry> }>
{
    for (const { collection, entries, blobs } of plan.parts)
    {
        for (const entry of entries)
        {
            for (const record of parseRecords(await readZipEntry(source, entry), entry.name))
            {
                const own = new Map<string, ZipEntry>();
                for (const ref of blobRefs(record.value))
                {
                    const blob = blobs.get(`${record.id}/${ref.id}`);
                    if (blob !== undefined) own.set(ref.id, blob);
                }
                yield { collection, record, blobs: own };
            }
        }
    }
}

/** Records' lines as a part: a JSON array, one record per line. */
function joinLines(lines: readonly Uint8Array[]): Uint8Array
{
    const bytes = new Uint8Array(lines.reduce((total, line) => total + line.byteLength + 2, 2) + 1);
    let at = 0;
    const put = (text: string): void =>
    {
        for (const char of text) bytes[at++] = char.charCodeAt(0);
    };
    put('[\n');
    for (const [index, line] of lines.entries())
    {
        bytes.set(line, at);
        at += line.byteLength;
        put(index < lines.length - 1 ? ',\n' : '\n');
    }
    put(']\n');
    return bytes.subarray(0, at);
}

/** Each collection's folder: its name, unless that isn't a safe file name or two would clash, then its id. */
function partDirectories(collections: readonly ArchiveCollection[]): Map<string, string>
{
    const named = collections.map(c => (SAFE_NAME.test(c.name) && c.name !== MANIFEST ? c.name : `collection-${c.definition.id}`));
    const clash = new Set(named).size !== named.length;
    return new Map(collections.map((c, index) => [c.name, clash ? `collection-${c.definition.id}` : named[index] as string]));
}

function parseManifest(bytes: Uint8Array): Manifest
{
    const manifest = parseJson(bytes, MANIFEST);
    if (!isPlainObject(manifest) || (manifest as Partial<Manifest>).format !== EXPORT_FORMAT)
    {
        throw new ArchiveError('The ZIP\'s manifest.json isn\'t an export\'s.');
    }
    const { version, collections } = manifest as Partial<Manifest>;
    if (version !== EXPORT_VERSION) throw new ArchiveError(`The export is version ${String(version)}, which this version of the app can't read.`);

    const valid = Array.isArray(collections) && collections.every(listed => isPlainObject(listed)
        && typeof listed.name === 'string'
        && typeof listed.id === 'string'
        && isWholeNumber(listed.schemaVersion, 1)
        && isWholeNumber(listed.records, 0)
        && Array.isArray(listed.parts)
        && listed.parts.every(part => typeof part === 'string')
        && (listed.blobs === undefined || (Array.isArray(listed.blobs) && listed.blobs.every(isBlobPath))));
    if (!valid) throw new ArchiveError('The export\'s manifest.json is damaged.');
    return manifest as Manifest;
}

function parseRecords(bytes: Uint8Array, name: string): ArchivedRecord[]
{
    const records = parseJson(bytes, name);
    if (!Array.isArray(records)) throw new ArchiveError(`${name} isn't a list of records.`);
    for (const record of records)
    {
        const valid = isPlainObject(record)
            && typeof (record as Partial<ArchivedRecord>).id === 'string'
            && isRecordId((record as ArchivedRecord).id)
            && isWholeNumber((record as Partial<ArchivedRecord>).schemaVersion, 1)
            && isPlainObject((record as Partial<ArchivedRecord>).value)
            && !Object.hasOwn((record as ArchivedRecord).value, 'schemaVersion');
        if (!valid) throw new ArchiveError(`${name} holds a record that isn't one the engine can sync.`);
    }
    return records as ArchivedRecord[];
}

function parseJson(bytes: Uint8Array, name: string): unknown
{
    try
    {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch
    {
        throw new ArchiveError(`${name} isn't valid JSON.`);
    }
}

/** A blob file's path: `blobs/<collection>/<recordId>/<blobId>`. */
function isBlobPath(path: unknown): boolean
{
    if (typeof path !== 'string') return false;
    const segments = path.split('/');
    return segments.length === 4 && segments[0] === 'blobs' && isRecordId(segments[2] ?? '') && isRecordId(segments[3] ?? '');
}

function isWholeNumber(value: unknown, min: number): boolean
{
    return typeof value === 'number' && Number.isInteger(value) && value >= min;
}
