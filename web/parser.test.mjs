import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFile, readTable, boxAt, exportReport, traceSample } from './parser.mjs';

const u32 = n => { const out = Buffer.alloc(4); out.writeUInt32BE(n); return out; };
const u64 = n => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(n)); return out; };
const box = (type, ...parts) => { const payload = Buffer.concat(parts); return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'latin1'), payload]); };
const file = (...parts) => new File(parts, 'fixture.mov');
const ftyp = () => box('ftyp', Buffer.from('qt  '), u32(0), Buffer.from('qt  '));

test('real sample: discovers tracks, codecs, timing, and chunk-to-media links', async () => {
  const bytes = await readFile(new URL('../sample/vid_s_01.mp4', import.meta.url));
  const result = await parseFile(file(bytes));
  assert.equal(result.complete, true);
  assert.equal(result.duration, 10);
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(result.tracks.map(t => t.codec), ['avc1', 'mp4a']);
  assert.deepEqual(result.tracks.map(t => t.handler), ['vide', 'soun']);
  const offsets = result.boxes.find(b => b.type === 'stco');
  const page = await readTable(result.file, offsets);
  assert.equal(page.length, 32);
  assert.equal(boxAt(result, Number(page[0].cells[0].value)).type, 'mdat');
  const second = await readTable(result.file, offsets, 1);
  assert.equal(second[0].index, 33);
  assert.ok(JSON.stringify(exportReport(result)).includes('avc1'));
  const firstVideo = await traceSample(result, result.tracks[0], 1);
  assert.equal(firstVideo.offset, Number(page[0].cells[0].value));
  assert.ok(firstVideo.sampleSize > 0);
  const lastVideo = await traceSample(result, result.tracks[0], result.tracks[0].samples);
  assert.equal(boxAt(result, lastVideo.offset).type, 'mdat');
  const firstAudio = await traceSample(result, result.tracks[1], 1);
  const secondAudio = await traceSample(result, result.tracks[1], 2);
  assert.ok(secondAudio.offset > firstAudio.offset);
  await assert.rejects(() => traceSample(result, result.tracks[0], 0), /starting at 1/);
  await assert.rejects(() => traceSample(result, result.tracks[0], result.tracks[0].samples + 1), /contains/);
});

test('MOV without ftyp and QuickTime meta without a FullBox prefix', async () => {
  const result = await parseFile(file(box('moov', box('udta', box('meta', box('free')))), box('mdat')));
  assert.equal(result.format, 'QuickTime / MOV (no ftyp)');
  assert.equal(result.complete, true);
  assert.equal(result.boxes.find(b => b.type === 'meta').children[0].type, 'free');
});

test('ISO meta prefix and extended-size container start children at the right offset', async () => {
  const child = box('meta', u32(0), box('free'));
  const extended = Buffer.concat([u32(1), Buffer.from('moov'), u64(16 + child.length), child]);
  const result = await parseFile(file(ftyp(), extended));
  const moov = result.roots[1];
  assert.equal(moov.headerSize, 16);
  assert.equal(moov.children[0].offset, moov.offset + 16);
  assert.equal(moov.children[0].children[0].type, 'free');
});

test('zero-size boxes extend to EOF; extended size zero is rejected', async () => {
  const zero = Buffer.concat([u32(0), Buffer.from('mdat'), Buffer.alloc(100)]);
  const result = await parseFile(file(ftyp(), box('moov'), zero));
  assert.equal(result.roots.at(-1).size, 108);
  assert.equal(result.complete, true);
  const invalid = await parseFile(file(ftyp(), u32(1), Buffer.from('mdat'), u64(0)));
  assert.match(invalid.warnings[0].message, /smaller/);
});

test('malformed sizes and truncated tables are reported while valid boxes remain inspectable', async () => {
  const result = await parseFile(file(ftyp(), box('moov', box('stco', u32(0), u32(1000), u32(8))), box('mdat')));
  assert.equal(result.complete, false);
  assert.match(result.warnings[0].message, /payload is too short/);
  assert.equal(result.roots.at(-1).type, 'mdat');
  const childPastParent = await parseFile(file(ftyp(), box('moov', u32(80), Buffer.from('free')), box('mdat')));
  assert.match(childPastParent.warnings[0].message, /beyond its parent/);
  const nestedZero = await parseFile(file(ftyp(), box('moov', u32(0), Buffer.from('free')), box('mdat')));
  assert.match(nestedZero.warnings[0].message, /beyond its parent/);
});

test('64-bit timing, signed composition offsets and extended UUID headers', async () => {
  const version1 = Buffer.from([1, 0, 0, 0]);
  const duration = 4294967396n;
  const mdhd = box('mdhd', version1, u64(0), u64(0), u32(1000), u64(duration));
  const ctts = box('ctts', version1, u32(1), u32(2), u32(0xfffffffe));
  const result = await parseFile(file(ftyp(), box('moov', mdhd, ctts), box('uuid', Buffer.alloc(16), Buffer.alloc(4))));
  assert.equal(result.boxes.find(b => b.type === 'mdhd').values.duration, duration.toString());
  const rows = await readTable(result.file, result.boxes.find(b => b.type === 'ctts'));
  assert.equal(rows[0].cells[1].value, -2);
  assert.equal(result.roots.at(-1).headerSize, 24);
});

test('hostile nesting is bounded, unrecognized files fail clearly, and cancellation is supported', async () => {
  let nested = box('free');
  for (let i = 0; i < 60; i++) nested = box('moov', nested);
  const result = await parseFile(file(nested));
  assert.ok(result.boxes.length <= 49);
  assert.match(result.warnings[0].message, /Nesting/);
  await assert.rejects(() => parseFile(file(Buffer.from('not a media file'))), /No recognizable/);
  await assert.rejects(() => parseFile(file(Buffer.alloc(2))), /too short/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => parseFile(file(ftyp()), { signal: controller.signal }), { name: 'AbortError' });
});

test('large media payloads are skipped and headers are read in bounded slices', async () => {
  const virtualSize = 5 * 1024 ** 3;
  const header = Buffer.concat([u32(1), Buffer.from('mdat'), u64(virtualSize)]);
  let maxRead = 0;
  const virtualFile = { size: virtualSize, name: 'large.mov', slice(start, end) {
    maxRead = Math.max(maxRead, end - start);
    assert.ok(end - start <= 256);
    const data = Buffer.alloc(end - start);
    if (start === 0) header.copy(data);
    return new Blob([data]);
  } };
  const result = await parseFile(virtualFile);
  assert.equal(result.roots[0].size, virtualSize);
  assert.ok(maxRead <= 256);
});
