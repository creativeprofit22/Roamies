//! 16 kHz mono audio as base64 s16le, for the shadow helper's `audio` / `transcribe` lines (std only).

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(samples: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// None for anything that isn't well-formed base64 of whole s16 samples.
pub fn decode(text: &str) -> Option<Vec<f32>> {
    let text = text.trim().as_bytes();
    if !text.len().is_multiple_of(4) {
        return None;
    }
    let mut bytes = Vec::with_capacity(text.len() / 4 * 3);
    for (q, chunk) in text.chunks(4).enumerate() {
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && q + 1 != text.len() / 4) {
            return None;
        }
        let mut n = 0u32;
        for &c in &chunk[..4 - pad] {
            let v = ALPHABET.iter().position(|&a| a == c)? as u32;
            n = n << 6 | v;
        }
        n <<= 6 * pad as u32;
        bytes.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8][..3 - pad]);
    }
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    Some(bytes.chunks(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32767.0).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_within_one_step() {
        for n in [0usize, 1, 2, 3, 4, 5, 16_000] {
            let s: Vec<f32> = (0..n).map(|i| ((i as f32) * 0.37).sin() * 0.9).collect();
            let back = decode(&encode(&s)).unwrap();
            assert_eq!(back.len(), n);
            assert!(s.iter().zip(&back).all(|(a, b)| (a - b).abs() <= 1.0 / 32767.0), "n={n}");
        }
    }

    #[test]
    fn known_bytes_and_clamping() {
        // 1 → 0x7fff, -2 clamps to -32767 = 0x8001: bytes ff 7f 01 80.
        assert_eq!(encode(&[1.0, -2.0]), "/38BgA==");
        assert_eq!(encode(&[0.0]), "AAA=");
    }

    #[test]
    fn rejects_garbage() {
        for bad in ["abc", "AA=A", "@@@@", "AA==AAAA", "AA=="] {
            assert!(decode(bad).is_none(), "{bad}");
        }
    }
}
