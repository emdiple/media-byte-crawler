import { formats, readBytes, readTable, boxAt, exportReport, traceSample, TABLE_PAGE } from './parser.mjs';
import { describe, lessons } from './knowledge.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pretty = value => Number(value).toLocaleString('en-US');
const hex = value => `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
const bytesLabel = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(2)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
const secondsLabel = value => value == null ? 'Unknown' : `${Number(value).toFixed(2)} s`;
let result = null, selected = null, selection = null, byteOffset = 0, hexStart = 0, tablePage = 0;
let collapsed = new Set(), controller, generation = 0, viewGeneration = 0, hexGeneration = 0, previewURL;

function status(message, error = false) { $('#status').textContent = message; $('#status').classList.toggle('error', error); }
function reportError(error) { if (error.name !== 'AbortError') status(error.message, true); }
function run(task) { Promise.resolve().then(task).catch(reportError); }

async function openFile(file, sample = false) {
  controller?.abort();
  controller = new AbortController();
  const current = ++generation;
  status(`Reading ${file.name}…`);
  $('#drop-zone').classList.add('busy');
  try {
    const parsed = await formats[0].parse(file, { signal: controller.signal, onProgress: count => { if (current === generation) status(`Exploring ${pretty(count)} boxes…`); } });
    if (current !== generation) return;
    result = parsed;
    selected = null; selection = null; collapsed = new Set();
    $('#box-search').value = '';
    $('#jump-offset').value = '';
    $('#expand-button').textContent = 'Collapse all';
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(file);
    $('#file-name').textContent = file.name;
    $('#file-subtitle').textContent = `${result.format} · ${pretty(file.size)} bytes · ${sample ? 'Bundled learning sample' : 'Local file · never uploaded'}`;
    $('#export-button').disabled = false;
    status(`${sample ? 'Sample ready.' : 'File ready.'} ${pretty(result.boxes.length)} boxes explored${result.warnings.length ? ` · ${result.warnings.length} parsing notice(s)` : ''}. Select a box to follow its bytes.`);
    renderMetrics(); renderMap(); renderTree(); renderTracks(); renderLearn(); renderWarnings();
    switchTab('inspect');
    await selectBox(result.roots[0].id);
  } catch (error) {
    if (current === generation) {
      status(`${error.message}${result ? ' The previous file is still open.' : ''}`, true);
    }
  } finally { if (current === generation) $('#drop-zone').classList.remove('busy'); }
}

async function sample() {
  status('Opening the bundled sample…');
  const response = await fetch('/sample.mp4');
  if (!response.ok) throw new Error('Could not load the sample. You can still open a local file.');
  await openFile(new File([await response.blob()], 'vid_s_01.mp4', { type: 'video/mp4' }), true);
}

function renderMetrics() {
  const media = result?.boxes.filter(box => box.type === 'mdat').reduce((sum, box) => sum + box.size - box.headerSize, 0) ?? 0;
  const stats = result ? [
    ['FILE SIZE', bytesLabel(result.file.size), `${pretty(result.file.size)} bytes to explore`, '↗'],
    ['DURATION', secondsLabel(result.duration), result.fragmented ? 'Movie header · fragmented file' : 'From the movie header', '◷'],
    ['TRACKS', `${result.tracks.length}`.padStart(2, '0'), result.tracks.map(track => track.handler === 'vide' ? 'Video' : track.handler === 'soun' ? 'Audio' : track.handler).join(' · ') || 'No tracks found', '≋'],
    ['BOXES DISCOVERED', pretty(result.boxes.length), `${(media / result.file.size * 100).toFixed(1)}% encoded media payload`, '▧'],
  ] : [['FILE SIZE', '—', 'Open a file to begin', '↗'], ['DURATION', '—', 'Time, measured in ticks', '◷'], ['TRACKS', '—', 'Separate streams of media', '≋'], ['BOXES DISCOVERED', '—', 'Every box has a purpose', '▧']];
  $('#metrics').innerHTML = stats.map(([label, value, note, icon]) => `<div class="metric"><div class="metric-label">${esc(label)}<span>${icon}</span></div><div class="metric-value">${esc(value)}</div><div class="metric-note">${esc(note)}</div></div>`).join('');
}

function renderMap() {
  if (!result) return;
  $('#file-map').innerHTML = result.roots.map(box => `<button class="map-segment ${describe(box.type).category}" style="width:${box.size / result.file.size * 100}%" data-box="${box.id}" title="${esc(box.type)} · ${pretty(box.size)} bytes · ${hex(box.offset)}" aria-label="Inspect ${esc(box.type)} at byte ${box.offset}">${box.size / result.file.size > .04 ? esc(box.type) : ''}</button>`).join('');
  $('#map-legend').innerHTML = result.roots.map(box => `<button data-box="${box.id}"><span class="dot ${describe(box.type).category}"></span> <strong>${esc(box.type)}</strong> ${bytesLabel(box.size)}</button>`).join('');
}

function renderTree() {
  if (!result) { $('#box-tree').innerHTML = '<p class="loading">Your file’s structure will appear here.</p>'; return; }
  const query = $('#box-search').value.toLowerCase().trim();
  const visible = new Set();
  if (query) for (const box of result.boxes) {
    if (`${box.type} ${describe(box.type).name} ${box.fields.map(field => field.name).join(' ')}`.toLowerCase().includes(query)) {
      for (let node = box; node; node = node.parent) visible.add(node.id);
    }
  }
  const rows = [];
  function walk(nodes) {
    for (const box of nodes) {
      if (query && !visible.has(box.id)) continue;
      const open = query || !collapsed.has(box.id);
      rows.push(`<div class="tree-row ${selected?.id === box.id ? 'active' : ''}" style="padding-left:${9 + box.depth * 14}px"><button class="tree-toggle" data-toggle="${box.id}" ${box.children.length ? `aria-expanded="${!!open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(box.type)}"` : 'disabled aria-hidden="true" tabindex="-1"'}>${box.children.length ? open ? '⌄' : '›' : '·'}</button><button class="tree-select" data-box="${box.id}" aria-label="${esc(box.type)}, ${describe(box.type).name}, ${pretty(box.size)} bytes" ${selected?.id === box.id ? 'aria-current="true"' : ''}><span class="dot ${describe(box.type).category}"></span><code>${esc(box.type)}</code><span class="tree-size">${bytesLabel(box.size)}</span></button></div>`);
      if (open) walk(box.children);
    }
  }
  walk(result.roots);
  $('#box-tree').innerHTML = rows.join('') || '<p class="loading">No matching boxes. Try “track”, “duration”, or “stco”.</p>';
}

async function selectBox(id, preserveHex = false) {
  if (!result) return;
  const box = result.boxes[id];
  if (!box) return;
  selected = box; selection = null; tablePage = 0;
  $('#hex-message').textContent = '';
  for (let parent = box.parent; parent; parent = parent.parent) collapsed.delete(parent.id);
  renderTree(); renderGuide();
  await renderDetail();
  if (selected !== box) return;
  if (!preserveHex) { hexStart = box.offset; byteOffset = box.offset; await renderHex(); }
}

async function renderDetail() {
  const current = ++viewGeneration;
  const box = selected;
  if (!box) return;
  const info = describe(box.type), parents = [];
  for (let node = box.parent; node; node = node.parent) parents.unshift(node);
  $('#box-detail').innerHTML = `<nav class="breadcrumb" aria-label="Box ancestors"><span>file</span>${parents.map(parent => `<span>/</span><button data-box="${parent.id}">${esc(parent.type)}</button>`).join('')}<span>/</span><span>${esc(box.type)}</span></nav>
    <div class="box-title"><span class="box-code">${esc(box.type)}</span><span class="pill">${box.children.length ? 'Container box' : info.category === 'media' ? 'Media payload' : 'Leaf box'}</span></div><h2>${esc(info.name)}</h2><div class="box-subtitle">${box.children.length ? `${box.children.length} child boxes` : 'A closer look at the fields inside'}</div>
    <div class="box-facts"><div><small>START OFFSET</small><strong>${hex(box.offset)}</strong></div><div><small>TOTAL SIZE</small><strong>${pretty(box.size)} bytes</strong></div><div><small>HEADER / PAYLOAD</small><strong>${box.headerSize} / ${pretty(box.size - box.headerSize)} B</strong></div></div>
    <div class="field-heading"><h3>Decoded fields</h3><span>Select a field to trace its bytes ↓</span></div><table class="fields"><thead><tr><th>FIELD / ENCODING</th><th>VALUE</th><th>BYTE RANGE</th></tr></thead><tbody>${box.fields.map((field, index) => `<tr data-field-row="${index}" class="${selection === field ? 'selected' : ''}"><td><button class="field-button" data-field="${index}" title="${esc(field.description)}">${esc(field.name)}<small>${esc(field.encoding)}</small></button></td><td><button class="field-button" data-field="${index}">${esc(field.value)}</button></td><td><button class="field-button" data-field="${index}">${pretty(field.offset)}–${pretty(field.offset + field.length - 1)}</button></td></tr>`).join('')}</tbody></table>
    ${box.values.seconds != null ? `<p class="field-note">${esc(box.values.duration)} ticks ÷ ${esc(box.values.timescale)} ticks/second = <strong>${secondsLabel(box.values.seconds)}</strong></p>` : ''}
    ${box.children.length ? `<div class="field-note">Continue into a child box:</div><div class="child-links">${box.children.map(child => `<button data-box="${child.id}">${esc(child.type)} →</button>`).join('')}</div>` : ''}
    ${box.type === 'mdat' ? '<p class="field-note">Media bytes are encoded samples, not child boxes. Use a track’s stco or co64 table to locate chunk data.</p>' : ''}
    ${box.warnings.map(warning => `<p class="inline-warning">${esc(warning)}</p>`).join('')}
    ${box.table ? '<div class="table-section" id="table-content"><p class="field-note">Reading table entries…</p></div>' : ''}`;
  if (box.table) {
    const rows = await readTable(result.file, box, tablePage);
    if (current !== viewGeneration) return;
    const pages = Math.max(1, Math.ceil(box.table.count / TABLE_PAGE));
    $('#table-content').innerHTML = `<div class="field-heading"><h3>Table entries</h3><span>${pretty(box.table.count)} rows · read on demand</span></div><div class="table-scroll"><table class="data-table"><thead><tr><th>#</th>${box.table.columns.map(col => `<th>${esc(col.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><td>${row.index}</td>${row.cells.map(cell => `<td>${cell.link ? `<button data-offset="${esc(cell.value)}" title="Jump to chunk data at this file offset">${esc(cell.value)} ↗</button>` : `<button data-range="${cell.offset},${cell.length}" title="Highlight bytes for this value">${esc(cell.value)}${esc(cell.suffix || '')}</button>`}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="pager"><button class="button" id="table-prev" ${tablePage === 0 ? 'disabled' : ''}>←</button><span>Page ${tablePage + 1} of ${pages}</span><button class="button" id="table-next" ${tablePage + 1 >= pages ? 'disabled' : ''}>→</button></div>`;
  }
}

function renderGuide() {
  const info = selected ? describe(selected.type) : { name: 'Understand the structure', explanation: 'Every file has a layout. This explorer connects that layout to the actual bytes, so you can see how media is organized.', tip: 'Try the bundled sample, then select a box or follow the field guide.' };
  $('#context-guide').innerHTML = `<div><div class="guide-icon">i</div><div class="eyebrow">WHY THIS BOX EXISTS</div><h2>${esc(info.name)}</h2><p>${esc(info.explanation)}</p></div><div class="guide-tip"><strong>↳ Try this</strong><p>${esc(info.tip)}</p></div><div class="anatomy"><div class="eyebrow">ANATOMY OF A BOX</div><div class="anatomy-diagram"><span>size</span><span>type</span><span>payload</span></div><p>4 bytes + 4 bytes + contents.<br>Extended headers add more bytes.</p></div><div class="guide-links"><a href="https://developer.apple.com/documentation/quicktime-file-format/atoms" target="_blank" rel="noreferrer">Read Apple’s atom reference ↗</a><button class="text-button" data-open-learn>Follow the guided tour →</button></div>`;
}

async function renderHex() {
  if (!result) return;
  const current = ++hexGeneration, file = result.file;
  hexStart = Math.max(0, Math.min(hexStart, file.size - 1));
  const start = hexStart;
  const data = await readBytes(file, start, Math.min(256, file.size - start));
  if (current !== hexGeneration) return;
  $('#hex-range').textContent = `${hex(start)} – ${hex(start + data.length - 1)}`;
  const lines = [`<div class="hex-line heading"><span>OFFSET (HEX)</span>${Array.from({ length: 16 }, (_, i) => `<span>+${i.toString(16).toUpperCase()}</span>`).join('')}<span>ASCII</span></div>`];
  for (let i = 0; i < data.length; i += 16) {
    const chunk = data.subarray(i, i + 16);
    lines.push(`<div class="hex-line"><span class="hex-offset">${(start + i).toString(16).toUpperCase().padStart(8, '0')}</span>${Array.from({ length: 16 }, (_, j) => {
      if (j >= chunk.length) return '<span></span>';
      const absolute = start + i + j;
      const inHeader = selected && absolute >= selected.offset && absolute < selected.offset + selected.headerSize;
      const inSelection = selection && absolute >= selection.offset && absolute < selection.offset + selection.length;
      return `<button class="hex-byte ${inHeader ? 'in-header' : ''} ${inSelection ? 'in-selection' : ''} ${absolute === byteOffset ? 'active-byte' : ''}" data-byte="${absolute}" aria-label="Byte ${absolute}: ${chunk[j].toString(16).padStart(2, '0')}" title="Byte ${absolute}">${chunk[j].toString(16).toUpperCase().padStart(2, '0')}</button>`;
    }).join('')}<span class="hex-ascii">${esc(Array.from(chunk, b => b >= 32 && b <= 126 ? String.fromCharCode(b) : '·').join(''))}</span></div>`);
  }
  $('#hex-grid').innerHTML = lines.join('');
  $('#hex-prev').disabled = start === 0;
  $('#hex-next').disabled = start + data.length >= file.size;
  await renderByte();
}

async function renderByte() {
  if (!result) return;
  const offset = byteOffset, current = hexGeneration;
  const data = await readBytes(result.file, offset, Math.min(8, result.file.size - offset));
  if (offset !== byteOffset || current !== hexGeneration) return;
  const v = new DataView(data.buffer);
  if (selection && (offset < selection.offset || offset >= selection.offset + selection.length)) selection = null;
  $('#byte-detail').innerHTML = `<div class="eyebrow">${selection?.name ? esc(selection.name) : 'BYTE LENS'}</div><strong>${hex(offset)}</strong>${selection?.description ? `<p>${esc(selection.description)}</p>` : '<p>The same bytes can mean different things. Their field definition tells you how to read them.</p>'}<dl><dt>Binary (1 byte)</dt><dd>${data[0].toString(2).padStart(8, '0')}</dd><dt>Unsigned 8-bit</dt><dd>${data[0]}</dd><dt>ASCII</dt><dd>${data[0] >= 32 && data[0] <= 126 ? esc(String.fromCharCode(data[0])) : 'non-printable'}</dd>${data.length >= 4 ? `<dt>Unsigned 32-bit BE</dt><dd>${v.getUint32(0)}</dd><dt>Unsigned 32-bit LE</dt><dd>${v.getUint32(0, true)}</dd>` : ''}</dl><p>BE = big-endian · LE = little-endian.<br>Values start at the selected byte.</p>`;
}

async function highlight(offset, length, field = null) {
  selection = field || { offset, length };
  byteOffset = offset;
  hexStart = offset;
  document.querySelectorAll('[data-field-row]').forEach(row => row.classList.toggle('selected', selected?.fields[Number(row.dataset.fieldRow)] === field));
  $('#hex-message').textContent = `Selected ${length} byte${length === 1 ? '' : 's'} at ${hex(offset)}${field ? ` · ${field.name}` : ''}.`;
  await renderHex();
}

async function jump(value) {
  if (!result) { $('#hex-message').textContent = 'Open a file before jumping to a byte.'; return; }
  const normalized = String(value).trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(normalized)) { $('#hex-message').textContent = 'Enter a decimal offset, or a hexadecimal offset starting with 0x.'; return; }
  const offset = Number(normalized);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= result.file.size) { $('#hex-message').textContent = `Enter an offset between 0 and ${pretty(result.file.size - 1)}.`; return; }
  const box = boxAt(result, offset);
  switchTab('inspect');
  if (box) await selectBox(box.id, true);
  selection = null; hexStart = offset; byteOffset = offset;
  $('#hex-message').textContent = `${hex(offset)}${box ? ` is inside ${box.type}, ${pretty(offset - box.offset)} bytes from its start.` : ' is not inside a parsed box.'}`;
  await renderHex();
}

function renderTracks() {
  if (!result) { $('#tracks-view').innerHTML = '<div class="empty-state"><h2>Every stream has its own story.</h2><p>Open a file to compare its audio, video, and other tracks.</p></div>'; return; }
  $('#tracks-view').innerHTML = `<div class="learn-intro"><div class="eyebrow">FROM TIMELINE TO BYTES</div><h2>One movie. Separate streams.</h2><p>Each track has its own clock and sample index. Follow a track’s tables to see how a player locates its data.</p></div><div class="track-grid">${result.tracks.map((track, trackIndex) => {
    const kind = track.handler === 'vide' ? 'Video' : track.handler === 'soun' ? 'Audio' : track.handler;
    return `<article class="track-card"><span class="pill">TRACK ${esc(track.id)}</span><h2>${esc(kind)} track</h2><p>Sample entry <code>${esc(track.codec)}</code> · handler <code>${esc(track.handler)}</code></p><div class="track-facts"><div><span>MEDIA DURATION</span><strong>${secondsLabel(track.duration)}</strong></div><div><span>TIMESCALE</span><strong>${track.timescale ? pretty(track.timescale) : 'Unknown'}</strong></div><div><span>SAMPLES (stsz)</span><strong>${track.samples == null ? 'Not available' : pretty(track.samples)}</strong></div>${track.width ? `<div><span>DISPLAY SIZE</span><strong>${esc(track.width)} × ${esc(track.height)}</strong></div>` : ''}</div><h3>Follow the sample index</h3><div class="trace-links">${['mdhd', 'stsd', 'stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'elst'].map(type => { const box = track.descendants.find(box => box.type === type); return box ? `<button data-box="${box.id}" data-inspect title="${esc(describe(type).name)}">${type} ↗</button>` : ''; }).join('')}</div><p class="track-note">Time → sample → chunk → byte offset. Click a chunk offset in stco/co64 to inspect its bytes.</p>${!result.fragmented && track.samples ? `<form class="sample-form" data-track="${trackIndex}"><label for="sample-${trackIndex}">Trace sample</label><input id="sample-${trackIndex}" type="number" value="1" min="1" max="${track.samples}" required><button class="button" type="submit">Find its bytes →</button></form><div id="trace-${trackIndex}" class="trace-result" role="status"></div>` : ''}</article>`;
  }).join('')}</div>${result.tracks.length ? '' : '<p class="inline-warning">No track metadata was found. This could be a fragment, an incomplete file, or an unsupported metadata layout.</p>'}${result.fragmented ? '<p class="inline-warning">This is a fragmented file. Initial sample tables may be empty; explore moof → traf → trun for fragment data. Fragment sample offsets are not resolved yet.</p>' : ''}<section class="preview-card"><video id="media-preview" controls preload="metadata" aria-label="Local media preview"></video><div><div class="eyebrow">CONNECT STRUCTURE TO PLAYBACK</div><h2>The container is only part of the story.</h2><p>This optional preview uses your browser’s decoder. A readable MP4 or MOV file may use a codec your browser cannot play. The structure explorer works independently of playback.</p><p id="preview-status" role="status"></p></div></section>`;
  const video = $('#media-preview');
  video.src = previewURL;
  video.addEventListener('error', () => { $('#preview-status').textContent = 'This browser cannot play the file’s media. You can still explore its structure and bytes.'; });
}

function renderLearn() {
  $('#learn-view').innerHTML = `<div class="learn-intro"><div class="eyebrow">A GUIDED WALK THROUGH YOUR FILE</div><h2>Make the invisible structure visible.</h2><p>Six small steps from a box header to encoded media. Open a file, then use the links below to explore each idea in its actual bytes.</p></div><div class="learn-grid">${lessons.map(([title, type, explanation], index) => {
    const box = result?.boxes.find(box => box.type === type) || (type === 'stco' ? result?.boxes.find(box => box.type === 'co64') : null);
    return `<article class="learn-card"><div class="step">0${index + 1} / FOLLOW THE BYTES</div><h3>${esc(title)}</h3><p>${esc(explanation)}</p><button class="button" ${box ? `data-box="${box.id}" data-inspect` : 'disabled'}>${box ? `Explore ${esc(box.type)} →` : result ? `${type} not present in this file` : 'Open a file to explore'}</button></article>`;
  }).join('')}</div><p class="learning-limits">This is an educational explorer, not a full conformance validator. Unknown boxes remain available as raw bytes. Compressed QuickTime metadata, encrypted samples, external media references, compact sample-size tables, and complete fragment sample resolution are not decoded yet. Formats can vary; the file’s actual fields take priority over a general example.</p><div class="child-links"><a class="button" href="https://developer.apple.com/documentation/quicktime-file-format" target="_blank" rel="noreferrer">Apple QuickTime specification ↗</a><a class="button" href="https://www.w3.org/TR/mse-byte-stream-format-isobmff/" target="_blank" rel="noreferrer">W3C fragmented ISO BMFF overview ↗</a></div>`;
}

function renderWarnings() {
  const warnings = result ? [...result.warnings.map(w => w.message), ...result.boxes.flatMap(box => box.warnings.filter(message => !result.warnings.some(w => w.message === message)).map(message => `${box.type} at byte ${box.offset}: ${message}`))] : [];
  $('#warnings').hidden = warnings.length === 0;
  $('#warnings').innerHTML = `<h2>Exploration notes (${warnings.length})</h2><p>Some structures could not be fully decoded. Available boxes and raw bytes are still shown.</p><ul>${warnings.map(message => `<li>${esc(message)}</li>`).join('')}</ul>`;
}

function switchTab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === name;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(`#${button.dataset.tab}-view`).hidden = !active;
  }
  if (name !== 'tracks') $('#media-preview')?.pause();
}

document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.box !== undefined) run(async () => { if (target.hasAttribute('data-inspect')) switchTab('inspect'); await selectBox(Number(target.dataset.box)); });
  else if (target.dataset.toggle !== undefined) { const id = Number(target.dataset.toggle); if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); renderTree(); }
  else if (target.dataset.field !== undefined && selected) run(() => { const field = selected.fields[Number(target.dataset.field)]; return highlight(field.offset, field.length, field); });
  else if (target.dataset.byte !== undefined) run(async () => { byteOffset = Number(target.dataset.byte); document.querySelectorAll('.active-byte').forEach(button => button.classList.remove('active-byte')); target.classList.add('active-byte'); await renderByte(); });
  else if (target.dataset.offset !== undefined) run(() => jump(target.dataset.offset));
  else if (target.dataset.range) run(() => highlight(...target.dataset.range.split(',').map(Number)));
  else if (target.dataset.tab) switchTab(target.dataset.tab);
  else if (target.hasAttribute('data-open-learn') || target.id === 'learn-button') switchTab('learn');
  else if (['sample-button', 'empty-sample'].includes(target.id)) run(sample);
  else if (target.id === 'table-prev' || target.id === 'table-next') run(async () => { tablePage += target.id === 'table-next' ? 1 : -1; await renderDetail(); });
});
$('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[data-tab]')], index = tabs.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  switchTab(tabs[next].dataset.tab); tabs[next].focus(); event.preventDefault();
});
$('#file-input').addEventListener('change', event => { const file = event.target.files[0]; if (file) run(() => openFile(file)); event.target.value = ''; });
$('#open-file').addEventListener('click', () => $('#file-input').click());
$('#tracks-view').addEventListener('submit', event => {
  const form = event.target.closest('.sample-form');
  if (!form || !result) return;
  event.preventDefault();
  const trackIndex = Number(form.dataset.track), output = $(`#trace-${trackIndex}`), current = result;
  const button = form.querySelector('button'); button.disabled = true;
  output.textContent = 'Following the sample tables…';
  run(async () => {
    try {
      const trace = await traceSample(current, current.tracks[trackIndex], Number(form.querySelector('input').value), { signal: controller.signal });
      if (current !== result) return;
      output.innerHTML = `<strong>Sample ${trace.sampleNumber} → chunk ${trace.chunk} → byte ${pretty(trace.offset)}</strong><p>stsc row ${trace.mappingRow} places this sample at position ${trace.withinChunk} in chunk ${trace.chunk}. The chunk starts at ${pretty(trace.chunkOffset)}; earlier samples in that chunk use ${pretty(trace.bytesBefore)} bytes.</p><code>${pretty(trace.chunkOffset)} + ${pretty(trace.bytesBefore)} = ${pretty(trace.offset)}</code><p>This sample occupies ${pretty(trace.sampleSize)} bytes.</p><button class="button" data-offset="${trace.offset}">Inspect sample bytes ↗</button>`;
    } catch (error) { if (current === result) output.textContent = error.message; }
    finally { button.disabled = false; }
  });
});
for (const name of ['dragenter', 'dragover']) document.addEventListener(name, event => { event.preventDefault(); $('#drop-zone').classList.add('dragging'); });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('#drop-zone').classList.remove('dragging'); });
document.addEventListener('drop', event => { event.preventDefault(); $('#drop-zone').classList.remove('dragging'); const file = event.dataTransfer.files[0]; if (file) run(() => openFile(file)); });
$('#box-search').addEventListener('input', renderTree);
$('#expand-button').addEventListener('click', () => { if (!result) return; const collapse = collapsed.size === 0; collapsed = collapse ? new Set(result.boxes.filter(box => box.children.length).map(box => box.id)) : new Set(); $('#expand-button').textContent = collapse ? 'Expand all' : 'Collapse all'; renderTree(); });
$('#jump-form').addEventListener('submit', event => { event.preventDefault(); run(() => jump($('#jump-offset').value)); });
$('#hex-prev').addEventListener('click', () => run(async () => { hexStart = Math.max(0, hexStart - 256); byteOffset = hexStart; await renderHex(); }));
$('#hex-next').addEventListener('click', () => run(async () => { hexStart += 256; byteOffset = hexStart; await renderHex(); }));
$('#export-button').addEventListener('click', () => {
  if (!result) return;
  const blob = new Blob([JSON.stringify(exportReport(result), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `${result.file.name}.structure.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
renderMetrics(); renderTree(); renderGuide(); renderTracks(); renderLearn(); switchTab('inspect');
