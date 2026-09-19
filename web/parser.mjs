// Browser/Node-compatible ISO BMFF adapter. Reads bounded slices, never the entire video.
const CONTAINERS = new Set('moov trak mdia minf stbl edts dinf mvex moof traf mfra udta ilst'.split(' '));
const VIDEO = new Set('avc1 avc3 hvc1 hev1 vp09 av01 mp4v jpeg apch apcn apcs apco ap4h'.split(' '));
const AUDIO = new Set(['mp4a', 'sowt', 'twos', 'lpcm', 'alac', 'ac-3', 'ec-3', 'Opus']);
const FULL = new Set('mvhd tkhd mdhd hdlr stsd stts ctts stsc stsz stco co64 stss elst dref vmhd smhd nmhd mfhd tfhd tfdt trun trex sidx'.split(' ').concat(['url ', 'urn ']));
const MAX_BOXES = 50000;
export const TABLE_PAGE = 32;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const fourcc = bytes => Array.from(bytes, b => b >= 32 && b <= 126 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`).join('');

export async function readBytes(file, start, length) {
  assert(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && start + length <= file.size, `Read outside file at byte ${start}`);
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  assert(bytes.length === length, `Truncated read at byte ${start}`);
  return bytes;
}

function safe64(view, offset) {
  const value = view.getBigUint64(offset);
  assert(value <= BigInt(Number.MAX_SAFE_INTEGER), '64-bit offset exceeds the exact integer range supported by this browser');
  return Number(value);
}

export async function parseFile(file, { signal, onProgress } = {}) {
  assert(file.size >= 8, 'This file is too short to contain an MP4 or MOV box header.');
  const result = { file, roots: [], boxes: [], warnings: [], tracks: [], format: 'MP4 / MOV', complete: true };
  const check = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  function warning(message, box) {
    result.warnings.push({ message, boxId: box?.id ?? null, offset: box?.offset ?? null });
    if (box) box.warnings.push(message);
    result.complete = false;
  }
  async function walk(start, end, parent, depth) {
    assert(depth <= 48, 'Nesting exceeds the exploration limit of 48 levels');
    const children = [];
    let offset = start;
    while (offset < end) {
      check();
      try {
        assert(result.boxes.length < MAX_BOXES, `Exploration stopped at ${MAX_BOXES.toLocaleString()} boxes`);
        assert(end - offset >= 8, `${end - offset} trailing bytes cannot form a box header at byte ${offset}`);
        const head = await readBytes(file, offset, Math.min(32, end - offset));
        const view = new DataView(head.buffer);
        const size32 = view.getUint32(0);
        const type = fourcc(head.subarray(4, 8));
        let headerSize = size32 === 1 ? 16 : 8;
        assert(head.length >= headerSize, `Truncated extended header at byte ${offset}`);
        const size = size32 === 1 ? safe64(view, 8) : size32 === 0 ? file.size - offset : size32;
        if (type === 'uuid') headerSize += 16;
        assert(size >= headerSize, `${type} at byte ${offset} is smaller than its ${headerSize}-byte header`);
        assert(Number.isSafeInteger(offset + size) && offset + size <= end, `${type} at byte ${offset} extends beyond ${parent ? 'its parent' : 'the file'}`);
        const box = { id: result.boxes.length, type, offset, size, headerSize, end: offset + size, depth, parent, children: [], fields: [], warnings: [], table: null, values: {} };
        children.push(box);
        result.boxes.push(box);
        box.fields.push({ name: 'Box size', offset, length: 4, value: size32 === 1 ? '1 → extended size follows' : size32 === 0 ? '0 → extends to end of file' : size32, encoding: 'uint32 · big-endian', description: 'Total bytes, including the header.' });
        box.fields.push({ name: 'Box type', offset: offset + 4, length: 4, value: type, encoding: 'four-character code', description: 'Identifies the structure of the contents.' });
        if (size32 === 1) box.fields.push({ name: 'Extended size', offset: offset + 8, length: 8, value: size, encoding: 'uint64 · big-endian', description: 'The actual total size of the box.' });
        if (type === 'uuid') box.fields.push({ name: 'Extended type', offset: offset + headerSize - 16, length: 16, value: Array.from(head.slice(headerSize - 16, headerSize), b => b.toString(16).padStart(2, '0')).join(''), encoding: '128-bit identifier', description: 'Identifies the user-defined box format.' });
        let childStart = null;
        try {
          childStart = await decode(file, box);
        } catch (error) { warning(`${type}: ${error.message}`, box); }
        if (childStart !== null) {
          try { box.children = await walk(childStart, box.end, box, depth + 1); }
          catch (error) { if (error.name === 'AbortError') throw error; warning(error.message, box); }
        }
        if (['stsd', 'dref'].includes(type) && box.values.entryCount !== undefined && box.children.length !== box.values.entryCount) warning(`${type}: declared entry count does not match parsed children`, box);
        offset = box.end;
        if (result.boxes.length % 100 === 0) { onProgress?.(result.boxes.length); await new Promise(resolve => setTimeout(resolve, 0)); }
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        warning(error.message, parent);
        break;
      }
    }
    return children;
  }
  result.roots = await walk(0, file.size, null, 0);
  check();
  const recognized = result.roots.some(b => ['ftyp', 'moov', 'mdat', 'moof', 'styp'].includes(b.type));
  assert(recognized, 'No recognizable MP4 or MOV structure found. Choose an MP4 or MOV file; changing a file extension does not change its format.');
  const ftyp = result.roots.find(b => b.type === 'ftyp');
  result.format = ftyp?.values.majorBrand === 'qt  ' ? 'QuickTime / MOV' : ftyp ? 'ISO BMFF / MP4' : 'QuickTime / MOV (no ftyp)';
  const movie = result.boxes.find(b => b.type === 'mvhd');
  result.duration = movie?.values.seconds ?? null;
  result.fragmented = result.boxes.some(b => b.type === 'moof' || b.type === 'mvex');
  if (!result.boxes.some(b => b.type === 'moov')) warning('No movie metadata (moov) found. This may be a media segment or an incomplete file.');
  for (const track of result.boxes.filter(b => b.type === 'trak')) {
    const descendants = result.boxes.filter(b => { for (let p = b.parent; p; p = p.parent) if (p === track) return true; return false; });
    const get = type => descendants.find(b => b.type === type);
    const tkhd = get('tkhd'), mdhd = get('mdhd'), hdlr = get('hdlr'), stsd = get('stsd'), stsz = get('stsz');
    result.tracks.push({ box: track, id: tkhd?.values.trackId ?? '?', handler: hdlr?.values.handler ?? 'unknown', codec: stsd?.children[0]?.type ?? 'unknown', duration: mdhd?.values.seconds ?? null, timescale: mdhd?.values.timescale, width: tkhd?.values.width, height: tkhd?.values.height, samples: stsz?.values.sampleCount, descendants });
  }
  return result;
}

async function decode(file, box) {
  const base = box.offset + box.headerSize;
  const length = box.size - box.headerSize;
  const data = await readBytes(file, base, Math.min(length, 256));
  const v = new DataView(data.buffer);
  const need = (offset, size) => assert(offset + size <= data.length, `Truncated field at byte ${base + offset}`);
  const num = (offset, size = 4, signed = false) => { need(offset, size); return size === 8 ? (signed ? v.getBigInt64(offset) : v.getBigUint64(offset)).toString() : size === 4 ? (signed ? v.getInt32(offset) : v.getUint32(offset)) : size === 2 ? v.getUint16(offset) : v.getUint8(offset); };
  const text = (offset, size = 4) => { need(offset, size); return fourcc(data.subarray(offset, offset + size)); };
  const field = (name, offset, size, value, encoding, description) => { need(offset, size); box.fields.push({ name, offset: base + offset, length: size, value, encoding, description }); return value; };
  const integer = (name, offset, size = 4, description = '', signed = false) => field(name, offset, size, num(offset, size, signed), `${signed ? 'int' : 'uint'}${size * 8} · big-endian`, description);
  let version = 0;
  if (FULL.has(box.type)) {
    version = integer('Version', 0, 1, 'Controls the layout and widths of some fields.');
    field('Flags', 1, 3, `0x${Array.from(data.subarray(1, 4), b => b.toString(16).padStart(2, '0')).join('')}`, '24-bit bitfield', 'Flags select optional behavior or fields.');
  }
  function timing(kind) {
    assert(version === 0 || version === 1, `Unsupported ${kind} version ${version}`);
    const wide = version === 1, width = wide ? 8 : 4;
    integer('Creation time', 4, width, 'Seconds since 1904-01-01 UTC.');
    integer('Modification time', 4 + width, width, 'Seconds since 1904-01-01 UTC.');
    const tsOffset = 4 + width * 2;
    const timescale = integer('Timescale', tsOffset, 4, 'The number of time units (ticks) per second.');
    const duration = integer('Duration', tsOffset + 4, width, 'Duration in this header’s timescale. All-one bits mean unspecified.');
    const unknown = BigInt(duration) === (1n << BigInt(width * 8)) - 1n;
    box.values = { timescale, duration, seconds: timescale && !unknown ? Number(duration) / timescale : null };
    if (!timescale) box.warnings.push('Timescale is zero; duration cannot be converted to seconds.');
  }
  function table(columns, offset, count, rowSize) {
    assert(Number.isSafeInteger(count * rowSize) && offset + count * rowSize <= length, `Table declares ${count} entries but its payload is too short`);
    box.table = { columns, offset: base + offset, count, rowSize };
  }
  switch (box.type) {
    case 'ftyp': case 'styp': {
      box.values.majorBrand = field('Major brand', 0, 4, text(0), 'four-character code', 'Primary container compatibility declaration.');
      integer('Minor version', 4, 4, 'Brand-specific revision number.');
      assert(length >= 8 && (length - 8) % 4 === 0, 'Compatible brands must contain complete four-byte codes');
      for (let i = 8; i + 4 <= data.length; i += 4) field(`Compatible brand ${(i - 8) / 4 + 1}`, i, 4, text(i), 'four-character code', 'Another container specification this file supports.');
      if (length > data.length) box.warnings.push('Only the first 62 compatible brands are decoded.');
      break;
    }
    case 'mvhd': case 'mdhd': timing(box.type); break;
    case 'tkhd': {
      assert(version <= 1, `Unsupported track header version ${version}`);
      const wide = version === 1;
      box.values.trackId = integer('Track ID', wide ? 20 : 12, 4, 'Unique identifier within this movie.');
      box.values.duration = integer('Track duration', wide ? 28 : 20, wide ? 8 : 4, 'Uses the movie timescale in mvhd, not the media timescale.');
      box.values.width = field('Display width', wide ? 88 : 76, 4, Number(num(wide ? 88 : 76)) / 65536, 'unsigned 16.16 fixed-point', 'Presentation width before the track matrix is applied.');
      box.values.height = field('Display height', wide ? 92 : 80, 4, Number(num(wide ? 92 : 80)) / 65536, 'unsigned 16.16 fixed-point', 'Presentation height before the track matrix is applied.');
      break;
    }
    case 'hdlr':
      box.values.handler = field('Handler type', 8, 4, text(8), 'four-character code', 'vide = video; soun = audio; text/subt = text or subtitles.');
      break;
    case 'stsd': case 'dref':
      box.values.entryCount = integer('Entry count', 4, 4, 'Number of entries following this header.');
      return base + 8;
    case 'url ': case 'urn ':
      box.values.selfContained = !!(num(3, 1) & 1);
      break;
    case 'stsz': {
      const fixed = integer('Sample size', 4, 4, 'Nonzero means every sample has this fixed size in bytes.');
      const count = integer('Sample count', 8, 4, 'Total number of samples described by this table.');
      box.values = { sampleSize: fixed, sampleCount: count };
      if (!fixed) table([{ name: 'Sample size', size: 4, suffix: ' B' }], 12, count, 4);
      break;
    }
    case 'stco': case 'co64': case 'stss': case 'stts': case 'ctts': case 'stsc': {
      assert(version === 0 || (box.type === 'ctts' && version === 1), `Unsupported table version ${version}`);
      const count = integer('Entry count', 4, 4, 'Number of table rows stored in this box.');
      const columns = box.type === 'stco' || box.type === 'co64' ? [{ name: 'Chunk offset', size: box.type === 'co64' ? 8 : 4, link: true }] :
        box.type === 'stss' ? [{ name: 'Sync sample number', size: 4 }] :
        box.type === 'stsc' ? [{ name: 'First chunk', size: 4 }, { name: 'Samples / chunk', size: 4 }, { name: 'Description ID', size: 4 }] :
        [{ name: 'Sample count', size: 4 }, { name: box.type === 'ctts' ? 'Composition offset' : 'Sample delta', size: 4, signed: box.type === 'ctts' && version === 1 }];
      table(columns, 8, count, columns.reduce((sum, col) => sum + col.size, 0));
      break;
    }
    case 'elst': {
      assert(version <= 1, `Unsupported edit list version ${version}`);
      const count = integer('Entry count', 4);
      const size = version ? 8 : 4;
      table([{ name: 'Segment duration', size }, { name: 'Media time', size, signed: true }, { name: 'Media rate', size: 4, fixed: true }], 8, count, size * 2 + 4);
      break;
    }
    case 'mfhd': integer('Sequence number', 4); break;
    case 'tfhd': integer('Track ID', 4); break;
    case 'tfdt':
      assert(version <= 1, `Unsupported decode time version ${version}`);
      integer('Base decode time', 4, version ? 8 : 4, 'Decoding time of the first sample in this fragment.'); break;
    case 'trun': integer('Sample count', 4); break;
    case 'meta': {
      if (length === 0) return base;
      need(0, 4);
      if (num(0) === 0) { field('Version and flags', 0, 4, '0x00000000', 'FullBox prefix', 'ISO metadata header prefix before child boxes.'); return base + 4; }
      return base; // QuickTime metadata may begin immediately with a child atom.
    }
    case 'cmov': box.warnings.push('Compressed QuickTime metadata is not expanded.'); break;
  }
  if (VIDEO.has(box.type) && box.parent?.type === 'stsd') {
    box.values.dataReferenceIndex = integer('Data reference index', 6, 2, 'Selects an entry in dref.');
    integer('Encoded width', 24, 2, 'Width of encoded video samples in pixels.');
    integer('Encoded height', 26, 2, 'Height of encoded video samples in pixels.');
    assert(length >= 78, 'Visual sample entry is shorter than 78 bytes');
    return base + 78;
  }
  if (AUDIO.has(box.type) && box.parent?.type === 'stsd') {
    box.values.dataReferenceIndex = integer('Data reference index', 6, 2, 'Selects an entry in dref.');
    const audioVersion = integer('Audio entry version', 8, 2, 'QuickTime version 1 or 2 adds fields to the base layout.');
    if (audioVersion <= 1) {
      integer('Channel count', 16, 2, 'Base sample-entry channel count; codec configuration can refine this.');
      integer('Sample size', 18, 2, 'Base sample-entry bit depth.');
      field('Sample rate', 24, 4, Number(num(24)) / 65536, 'unsigned 16.16 fixed-point', 'Base sample-entry sample rate in Hz.');
    }
    const prefix = audioVersion === 0 ? 28 : audioVersion === 1 ? 44 : audioVersion === 2 ? 64 : null;
    assert(prefix !== null && length >= prefix, 'Unsupported or truncated audio sample entry');
    if (audioVersion === 2) box.warnings.push('QuickTime version 2 audio fields are not decoded; child boxes and raw bytes remain available.');
    return base + prefix;
  }
  return CONTAINERS.has(box.type) ? base : null;
}

export async function readTable(file, box, page = 0) {
  const table = box.table;
  assert(table && Number.isInteger(page) && page >= 0, 'Invalid table page');
  const start = page * TABLE_PAGE;
  assert(start < table.count || (start === 0 && table.count === 0), 'Table page is out of range');
  const count = Math.min(TABLE_PAGE, table.count - start);
  const bytes = await readBytes(file, table.offset + start * table.rowSize, count * table.rowSize);
  const view = new DataView(bytes.buffer);
  return Array.from({ length: count }, (_, row) => {
    let relative = row * table.rowSize;
    return { index: start + row + 1, cells: table.columns.map(col => {
      const offset = table.offset + start * table.rowSize + relative;
      const value = col.size === 8 ? (col.signed ? view.getBigInt64(relative) : view.getBigUint64(relative)).toString() : col.signed || col.fixed ? view.getInt32(relative) : view.getUint32(relative);
      relative += col.size;
      return { ...col, value: col.fixed ? Number(value) / 65536 : value, offset, length: col.size };
    }) };
  });
}

export function boxAt(result, offset) {
  let found = null;
  for (const box of result.boxes) if (offset >= box.offset && offset < box.end && (!found || box.depth > found.depth)) found = box;
  return found;
}

export function exportReport(result) {
  return { name: result.file.name || 'media file', size: result.file.size, format: result.format, complete: result.complete, warnings: result.warnings, boxes: result.boxes.map(({ parent, children, ...box }) => ({ ...box, parent: parent?.id ?? null, children: children.map(child => child.id) })) };
}

// Resolve a sample through the classic sample tables. Table reads remain bounded.
export async function traceSample(result, track, sampleNumber, { signal } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  check();
  assert(!result.fragmented, 'Sample tracing currently supports classic sample tables, not movie fragments.');
  assert(Number.isSafeInteger(sampleNumber) && sampleNumber >= 1, 'Enter a sample number starting at 1.');
  const find = type => track.descendants.find(box => box.type === type);
  const stsz = find('stsz'), stsc = find('stsc'), offsets = find('stco') || find('co64');
  assert(stsz && stsc?.table && offsets?.table, 'This track needs stsz, stsc, and stco/co64 tables for sample tracing.');
  assert(sampleNumber <= stsz.values.sampleCount, `This track contains ${stsz.values.sampleCount} samples.`);
  const row = async (box, index) => {
    check();
    const rows = await readTable(result.file, box, Math.floor(index / TABLE_PAGE));
    return rows[index % TABLE_PAGE].cells.map(cell => Number(cell.value));
  };
  let firstSample = 1, chunk = 0, withinChunk = 0, description = 0, mappingRow = 0;
  let previous = null;
  for (let page = 0; page < Math.ceil(stsc.table.count / TABLE_PAGE); page++) {
    check();
    const rows = await readTable(result.file, stsc, page);
    for (const entry of rows) {
      const values = entry.cells.map(cell => Number(cell.value));
      assert(values[0] >= 1 && values[0] <= offsets.table.count && values[1] > 0 && values[2] > 0, 'Invalid sample-to-chunk mapping.');
      if (!previous) assert(values[0] === 1, 'The sample-to-chunk table must begin with chunk 1.');
      if (previous) {
        assert(values[0] > previous.values[0], 'Sample-to-chunk entries are not strictly increasing.');
        const samplesInRun = (values[0] - previous.values[0]) * previous.values[1];
        assert(Number.isSafeInteger(samplesInRun + firstSample), 'Sample mapping exceeds the exact integer range.');
        if (sampleNumber < firstSample + samplesInRun) {
          chunk = previous.values[0] + Math.floor((sampleNumber - firstSample) / previous.values[1]);
          withinChunk = (sampleNumber - firstSample) % previous.values[1];
          description = previous.values[2]; mappingRow = previous.index; break;
        }
        firstSample += samplesInRun;
      }
      previous = { values, index: entry.index };
    }
    if (chunk) break;
  }
  if (!chunk && previous) {
    chunk = previous.values[0] + Math.floor((sampleNumber - firstSample) / previous.values[1]);
    withinChunk = (sampleNumber - firstSample) % previous.values[1];
    description = previous.values[2]; mappingRow = previous.index;
  }
  assert(chunk >= 1 && chunk <= offsets.table.count, 'Sample falls outside the available chunks.');
  const sampleEntry = find('stsd')?.children[description - 1];
  const dataReference = find('dref')?.children[(sampleEntry?.values.dataReferenceIndex ?? 0) - 1];
  assert(dataReference?.values.selfContained === true, 'The selected sample description does not declare supported in-file media. External references are not followed.');
  const chunkOffset = (await row(offsets, chunk - 1))[0];
  assert(Number.isSafeInteger(chunkOffset), 'Chunk offset exceeds the exact integer range.');
  let bytesBefore = 0, sampleSize = stsz.values.sampleSize;
  if (sampleSize) bytesBefore = withinChunk * sampleSize;
  else {
    assert(stsz.table, 'The sample-size table is unavailable.');
    const firstIndex = sampleNumber - 1 - withinChunk, lastIndex = sampleNumber - 1;
    for (let page = Math.floor(firstIndex / TABLE_PAGE); page <= Math.floor(lastIndex / TABLE_PAGE); page++) {
      check();
      const rows = await readTable(result.file, stsz, page);
      for (const entry of rows) if (entry.index - 1 >= firstIndex && entry.index - 1 <= lastIndex) {
        if (entry.index === sampleNumber) sampleSize = Number(entry.cells[0].value);
        else bytesBefore += Number(entry.cells[0].value);
      }
    }
  }
  const offset = chunkOffset + bytesBefore;
  assert(Number.isSafeInteger(offset + sampleSize), 'Sample position exceeds the exact integer range.');
  const media = boxAt(result, offset);
  assert(media?.type === 'mdat' && offset >= media.offset + media.headerSize && offset + sampleSize <= media.end, 'The resolved sample does not fit inside an mdat payload.');
  return { sampleNumber, chunk, withinChunk: withinChunk + 1, chunkOffset, bytesBefore, offset, sampleSize, mappingRow, description };
}

// New formats can implement this same parse/fields/table contract without changing the UI.
export const formats = [{ id: 'isobmff', label: 'MP4 / MOV', extensions: ['mp4', 'mov', 'm4v', 'm4a', 'qt'], parse: parseFile }];
