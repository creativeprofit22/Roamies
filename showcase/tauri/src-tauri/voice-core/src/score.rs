//! Bench scoring shared by both helpers' `--bench`: the same text normalisation and WER everywhere.

use std::fs;
use std::path::{Path, PathBuf};

/// Lowercase words; punctuation dropped except apostrophes inside words ("don't", not "'quoted'").
pub fn normalize(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.to_lowercase().chars().collect();
    let mut out = String::with_capacity(chars.len());
    for (i, &c) in chars.iter().enumerate() {
        let inner_apostrophe = (c == '\'' || c == '’')
            && i > 0
            && i + 1 < chars.len()
            && chars[i - 1].is_alphanumeric()
            && chars[i + 1].is_alphanumeric();
        if c.is_alphanumeric() {
            out.push(c);
        } else if inner_apostrophe {
            out.push('\'');
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace().map(str::to_string).collect()
}

/// Word-level Levenshtein distance (substitutions + insertions + deletions).
pub fn word_edits(reference: &[String], hypothesis: &[String]) -> usize {
    let mut prev: Vec<usize> = (0..=hypothesis.len()).collect();
    for (i, r) in reference.iter().enumerate() {
        let mut cur = vec![i + 1; hypothesis.len() + 1];
        for (j, h) in hypothesis.iter().enumerate() {
            let sub = prev[j] + usize::from(r != h);
            cur[j + 1] = sub.min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[hypothesis.len()]
}

/// Nearest-rank percentile (p in 0..=100) of unsorted values.
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let rank = ((p / 100.0) * v.len() as f64).ceil().max(1.0) as usize;
    Some(v[rank.min(v.len()) - 1])
}

/// `*.wav` files with a same-stem `*.txt`, sorted by name.
pub fn find_pairs(dir: &Path) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut pairs: Vec<(PathBuf, PathBuf)> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")))
        .filter_map(|wav| {
            let txt = wav.with_extension("txt");
            txt.is_file().then_some((wav, txt))
        })
        .collect();
    pairs.sort();
    Ok(pairs)
}

/// Bytes in a file or, recursively, a folder (model and runtime sizes).
pub fn dir_bytes(path: &Path) -> u64 {
    match fs::metadata(path) {
        Ok(m) if m.is_file() => m.len(),
        Ok(m) if m.is_dir() => fs::read_dir(path)
            .map(|it| it.filter_map(Result::ok).map(|e| dir_bytes(&e.path())).sum())
            .unwrap_or(0),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        normalize(s)
    }

    #[test]
    fn normalize_lowercases_and_strips_punctuation() {
        assert_eq!(words("Hello, World! It's  'quoted' -- ok."), ["hello", "world", "it's", "quoted", "ok"]);
        assert_eq!(words("DON’T stop"), ["don't", "stop"]);
        assert!(words("  ...  ").is_empty());
    }

    #[test]
    fn word_edits_counts_levenshtein() {
        assert_eq!(word_edits(&words("a b c"), &words("a b c")), 0);
        assert_eq!(word_edits(&words("a b c"), &words("a x c")), 1);
        assert_eq!(word_edits(&words("a b c"), &words("a c")), 1);
        assert_eq!(word_edits(&words("a b"), &words("a b c d")), 2);
        assert_eq!(word_edits(&words("a b c"), &[]), 3);
        assert_eq!(word_edits(&[], &words("a")), 1);
    }

    #[test]
    fn percentile_uses_nearest_rank() {
        let v = [5.0, 1.0, 3.0, 2.0, 4.0];
        assert_eq!(percentile(&v, 50.0), Some(3.0));
        assert_eq!(percentile(&v, 90.0), Some(5.0));
        assert_eq!(percentile(&[], 50.0), None);
    }

    #[test]
    fn find_pairs_needs_matching_txt() {
        let dir = std::env::temp_dir().join(format!("roamies-voice-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for f in ["b.wav", "b.txt", "a.wav", "a.txt", "lonely.wav", "notes.txt"] {
            fs::write(dir.join(f), "x").unwrap();
        }
        let names: Vec<_> = find_pairs(&dir).unwrap().iter().map(|(w, _)| w.file_name().unwrap().to_owned()).collect();
        assert_eq!(names, ["a.wav", "b.wav"]);
        assert_eq!(dir_bytes(&dir), 6);
        fs::remove_dir_all(&dir).unwrap();
    }
}
