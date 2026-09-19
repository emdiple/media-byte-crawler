# Media Byte Crawler

A small Rust project for learning how media files are structured. I started it to understand the bytes inside a media file, then share what I learn with others.

The current focus is MP4 and MOV: reading box headers, walking nested boxes, and connecting metadata to the actual media bytes.

## Run

With Rust and Cargo installed, start the interactive explorer:

```sh
cargo run -- --ui
```

Open **http://127.0.0.1:7878** in your browser. Choose a local MP4 or MOV, drag a file onto the page, or click **Try the sample**. Press Ctrl+C in the terminal to stop the server.

No frontend install or build step is needed. Rust serves the included HTML, CSS, and JavaScript. Your selected files are read in the browser and are never uploaded. Large media payloads are skipped during parsing; byte views and tables read small ranges on demand.

## Explore a file

- **Structure:** search and expand the box tree, inspect a proportional file map, and read explanations of each box's role.
- **Decoded fields:** select a field to highlight its exact bytes, including its offset, width, value, and encoding.
- **Byte inspector:** browse hex and ASCII, jump to a decimal or hexadecimal offset, and compare binary and integer interpretations.
- **Tracks:** compare video and audio clocks, sample entries, and sample counts. Follow sample-table links or enter a sample number to trace it through chunk mapping and sample sizes to its media bytes.
- **Learn the format:** follow six guided steps through the file, with links to format references.
- **Export JSON:** save the parsed structure, field ranges, and exploration notes. Encoded media bytes are not included.

The Tracks tab also has an optional browser playback preview. Playback depends on your browser's codec support; inspection does not.

## Command-line reader

Run the bundled MP4 sample:

```sh
cargo run
```

Or pass a path to another MP4 or MOV file:

```sh
cargo run -- path/to/video.mp4
```

## What to look for

MP4 files are organized into boxes. A normal box begins with a 4-byte size and a 4-byte type, followed by its contents. The size includes the header. Some boxes contain other boxes, forming a hierarchy.

The reader prints each box's type, byte offset, and size. Indentation shows nesting. A few useful boxes to recognize:

- `ftyp`: file brands and compatibility information.
- `moov`: movie metadata, including tracks.
- `trak`: an individual track, such as video or audio.
- `mvhd`, `tkhd`, and `mdhd`: movie, track, and media headers with timing information.
- `mdat`: encoded media data.

For example, `timescale=1000 duration=10000` means 10 seconds: divide duration by timescale.

Start with `header_extractor` in `src/main.rs` to see how bytes become a box header, then follow `parse_boxes` to see how the command-line reader moves through the file. It also prints track handlers, sample counts, and a preview of chunk offsets.

For a hands-on exercise, load the sample in the UI, open **Tracks**, and trace sample 1. Then inspect `stsc`, `stsz`, and `stco` to see where the values in the calculation came from.

## Scope

This is a learning project, not a complete conformance validator. The UI supports common MP4/MOV boxes, 32- and 64-bit sizes and timing fields, ISO and QuickTime metadata layouts, common audio/video sample entries, and paginated sample tables. Unknown boxes remain inspectable as raw bytes.

Sample tracing currently requires classic `stsc`, `stsz`, and `stco`/`co64` tables with supported in-file data references. Fragment boxes are explored, but complete fragment sample resolution, compact `stz2` tables, encrypted media, external media references, and compressed QuickTime movie metadata are not decoded. Parsing has limits of 48 nested levels and 50,000 boxes; files exceeding those limits produce exploration notes.

The JPEG and MP3 files in `sample/` are for future exploration; their formats are not supported yet.

## Project layout

- `src/main.rs`: the original Rust command-line parser.
- `src/ui.rs`: a local server that embeds the UI and sample.
- `web/parser.mjs`: browser parser, range reads, table pagination, and sample tracing; also runs under Node for tests.
- `web/knowledge.mjs`: box explanations and guided lessons.
- `web/app.js`, `web/index.html`, `web/styles.css`: the interface.

The UI parser is separate from the introductory Rust parser so it can read local files directly without uploading them. New format adapters can follow the box/field/range model and register alongside the MP4/MOV adapter in `web/parser.mjs`. Add the format's detection and vocabulary as well as its parser.

## Checks

Run the tests with:

```sh
cargo test
cargo clippy --all-targets -- -D warnings
node --test web/parser.test.mjs
```

Node 20+ is needed only for the browser-parser tests. They cover the bundled video, synthetic MOV layouts, malformed inputs, large-file range reads, table pagination, and sample tracing.

## References

- [Apple QuickTime File Format](https://developer.apple.com/documentation/quicktime-file-format)
- [Apple's atom structure](https://developer.apple.com/documentation/quicktime-file-format/atoms)
- [W3C ISO BMFF byte-stream overview](https://www.w3.org/TR/mse-byte-stream-format-isobmff/)
