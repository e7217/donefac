import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  decodeLegacyText, LegacyArchiveError, LEGACY_MAX_EXPANDED_BYTES, LEGACY_MAX_FILE_BYTES,
  LEGACY_MAX_FILES, LEGACY_MAX_RAW_BYTES, LEGACY_MAX_XML_ATTRIBUTES, LEGACY_MAX_XML_DEPTH,
  LEGACY_MAX_XML_NODES, parseLegacyXml, readLegacyArchive,
} from '../../server/legacy-import-archive.js';

interface ZipEntry {
  name: string; content?: Buffer; method?: number; flags?: number; mode?: number;
  checksum?: number; declaredSize?: number; compressed?: Buffer; nameBytes?: Buffer;
}
/** Small in-memory central-directory fixtures, including deliberately corrupt
 * declarations. No filesystem extraction or additional ZIP writer dependency. */
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = entry.nameBytes || Buffer.from(entry.name), content = entry.content || Buffer.alloc(0);
    const method = entry.method ?? 0, compressed = entry.compressed || (method === 8 ? deflateRawSync(content) : content);
    const checksum = entry.checksum ?? crc32(content), size = entry.declaredSize ?? content.length, flags = entry.flags ?? 0x800;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum >>> 0, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(3 << 8 | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum >>> 0, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, central, end]);
}
const isArchiveError = (status = 400) => (error: unknown) => error instanceof LegacyArchiveError && error.status === status;
function utf16be(text: string): Buffer { return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]); }

test('strict text decoding preserves Unicode and exact CDATA including CRLF, namespaces and whitespace', () => {
  const cdata = '  첫 줄\r\n둘째 줄\r<&raw; 😀  ', xml = `<?xml version="1.0" encoding="UTF-8"?><ac:root ri:id="A&amp;B" zero="001"><body><![CDATA[${cdata}]]></body><x> 앞 &lt; &#x1f600; &#13; 뒤 </x></ac:root>`;
  const parsed = parseLegacyXml(decodeLegacyText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)])));
  assert.equal(parsed.name, 'ac:root'); assert.equal(parsed.attributes['ri:id'], 'A&B'); assert.equal(parsed.attributes.zero, '001');
  assert.equal(parsed.children[0].text, cdata); assert.equal(parsed.children[1].text, ' 앞 < 😀 \r 뒤 '); assert.equal(parsed.text, '');
  const encoded = xml.replace('UTF-8', 'UTF-16');
  for (const bytes of [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(encoded, 'utf16le')]), utf16be(encoded)]) assert.equal(parseLegacyXml(decodeLegacyText(bytes)).children[0].text, cdata);
  assert.equal(parseLegacyXml('<r>a<![CDATA[b\r\nc]]><x>child</x>d&amp;e</r>').text, 'ab\r\ncd&e');
  const safe = parseLegacyXml('<__proto__ constructor="literal" toString="value"/>'); assert.equal(safe.name, '__proto__'); assert.equal(safe.attributes.constructor, 'literal'); assert.equal(Object.getPrototypeOf(safe.attributes), null);
});

test('decoding rejects invalid bytes, unpaired surrogates, missing UTF-16 BOM and contradictory or unsupported declarations', () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xff, 0xfe, 0x3c]), Buffer.from([0xff, 0xfe, 0, 0xd8]), Buffer.from('<r/>', 'utf16le'), Buffer.from([0, 0, 0xfe, 0xff, 0, 0, 0, 0x3c]), Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r/>'), Buffer.from('<?xml version="1.0" encoding="UTF-16"?><r/>'), utf16be('<?xml version="1.0" encoding="UTF-16LE"?><r/>'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?xml version="1.0" encoding="UTF-8"?><r/>', 'utf16le')])]) assert.throws(() => decodeLegacyText(bytes), isArchiveError());
  assert.equal(decodeLegacyText(Buffer.from('한글 CSV,😀\r\n', 'utf8')), '한글 CSV,😀\r\n');
});

test('XML requires one well-formed root and refuses actual DTD/entities without mistaking comments or CDATA for declarations', () => {
  const allowed = '<!-- <!DOCTYPE not-a-declaration> --><r><![CDATA[<!DOCTYPE literal [<!ENTITY x "text">]> &x;]]></r>';
  assert.equal(parseLegacyXml(allowed).text, '<!DOCTYPE literal [<!ENTITY x "text">]> &x;');
  const invalid = ['', '<a/><b/>', '<r/> trailing', 'outside<r/>', '<r><x></r>', '<r>', '<![CDATA[outside]]><r/>', '<r><![CDATA[open</r>', '<!--open<r/>', '<!--bad--inside--><r/>', '<r a="1" a="2"/>', '<r a="<"/>', '<r a=unquoted/>', '<r / >', '<r>&unknown;</r>', '<r>&amp</r>', '<r>&#0;</r>', '<r>&#xD800;</r>', '<r>&#x110000;</r>', '<r>\ud800</r>', '<r>\udc00</r>', '<r>\u0000</r>', '<r>]]></r>', '<r/><?xml version="1.0"?>', '<?xml version="1.1"?><r/>', '<!DOCTYPE r SYSTEM "http://127.0.0.1:9/never"><r/>', '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>', '<!ENTITY x "raw"><r/>'];
  for (const xml of invalid) assert.throws(() => parseLegacyXml(xml), isArchiveError(), JSON.stringify(xml));
});

test('XML enforces depth, attributes and total node budgets before unbounded tree construction', () => {
  assert.equal(parseLegacyXml('<r>'.repeat(LEGACY_MAX_XML_DEPTH) + '</r>'.repeat(LEGACY_MAX_XML_DEPTH)).name, 'r');
  assert.throws(() => parseLegacyXml('<r>'.repeat(LEGACY_MAX_XML_DEPTH + 1) + '</r>'.repeat(LEGACY_MAX_XML_DEPTH + 1)), isArchiveError(413));
  const attrs = Array.from({ length: LEGACY_MAX_XML_ATTRIBUTES }, (_, i) => ` a${i}="x"`).join('');
  assert.equal(Object.keys(parseLegacyXml(`<r${attrs}/>`).attributes).length, LEGACY_MAX_XML_ATTRIBUTES);
  assert.throws(() => parseLegacyXml(`<r${attrs} extra="x"/>`), isArchiveError(413));
  assert.throws(() => parseLegacyXml(`<r>${'<!--x-->'.repeat(LEGACY_MAX_XML_NODES)}</r>`), isArchiveError(413));
  assert.throws(() => parseLegacyXml(`<r a="${'x'.repeat(1024 * 1024 + 1)}"/>`), isArchiveError(413));
});

test('ZIP central-directory traversal reads stored and deflated bytes exactly and hashes every file without extraction', async () => {
  const xml = Buffer.from('<r><![CDATA[한글\r\nbody]]></r>'), attachment = Buffer.from([0, 1, 2, 255, 99]);
  const archive = await readLegacyArchive(zip([{ name: 'export/', mode: 0o040755 }, { name: 'export/entities.xml', content: xml, method: 8 }, { name: 'export/attachment.bin', content: attachment }]), 'fixture.ZIP');
  assert.deepEqual([...archive.files.keys()], ['export/entities.xml', 'export/attachment.bin']); assert.deepEqual(archive.files.get('export/entities.xml'), xml); assert.deepEqual(archive.files.get('export/attachment.bin'), attachment);
  assert.equal(archive.expandedBytes, xml.length + attachment.length); assert.deepEqual(archive.manifest, [...archive.files].map(([path, content]) => ({ path, size: content.length, sha256: createHash('sha256').update(content).digest('hex') })));
  for (const name of ['direct.xml', 'direct.csv', 'direct.json']) {
    const direct = await readLegacyArchive(xml, name); assert.deepEqual(direct.files.get(name), xml); assert.equal(direct.manifest.length, 1); assert.equal(direct.expandedBytes, xml.length);
  }
  assert.equal((await readLegacyArchive(zip([]), 'empty.zip')).files.size, 0);
});

test('ZIP rejects traversal, ambiguous paths, case or Unicode collisions, symlinks, encryption and unsupported compression', async () => {
  for (const name of ['../escape.xml', 'a/../escape.xml', '/absolute.xml', 'C:/drive.xml', 'C:drive.xml', 'a\\escape.xml', 'a//b.xml', './a.xml', 'a\u0000b.xml']) await assert.rejects(readLegacyArchive(zip([{ name }]), 'fixture.zip'), isArchiveError(), name);
  const invalid: ZipEntry[][] = [
    [{ name: 'same.xml' }, { name: 'same.xml' }], [{ name: 'File.xml' }, { name: 'file.XML' }], [{ name: 'é.xml' }, { name: 'e\u0301.xml' }],
    [{ name: 'a' }, { name: 'a/b.xml' }], [{ name: 'a/b.xml' }, { name: 'a' }], [{ name: 'a/' , mode: 0o040755 }, { name: 'a' }],
    [{ name: 'link.xml', mode: 0o120777, content: Buffer.from('/etc/passwd') }], [{ name: 'fifo', mode: 0o010600 }],
    [{ name: 'encrypted.xml', flags: 0x801 }], [{ name: 'strong.xml', flags: 0x840 }], [{ name: 'unknown.xml', method: 99 }],
    [{ name: 'folder/', mode: 0o040755, content: Buffer.from('hidden') }], [{ name: 'invalid.xml', nameBytes: Buffer.from([0xc3, 0x28]), flags: 0x800 }],
  ];
  for (const entries of invalid) await assert.rejects(readLegacyArchive(zip(entries), 'fixture.zip'), isArchiveError());
  await assert.rejects(readLegacyArchive(Buffer.from('data'), '../direct.csv'), isArchiveError());
  await assert.rejects(readLegacyArchive(Buffer.from('data'), 'unsupported.txt'), isArchiveError());
});

test('ZIP verifies actual CRC, decompressed sizes and corruption instead of trusting central-directory metadata', async () => {
  await assert.rejects(readLegacyArchive(zip([{ name: 'crc.xml', content: Buffer.from('actual'), checksum: 0 }]), 'fixture.zip'), isArchiveError());
  await assert.rejects(readLegacyArchive(zip([{ name: 'size.xml', method: 8, content: Buffer.from('actual content'), declaredSize: 1 }]), 'fixture.zip'), isArchiveError());
  await assert.rejects(readLegacyArchive(zip([{ name: 'short.xml', method: 8, content: Buffer.from('actual'), declaredSize: 99 }]), 'fixture.zip'), isArchiveError());
  await assert.rejects(readLegacyArchive(zip([{ name: 'deflate.xml', method: 8, compressed: Buffer.from([255, 255, 255]), declaredSize: 20 }]), 'fixture.zip'), isArchiveError());
  const badLocal = zip([{ name: 'bad.xml' }]); badLocal.writeUInt32LE(0, 0); await assert.rejects(readLegacyArchive(badLocal, 'fixture.zip'), isArchiveError());
  const truncated = zip([{ name: 'truncated.xml', content: Buffer.from('content') }]).subarray(0, -10); await assert.rejects(readLegacyArchive(truncated, 'fixture.zip'), isArchiveError());
});

test('archive size and entry caps reject raw and declared expansion bombs before decompression', async () => {
  const oversized = Buffer.alloc(LEGACY_MAX_RAW_BYTES + 1);
  await assert.rejects(readLegacyArchive(oversized, 'raw.zip'), isArchiveError(413));
  assert.throws(() => decodeLegacyText(oversized), isArchiveError(413));
  await assert.rejects(readLegacyArchive(zip([{ name: 'large.xml', method: 8, declaredSize: LEGACY_MAX_FILE_BYTES + 1 }]), 'fixture.zip'), isArchiveError(413));
  const totalBomb = Array.from({ length: LEGACY_MAX_EXPANDED_BYTES / LEGACY_MAX_FILE_BYTES + 1 }, (_, i) => ({ name: `declared-${i}.xml`, method: 8, declaredSize: LEGACY_MAX_FILE_BYTES }));
  await assert.rejects(readLegacyArchive(zip(totalBomb), 'fixture.zip'), isArchiveError(413));
  await assert.rejects(readLegacyArchive(zip(Array.from({ length: LEGACY_MAX_FILES + 1 }, (_, i) => ({ name: `many-${i}.xml` }))), 'fixture.zip'), isArchiveError(413));
});
