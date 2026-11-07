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

/// Word edits split by kind, with `reference` as the truth (jiwer's naming).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Edits {
    pub sub: usize,
    pub ins: usize,
    pub del: usize,
}

impl Edits {
    pub fn total(&self) -> usize {
        self.sub + self.ins + self.del
    }
}

/// Minimum word alignment of `hypothesis` against `reference`. On a tie the backtrace prefers a
/// substitution, then a deletion, then an insertion, so the counts are stable.
pub fn word_alignment(reference: &[String], hypothesis: &[String]) -> Edits {
    let (n, m) = (reference.len(), hypothesis.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let sub = d[i - 1][j - 1] + usize::from(reference[i - 1] != hypothesis[j - 1]);
            d[i][j] = sub.min(d[i - 1][j] + 1).min(d[i][j - 1] + 1);
        }
    }
    let (mut i, mut j, mut e) = (n, m, Edits::default());
    while i > 0 || j > 0 {
        if i > 0 && j > 0 {
            let differ = reference[i - 1] != hypothesis[j - 1];
            if d[i][j] == d[i - 1][j - 1] + usize::from(differ) {
                e.sub += usize::from(differ);
                i -= 1;
                j -= 1;
                continue;
            }
        }
        if i > 0 && d[i][j] == d[i - 1][j] + 1 {
            e.del += 1;
            i -= 1;
        } else {
            e.ins += 1;
            j -= 1;
        }
    }
    e
}

/// Word-level Levenshtein distance (substitutions + insertions + deletions).
pub fn word_edits(reference: &[String], hypothesis: &[String]) -> usize {
    word_alignment(reference, hypothesis).total()
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
    fn word_alignment_splits_sub_ins_del() {
        let e = |sub, ins, del| Edits { sub, ins, del };
        assert_eq!(word_alignment(&words("a b c"), &words("a b c")), e(0, 0, 0));
        assert_eq!(word_alignment(&words("a b c"), &words("a x c")), e(1, 0, 0));
        assert_eq!(word_alignment(&words("a b c"), &words("a c")), e(0, 0, 1));
        assert_eq!(word_alignment(&words("a b"), &words("a b c d")), e(0, 2, 0));
        assert_eq!(word_alignment(&words("a b c"), &[]), e(0, 0, 3));
        assert_eq!(word_alignment(&[], &words("a")), e(0, 1, 0));
        assert_eq!(word_alignment(&words("the cat sat"), &words("a cat sat down")), e(1, 1, 0));
        // "a b" vs "b": one deletion, never a substitution plus a deletion
        assert_eq!(word_alignment(&words("a b"), &words("b")), e(0, 0, 1));
        assert_eq!(word_alignment(&[], &[]), e(0, 0, 0));
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
