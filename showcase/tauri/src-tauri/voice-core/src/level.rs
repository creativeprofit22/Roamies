//! Microphone level for the listening animation.

/// Microphone level 0-1 from RMS, the same curve as the Mac helper.
pub fn level(samples: &[f32]) -> f64 {
    let n = samples.len().max(1) as f64;
    let rms = (samples.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / n).sqrt();
    ((20.0 * rms.max(1e-7).log10() + 55.0) / 40.0).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_is_bounded() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 160]), 0.0);
        assert_eq!(level(&[1.0; 160]), 1.0);
        let mid = level(&[0.01; 160]);
        assert!((mid - 0.375).abs() < 1e-6, "{mid}");
    }
}
