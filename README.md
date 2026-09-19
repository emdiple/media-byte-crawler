# Media File Structure Reader

A small Rust project for learning how media files are structured. I started it to understand the bytes inside a media file, then share what I learn with others.

The current focus is MP4: reading box headers, walking nested boxes, and extracting basic metadata.

## Run

With Rust and Cargo installed, run the bundled MP4 sample:

```sh
cargo run
```

Or pass a path to another MP4 file:

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

Start with `header_extractor` in `src/main.rs` to see how bytes become a box header, then follow `parse_boxes` to see how the reader moves through the file.

## Scope

This is a learning project, not a complete media parser or player. It reads selected MP4 metadata and skips unimplemented box contents. It does not decode audio or video. The JPEG and MP3 files in `sample/` are there for future exploration; they are not supported yet.

Run the tests with:

```sh
cargo test
```
