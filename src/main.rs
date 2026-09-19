use anyhow::{Context, Result, bail, ensure};
use std::{
    env,
    fs::File,
    io::{Read, Seek, SeekFrom},
};

fn main() -> Result<()> {
    let path = env::args()
        .nth(1)
        .unwrap_or_else(|| "sample/vid_s_01.mp4".to_owned());
    let mut file = File::open(&path).with_context(|| format!("could not open {path}"))?;
    let file_size = file.metadata()?.len();

    parse_boxes(&mut file, 0, file_size, 0)
}

#[derive(Debug, PartialEq, Eq)]
struct HeaderData {
    size: u64,
    box_type: [u8; 4],
    header_size: u64,
}

impl HeaderData {
    fn type_name(&self) -> String {
        fourcc(&self.box_type)
    }
}

fn header_extractor(offset: u64, end: u64, file: &mut File) -> Result<HeaderData> {
    ensure!(
        end.saturating_sub(offset) >= 8,
        "truncated box header at offset {offset}"
    );
    file.seek(SeekFrom::Start(offset))?;

    let mut header = [0u8; 8];
    file.read_exact(&mut header)?;

    let size_32 = u32::from_be_bytes(header[0..4].try_into()?);
    let box_type: [u8; 4] = header[4..8].try_into()?;
    let (mut size, mut header_size) = if size_32 == 1 {
        ensure!(
            end.saturating_sub(offset) >= 16,
            "truncated extended box header at offset {offset}"
        );
        let mut extended_size = [0u8; 8];
        file.read_exact(&mut extended_size)?;
        (u64::from_be_bytes(extended_size), 16)
    } else {
        (u64::from(size_32), 8)
    };

    if size_32 == 0 {
        size = file.metadata()?.len() - offset;
    }
    if &box_type == b"uuid" {
        header_size += 16;
    }

    ensure!(
        size >= header_size,
        "box at offset {offset} is smaller than its header"
    );
    let box_end = offset
        .checked_add(size)
        .context("box size overflows its offset")?;
    ensure!(
        box_end <= end,
        "box at offset {offset} extends past its parent"
    );

    Ok(HeaderData {
        size,
        box_type,
        header_size,
    })
}

fn is_container(box_type: &[u8; 4]) -> bool {
    matches!(
        box_type,
        b"moov"
            | b"trak"
            | b"mdia"
            | b"minf"
            | b"stbl"
            | b"edts"
            | b"dinf"
            | b"mvex"
            | b"moof"
            | b"traf"
            | b"mfra"
            | b"udta"
    )
}

fn read_payload(file: &mut File, offset: u64, size: u64, header_size: u64) -> Result<Vec<u8>> {
    let payload_size = size - header_size;
    ensure!(
        payload_size <= 1024 * 1024,
        "metadata payload exceeds the CLI's 1 MiB limit; use --ui to inspect it in byte ranges"
    );
    let length: usize = payload_size
        .try_into()
        .context("box payload is too large to fit in memory")?;
    let mut payload = vec![0; length];
    file.seek(SeekFrom::Start(offset + header_size))?;
    file.read_exact(&mut payload)?;
    Ok(payload)
}

fn fourcc(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&byte| match byte {
            b' '..=b'~' => char::from(byte).to_string(),
            _ => format!("\\x{byte:02X}"),
        })
        .collect()
}

fn parse_ftyp(file: &mut File, offset: u64, header: &HeaderData) -> Result<()> {
    let payload = read_payload(file, offset, header.size, header.header_size)?;
    ensure!(payload.len() >= 8, "ftyp box is too short");
    ensure!(
        payload[8..].len() % 4 == 0,
        "ftyp compatible brands are not four-byte values"
    );

    let compatible = payload[8..].chunks_exact(4).map(fourcc).collect::<Vec<_>>();
    println!(
        "  major_brand={} minor_version={} compatible_brands=[{}]",
        fourcc(&payload[..4]),
        u32::from_be_bytes(payload[4..8].try_into()?),
        compatible.join(", ")
    );
    Ok(())
}

fn parse_mvhd(file: &mut File, offset: u64, header: &HeaderData) -> Result<()> {
    let payload = read_payload(file, offset, header.size, header.header_size)?;
    let (timescale_offset, duration_offset, duration_size) =
        full_box_time_offsets(&payload, "mvhd")?;
    let timescale = u32::from_be_bytes(payload[timescale_offset..timescale_offset + 4].try_into()?);
    let duration = read_duration(&payload, duration_offset, duration_size)?;
    println!("  timescale={timescale} duration={duration}");
    Ok(())
}

fn parse_tkhd(file: &mut File, offset: u64, header: &HeaderData) -> Result<()> {
    let payload = read_payload(file, offset, header.size, header.header_size)?;
    ensure!(payload.len() >= 4, "tkhd box is too short");
    let (track_id_offset, duration_offset, duration_size) = match payload[0] {
        0 => (12, 20, 4),
        1 => (20, 28, 8),
        version => bail!("unsupported tkhd version {version}"),
    };
    ensure!(
        payload.len() >= duration_offset + duration_size,
        "tkhd box is too short"
    );
    let track_id = u32::from_be_bytes(payload[track_id_offset..track_id_offset + 4].try_into()?);
    let duration = read_duration(&payload, duration_offset, duration_size)?;
    println!("  track_id={track_id} duration={duration}");
    Ok(())
}

fn parse_mdhd(file: &mut File, offset: u64, header: &HeaderData) -> Result<()> {
    let payload = read_payload(file, offset, header.size, header.header_size)?;
    let (timescale_offset, duration_offset, duration_size) =
        full_box_time_offsets(&payload, "mdhd")?;
    let timescale = u32::from_be_bytes(payload[timescale_offset..timescale_offset + 4].try_into()?);
    let duration = read_duration(&payload, duration_offset, duration_size)?;
    println!("  timescale={timescale} duration={duration}");
    Ok(())
}

fn full_box_time_offsets(payload: &[u8], name: &str) -> Result<(usize, usize, usize)> {
    ensure!(payload.len() >= 4, "{name} box is too short");
    match payload[0] {
        0 => {
            ensure!(payload.len() >= 20, "{name} version 0 box is too short");
            Ok((12, 16, 4))
        }
        1 => {
            ensure!(payload.len() >= 32, "{name} version 1 box is too short");
            Ok((20, 24, 8))
        }
        version => bail!("unsupported {name} version {version}"),
    }
}

fn read_duration(payload: &[u8], offset: usize, size: usize) -> Result<u64> {
    match size {
        4 => Ok(u64::from(u32::from_be_bytes(
            payload[offset..offset + 4].try_into()?,
        ))),
        8 => Ok(u64::from_be_bytes(payload[offset..offset + 8].try_into()?)),
        _ => bail!("invalid duration width {size}"),
    }
}

fn parse_boxes(file: &mut File, start: u64, end: u64, depth: usize) -> Result<()> {
    ensure!(depth <= 48, "box nesting exceeds 48 levels");
    let mut offset = start;

    while offset < end {
        let header = header_extractor(offset, end, file)?;
        println!(
            "{}{} @ {} size={}",
            "  ".repeat(depth),
            header.type_name(),
            offset,
            header.size
        );

        match &header.box_type {
            b"ftyp" => parse_ftyp(file, offset, &header)?,
            b"mvhd" => parse_mvhd(file, offset, &header)?,
            b"tkhd" => parse_tkhd(file, offset, &header)?,
            b"mdhd" => parse_mdhd(file, offset, &header)?,
            b"hdlr" | b"stsz" | b"stco" | b"co64" => {
                parse_index_summary(file, offset, &header, depth + 1)?;
            }
            b"mdat" => {}
            box_type if is_container(box_type) => parse_boxes(
                file,
                offset + header.header_size,
                offset + header.size,
                depth + 1,
            )?,
            _ => {}
        }

        offset += header.size;
    }

    Ok(())
}

fn parse_index_summary(
    file: &mut File,
    offset: u64,
    header: &HeaderData,
    depth: usize,
) -> Result<()> {
    // A short prefix is enough to explain a table without allocating its full payload.
    let payload_size = (header.size - header.header_size).min(76) as usize;
    let mut payload = vec![0; payload_size];
    file.seek(SeekFrom::Start(offset + header.header_size))?;
    file.read_exact(&mut payload)?;
    let indent = "  ".repeat(depth);
    match &header.box_type {
        b"hdlr" => {
            ensure!(payload.len() >= 12, "hdlr box is too short");
            println!(
                "{indent}handler={} (vide=video, soun=audio)",
                fourcc(&payload[8..12])
            );
        }
        b"stsz" => {
            ensure!(payload.len() >= 12, "stsz box is too short");
            let size = u32::from_be_bytes(payload[4..8].try_into()?);
            let count = u32::from_be_bytes(payload[8..12].try_into()?);
            if size == 0 {
                ensure!(
                    u64::from(count) * 4 + 12 <= header.size - header.header_size,
                    "truncated sample size table"
                );
            }
            println!("{indent}sample_count={count} fixed_sample_size={size} (0=per-sample table)");
        }
        b"stco" | b"co64" => {
            ensure!(payload.len() >= 8, "chunk offset box is too short");
            let count = u32::from_be_bytes(payload[4..8].try_into()?);
            let width = if &header.box_type == b"co64" { 8 } else { 4 };
            ensure!(
                u64::from(count) * width + 8 <= header.size - header.header_size,
                "truncated chunk offset table"
            );
            println!("{indent}chunk_count={count} (absolute byte offsets; showing up to 8)");
            for index in 0..count.min(8) as usize {
                let start = 8 + index * width as usize;
                let chunk_offset = read_duration(&payload, start, width as usize)?;
                println!("{indent}chunk {} -> byte {chunk_offset}", index + 1);
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn with_file(bytes: &[u8], test: impl FnOnce(&mut File) -> Result<()>) -> Result<()> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path =
            std::env::temp_dir().join(format!("md-byte-detector-{}-{nonce}", std::process::id()));
        let mut output = File::create(&path)?;
        output.write_all(bytes)?;
        drop(output);
        let result = test(&mut File::open(&path)?);
        std::fs::remove_file(path)?;
        result
    }

    #[test]
    fn handles_extended_and_zero_sizes() -> Result<()> {
        let extended = [0, 0, 0, 1, b'f', b'r', b'e', b'e', 0, 0, 0, 0, 0, 0, 0, 16];
        with_file(&extended, |file| {
            let header = header_extractor(0, 16, file)?;
            assert_eq!(header.size, 16);
            assert_eq!(header.header_size, 16);
            Ok(())
        })?;

        let zero = [0, 0, 0, 0, b'f', b'r', b'e', b'e', 1, 2, 3, 4];
        with_file(&zero, |file| {
            assert_eq!(header_extractor(0, 12, file)?.size, 12);
            Ok(())
        })
    }

    #[test]
    fn rejects_boxes_past_parent_boundary() -> Result<()> {
        let invalid = [0, 0, 0, 16, b'f', b'r', b'e', b'e'];
        with_file(&invalid, |file| {
            assert!(header_extractor(0, 8, file).is_err());
            Ok(())
        })
    }

    #[test]
    fn rejects_zero_extended_size_and_nested_eof_box() -> Result<()> {
        let invalid = [0, 0, 0, 1, b'f', b'r', b'e', b'e', 0, 0, 0, 0, 0, 0, 0, 0];
        with_file(&invalid, |file| {
            assert!(header_extractor(0, 16, file).is_err());
            Ok(())
        })?;
        let nested = [0, 0, 0, 0, b'f', b'r', b'e', b'e', 0, 0, 0, 0];
        with_file(&nested, |file| {
            assert!(header_extractor(0, 8, file).is_err());
            Ok(())
        })
    }
}
