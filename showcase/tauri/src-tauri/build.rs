// Builds the platform helpers into the sidecar paths Tauri bundles (externalBin):
// macOS: the Swift roamies-voice (talk chord + speech) and roamies-hands (window capture, app control).
// Windows x64: one Rust helper per engine in voice-engines.json (roamies-voice-moonshine from voice-rs,
// whose Moonshine runtime ships as resources, and roamies-voice-parakeet from voice-win), plus the
// screen helper roamies-hands from hands-win (see docs/hands.md).
fn main() {
    #[cfg(target_os = "macos")]
    {
        build_swift_helper("voice");
        build_swift_helper("hands");
    }
    #[cfg(windows)]
    {
        build_rust_helpers();
        build_hands_helper();
    }
    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn build_swift_helper(name: &str) {
    use std::path::PathBuf;
    use std::process::Command;
    println!("cargo:rerun-if-changed={name}/main.swift");
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let arch = if target.starts_with("aarch64") { "arm64" } else { "x86_64" };
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets this")).join("binaries");
    std::fs::create_dir_all(&dir).expect("create binaries dir");
    let out = dir.join(format!("roamies-{name}-{target}"));
    let status = Command::new("swiftc")
        .args(["-O", "-swift-version", "5", "-target", &format!("{arch}-apple-macos11.0"), "-o"])
        .arg(&out)
        .arg(format!("{name}/main.swift"))
        .status()
        .expect("swiftc not found (install the Xcode Command Line Tools)");
    assert!(status.success(), "compiling the {name} helper failed");
}

#[cfg(windows)]
fn build_rust_helpers() {
    const RUNTIME: [&str; 6] =
        ["moonshine.dll", "onnxruntime.dll", "msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    // Moonshine publishes only an x86_64 Windows runtime, so voice is x64-only on Windows.
    assert!(target == "x86_64-pc-windows-msvc", "Windows voice needs x86_64-pc-windows-msvc, not {target}");
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets this"));
    let runtime = root.join("voice-rs").join("models").join("moonshine-runtime");
    for f in RUNTIME.iter().copied().chain(["licenses"]) {
        println!("cargo:rerun-if-changed=voice-rs/models/moonshine-runtime/{f}");
        assert!(runtime.join(f).exists(), "missing {}: run voice-rs/fetch-moonshine.sh --runtime", runtime.join(f).display());
    }
    // Both helpers share voice-core (protocol, session, chord) by path.
    for p in ["src", "Cargo.toml", "Cargo.lock"] {
        println!("cargo:rerun-if-changed=voice-core/{p}");
    }
    println!("cargo:rerun-if-changed=voice-engines.json");
    let text = std::fs::read_to_string(root.join("voice-engines.json")).expect("read voice-engines.json");
    let registry: serde_json::Value = serde_json::from_str(&text).expect("parse voice-engines.json");
    for e in registry["engines"].as_array().expect("voice-engines.json: engines") {
        let field = |k: &str| e[k].as_str().unwrap_or_else(|| panic!("voice-engines.json: engine without {k}"));
        build_rust_helper(&root, &target, field("crate"), field("helper"));
    }
}

// The Windows twin of hands/main.swift; x64 only, like the voice helpers asserted above.
#[cfg(windows)]
fn build_hands_helper() {
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets this"));
    println!("cargo:rerun-if-changed=hands-win/hands-off.json");
    println!("cargo:rerun-if-changed=hands-win/licenses");
    build_rust_helper(&root, &target, "hands-win", "roamies-hands");
}

// Always a release build: a debug one is far too slow at reading speech.
#[cfg(windows)]
fn build_rust_helper(root: &std::path::Path, target: &str, krate: &str, bin: &str) {
    let crate_dir = root.join(krate);
    for p in ["src", "Cargo.toml", "Cargo.lock", ".cargo/config.toml"] {
        println!("cargo:rerun-if-changed={krate}/{p}");
    }
    // Run in the crate dir so its own .cargo/config.toml applies (voice-rs: +crt-static, to match
    // sherpa-onnx), with our flags and target dir kept out of it.
    let target_dir = crate_dir.join("target");
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(&crate_dir)
        .args(["build", "--release", "--locked", "--target", target, "--bin", bin])
        .env("CARGO_TARGET_DIR", &target_dir)
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env_remove("RUSTFLAGS")
        .env_remove("CARGO_BUILD_TARGET")
        .env_remove("CARGO_PROFILE_RELEASE_DEBUG")
        .status()
        .unwrap_or_else(|e| panic!("run cargo for {krate}: {e}"));
    assert!(status.success(), "building the {krate} helper failed");
    let built = target_dir.join(target).join("release").join(format!("{bin}.exe"));
    let dir = root.join("binaries");
    std::fs::create_dir_all(&dir).expect("create binaries dir");
    std::fs::copy(&built, dir.join(format!("{bin}-{target}.exe"))).unwrap_or_else(|e| panic!("copy {bin}.exe: {e}"));
}
