//! A WebM file with one Opus track: just what a shared recording needs, laid out the way
//! ffmpeg writes one. WebM rather than Ogg because Safari reads the length from the header
//! and seeks with the cues at the end, where with Ogg it guesses both from the bitrate.
//!
//! Packets are 20 ms, and blocks are timed as the encoder made them: from zero, 20 ms
//! apart. Players subtract the encoder's delay (CodecDelay) and drop the padding the last
//! block names (DiscardPadding), so what plays is exactly the input.

use std::io::{self, Seek, SeekFrom, Write};
use std::time::Duration;

const EBML: u32 = 0x1A45_DFA3;
const SEGMENT: u32 = 0x1853_8067;
const SEEK_HEAD: u32 = 0x114D_9B74;
const SEEK: u32 = 0x4DBB;
const SEEK_ID: u32 = 0x53AB;
const SEEK_POSITION: u32 = 0x53AC;
const INFO: u32 = 0x1549_A966;
const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const MUXING_APP: u32 = 0x4D80;
const WRITING_APP: u32 = 0x5741;
const DURATION: u32 = 0x4489;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_UID: u32 = 0x73C5;
const TRACK_TYPE: u32 = 0x83;
const CODEC_ID: u32 = 0x86;
const CODEC_PRIVATE: u32 = 0x63A2;
const CODEC_DELAY: u32 = 0x56AA;
const SEEK_PRE_ROLL: u32 = 0x56BB;
const AUDIO: u32 = 0xE1;
const SAMPLING_FREQUENCY: u32 = 0xB5;
const CHANNELS: u32 = 0x9F;
const CLUSTER: u32 = 0x1F43_B675;
const TIMESTAMP: u32 = 0xE7;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const DISCARD_PADDING: u32 = 0x75A2;
const CUES: u32 = 0x1C53_BB6B;
const CUE_POINT: u32 = 0xBB;
const CUE_TIME: u32 = 0xB3;
const CUE_TRACK_POSITIONS: u32 = 0xB7;
const CUE_TRACK: u32 = 0xF7;
const CUE_CLUSTER_POSITION: u32 = 0xF1;

const PACKET_MS: u64 = 20;
/// Five seconds a cluster, and a cue for each.
const BLOCKS_PER_CLUSTER: usize = 250;

fn id(id: u32) -> Vec<u8> {
    let bytes = id.to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count();
    bytes[skip..].to_vec()
}

/// An element's size, in as few bytes as it takes.
fn size(n: u64) -> Vec<u8> {
    let len = (1..=8).find(|l| n < (1 << (7 * l)) - 1).unwrap_or(8);
    let bytes = (n | 1 << (7 * len)).to_be_bytes();
    bytes[8 - len..].to_vec()
}

fn element(tag: u32, data: &[u8]) -> Vec<u8> {
    [id(tag), size(data.len() as u64), data.to_vec()].concat()
}

fn uint(tag: u32, v: u64) -> Vec<u8> {
    let bytes = v.to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count().min(7);
    element(tag, &bytes[skip..])
}

fn float(tag: u32, v: f64) -> Vec<u8> {
    element(tag, &v.to_be_bytes())
}

pub struct OpusWriter<W: Write + Seek> {
    out: W,
    /// Where the Segment's data starts: positions inside it count from here.
    segment: u64,
    /// The placeholders `finish` fills in: the cues' position and the duration.
    cues_position_at: u64,
    duration_at: u64,
    packets: u64,
    cluster: Vec<u8>,
    cluster_time: u64,
    blocks: usize,
    cues: Vec<(u64, u64)>,
}

impl<W: Write + Seek> OpusWriter<W> {
    /// `pre_skip`: the encoder's delay in 48 kHz samples. `rate`: the input's, for the
    /// record (players decode at 48 kHz).
    pub fn new(mut out: W, rate: u32, pre_skip: u16) -> io::Result<Self> {
        let mut head = b"OpusHead\x01\x01".to_vec();
        head.extend_from_slice(&pre_skip.to_le_bytes());
        head.extend_from_slice(&rate.to_le_bytes());
        head.extend_from_slice(&[0, 0, 0]); // no output gain, mono
        let pre_skip = pre_skip as u64;

        out.write_all(&element(
            EBML,
            &[
                uint(0x4286, 1), // EBMLVersion
                uint(0x42F7, 1), // EBMLReadVersion
                uint(0x42F2, 4), // EBMLMaxIDLength
                uint(0x42F3, 8), // EBMLMaxSizeLength
                element(0x4282, b"webm"),
                uint(0x4287, 4), // DocTypeVersion
                uint(0x4285, 2), // DocTypeReadVersion
            ]
            .concat(),
        ))?;
        // The Segment's size, eight bytes long until `finish` knows it.
        out.write_all(&id(SEGMENT))?;
        out.write_all(&(1u64 << 56).to_be_bytes())?;
        let segment = out.stream_position()?;

        let info = element(
            INFO,
            &[
                uint(TIMESTAMP_SCALE, 1_000_000), // times in milliseconds
                element(MUXING_APP, b"Eshlik"),
                element(WRITING_APP, b"Eshlik"),
                float(DURATION, 0.0), // last: `finish` overwrites its eight bytes
            ]
            .concat(),
        );
        let tracks = element(
            TRACKS,
            &element(
                TRACK_ENTRY,
                &[
                    uint(TRACK_NUMBER, 1),
                    uint(TRACK_UID, 1),
                    uint(TRACK_TYPE, 2), // audio
                    element(CODEC_ID, b"A_OPUS"),
                    element(CODEC_PRIVATE, &head),
                    uint(CODEC_DELAY, pre_skip * 1_000_000_000 / 48_000),
                    uint(SEEK_PRE_ROLL, 80_000_000),
                    element(
                        AUDIO,
                        &[float(SAMPLING_FREQUENCY, 48_000.0), uint(CHANNELS, 1)].concat(),
                    ),
                ]
                .concat(),
            ),
        );
        let seek = |tag: u32, position: u64| {
            element(
                SEEK,
                &[
                    element(SEEK_ID, &id(tag)),
                    element(SEEK_POSITION, &position.to_be_bytes()),
                ]
                .concat(),
            )
        };
        // Every position is eight bytes, so the SeekHead's length does not depend on them.
        let seek_head_len = element(
            SEEK_HEAD,
            &[seek(INFO, 0), seek(TRACKS, 0), seek(CUES, 0)].concat(),
        )
        .len() as u64;
        let seek_head = element(
            SEEK_HEAD,
            &[
                seek(INFO, seek_head_len),
                seek(TRACKS, seek_head_len + info.len() as u64),
                seek(CUES, 0), // last: `finish` overwrites its eight bytes
            ]
            .concat(),
        );
        out.write_all(&seek_head)?;
        let cues_position_at = out.stream_position()? - 8;
        out.write_all(&info)?;
        let duration_at = out.stream_position()? - 8;
        out.write_all(&tracks)?;

        Ok(Self {
            out,
            segment,
            cues_position_at,
            duration_at,
            packets: 0,
            cluster: Vec::new(),
            cluster_time: 0,
            blocks: 0,
            cues: Vec::new(),
        })
    }

    /// The next 20 ms packet.
    pub fn write(&mut self, packet: &[u8]) -> io::Result<()> {
        self.block(packet, None)
    }

    /// The last packet, of which the last `padding` 48 kHz samples are not to be played,
    /// and the recording's length. Answers the finished file.
    pub fn finish(mut self, packet: &[u8], padding: u64, length: Duration) -> io::Result<W> {
        self.block(packet, Some(padding))?;
        self.flush_cluster()?;
        let cues_position = self.out.stream_position()? - self.segment;
        let cues: Vec<u8> = self
            .cues
            .iter()
            .flat_map(|&(time, position)| {
                element(
                    CUE_POINT,
                    &[
                        uint(CUE_TIME, time),
                        element(
                            CUE_TRACK_POSITIONS,
                            &[uint(CUE_TRACK, 1), uint(CUE_CLUSTER_POSITION, position)].concat(),
                        ),
                    ]
                    .concat(),
                )
            })
            .collect();
        self.out.write_all(&element(CUES, &cues))?;
        let end = self.out.stream_position()?;

        self.out.seek(SeekFrom::Start(self.segment - 8))?;
        self.out
            .write_all(&(1u64 << 56 | (end - self.segment)).to_be_bytes())?;
        self.out.seek(SeekFrom::Start(self.cues_position_at))?;
        self.out.write_all(&cues_position.to_be_bytes())?;
        self.out.seek(SeekFrom::Start(self.duration_at))?;
        self.out
            .write_all(&(length.as_secs_f64() * 1000.0).to_be_bytes())?;
        self.out.seek(SeekFrom::Start(end))?;
        Ok(self.out)
    }

    fn block(&mut self, packet: &[u8], padding: Option<u64>) -> io::Result<()> {
        if self.blocks == BLOCKS_PER_CLUSTER {
            self.flush_cluster()?;
        }
        let time = self.packets * PACKET_MS;
        if self.blocks == 0 {
            self.cluster_time = time;
            self.cluster = uint(TIMESTAMP, time);
        }
        // At most five seconds into its cluster.
        let relative = (time - self.cluster_time) as i16;
        let flags = if padding.is_none() { 0x80 } else { 0x00 }; // a keyframe, as Opus always is
        let block = [&[0x81][..], &relative.to_be_bytes(), &[flags], packet].concat();
        match padding {
            None => self.cluster.extend(element(SIMPLE_BLOCK, &block)),
            Some(samples) => {
                let ns = (samples * 1_000_000_000 / 48_000) as i64;
                self.cluster.extend(element(
                    BLOCK_GROUP,
                    &[
                        element(BLOCK, &block),
                        element(DISCARD_PADDING, &ns.to_be_bytes()),
                    ]
                    .concat(),
                ));
            }
        }
        self.blocks += 1;
        self.packets += 1;
        Ok(())
    }

    fn flush_cluster(&mut self) -> io::Result<()> {
        if self.blocks == 0 {
            return Ok(());
        }
        let position = self.out.stream_position()? - self.segment;
        self.cues.push((self.cluster_time, position));
        self.out.write_all(&element(CLUSTER, &self.cluster))?;
        self.blocks = 0;
        Ok(())
    }
}

/// Reads back what `OpusWriter` writes, as a player would, for tests.
#[cfg(test)]
pub mod read {
    use super::*;

    #[derive(Debug, Default)]
    pub struct Opus {
        pub head: Vec<u8>,
        pub codec_delay_ns: u64,
        pub duration_ms: f64,
        /// (time in ms, packet), in order.
        pub packets: Vec<(i64, Vec<u8>)>,
        pub discard_padding_ns: i64,
        /// (time in ms, the cluster's time it points at).
        pub cues: Vec<(u64, u64)>,
    }

    fn vint(data: &[u8], keep_marker: bool) -> (u64, usize) {
        let len = data[0].leading_zeros() as usize + 1;
        let mut v = (data[0] as u64) & if keep_marker { 0xFF } else { 0xFF >> len };
        for b in &data[1..len] {
            v = v << 8 | *b as u64;
        }
        (v, len)
    }

    /// The elements in `data`, each as (ID, data, offset of the element in `data`).
    pub fn children(data: &[u8]) -> Vec<(u32, &[u8], usize)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < data.len() {
            let (tag, a) = vint(&data[at..], true);
            let (len, b) = vint(&data[at + a..], false);
            let start = at + a + b;
            out.push((tag as u32, &data[start..start + len as usize], at));
            at = start + len as usize;
        }
        assert_eq!(at, data.len(), "elements run past their parent");
        out
    }

    fn find(data: &[u8], tag: u32) -> Option<&[u8]> {
        children(data).into_iter().find(|c| c.0 == tag).map(|c| c.1)
    }

    fn uint(data: &[u8]) -> u64 {
        data.iter().fold(0, |v, b| v << 8 | *b as u64)
    }

    pub fn opus(file: &[u8]) -> Opus {
        let top = children(file);
        assert_eq!(
            top.len(),
            2,
            "an EBML header and one Segment, nothing after"
        );
        assert_eq!(find(find(file, EBML).unwrap(), 0x4282).unwrap(), b"webm");
        let segment = find(file, SEGMENT).unwrap();
        let mut o = Opus::default();

        let info = find(segment, INFO).unwrap();
        assert_eq!(uint(find(info, TIMESTAMP_SCALE).unwrap()), 1_000_000);
        o.duration_ms = f64::from_be_bytes(find(info, DURATION).unwrap().try_into().unwrap());
        let track = find(find(segment, TRACKS).unwrap(), TRACK_ENTRY).unwrap();
        assert_eq!(find(track, CODEC_ID).unwrap(), b"A_OPUS");
        o.head = find(track, CODEC_PRIVATE).unwrap().to_vec();
        o.codec_delay_ns = uint(find(track, CODEC_DELAY).unwrap());

        // The SeekHead's positions land on the elements they name.
        let seeks = children(find(segment, SEEK_HEAD).unwrap());
        let elements = children(segment);
        for (_, seek, _) in &seeks {
            let target = uint(find(seek, SEEK_ID).unwrap()) as u32;
            let position = uint(find(seek, SEEK_POSITION).unwrap()) as usize;
            assert!(
                elements.iter().any(|e| e.0 == target && e.2 == position),
                "seek to {target:x}"
            );
        }
        assert_eq!(seeks.len(), 3);

        let mut clusters = std::collections::HashMap::new();
        for (tag, cluster, offset) in elements {
            if tag != CLUSTER {
                continue;
            }
            let time = uint(find(cluster, TIMESTAMP).unwrap());
            clusters.insert(offset as u64, time);
            for (tag, data, _) in children(cluster) {
                let block = match tag {
                    SIMPLE_BLOCK => data,
                    BLOCK_GROUP => {
                        let padding = find(data, DISCARD_PADDING).unwrap();
                        o.discard_padding_ns = i64::from_be_bytes(padding.try_into().unwrap());
                        find(data, BLOCK).unwrap()
                    }
                    _ => continue,
                };
                assert_eq!(block[0], 0x81, "track 1");
                let relative = i16::from_be_bytes([block[1], block[2]]) as i64;
                o.packets
                    .push((time as i64 + relative, block[4..].to_vec()));
            }
        }
        for (_, point, _) in children(find(segment, CUES).unwrap()) {
            let time = uint(find(point, CUE_TIME).unwrap());
            let position = uint(
                find(
                    find(point, CUE_TRACK_POSITIONS).unwrap(),
                    CUE_CLUSTER_POSITION,
                )
                .unwrap(),
            );
            o.cues.push((time, clusters[&position]));
        }
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_take_as_few_bytes_as_they_can() {
        assert_eq!(size(0), vec![0x80]);
        assert_eq!(size(126), vec![0xFE]);
        // 127 in one byte would read as "unknown size".
        assert_eq!(size(127), vec![0x40, 0x7F]);
        assert_eq!(size(300), vec![0x41, 0x2C]);
        assert_eq!(id(SEGMENT), vec![0x18, 0x53, 0x80, 0x67]);
        assert_eq!(id(SIMPLE_BLOCK), vec![0xA3]);
    }

    #[test]
    fn a_written_file_reads_back_with_its_times_cues_and_padding() {
        let mut w = OpusWriter::new(std::io::Cursor::new(Vec::new()), 16_000, 312).unwrap();
        let packets = 2 * BLOCKS_PER_CLUSTER + 7;
        for i in 0..packets - 1 {
            w.write(&[i as u8; 60]).unwrap();
        }
        let file = w
            .finish(&[0xEE; 300], 903, Duration::from_millis(10_133))
            .unwrap()
            .into_inner();

        let o = read::opus(&file);
        assert_eq!(&o.head[..8], b"OpusHead");
        assert_eq!(u16::from_le_bytes([o.head[10], o.head[11]]), 312);
        assert_eq!(o.codec_delay_ns, 6_500_000);
        assert_eq!(o.duration_ms, 10_133.0);
        assert_eq!(o.packets.len(), packets);
        // 20 ms apart, from zero.
        assert_eq!(o.packets[0].0, 0);
        assert_eq!(o.packets[1].0, 20);
        assert_eq!(o.packets[packets - 1].0, (packets as i64 - 1) * 20);
        assert_eq!(o.packets[3].1, vec![3u8; 60]);
        assert_eq!(o.packets[packets - 1].1, vec![0xEE; 300]);
        assert_eq!(o.discard_padding_ns, 18_812_500);
        // A cue for each cluster, pointing at it.
        assert_eq!(o.cues.len(), 3);
        for (time, cluster) in &o.cues {
            assert_eq!(time, cluster);
        }
        assert_eq!(o.cues[1].0, 250 * 20);
    }
}
