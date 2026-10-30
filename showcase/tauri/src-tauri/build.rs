// Builds the platform helpers into the sidecar paths Tauri bundles (externalBin):
// macOS: the Swift roamies-voice (talk chord + speech) and roamies-hands (window capture, app control).
// Windows x64: the Rust roamies-voice in voice-rs; its Moonshine runtime ships as resources.
fn main() {
    #[cfg(target_os = "macos")]
    {
        build_swift_helper("voice");
        build_swift_helper("hands");
    }
    #[cfg(windows)]
    build_rust_voice();
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
fn build_rust_voice() {
    use std::path::PathBuf;
    use std::process::Command;
    const RUNTIME: [&str; 6] =
        ["moonshine.dll", "onnxruntime.dll", "msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    // Moonshine publishes only an x86_64 Windows runtime, so voice is x64-only on Windows.
    assert!(target == "x86_64-pc-windows-msvc", "Windows voice needs x86_64-pc-windows-msvc, not {target}");
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets this"));
    let crate_dir = root.join("voice-rs");
    for p in ["src", "Cargo.toml", "Cargo.lock", ".cargo/config.toml"] {
        println!("cargo:rerun-if-changed=voice-rs/{p}");
    }
    let runtime = crate_dir.join("models").join("moonshine-runtime");
    for f in RUNTIME.iter().copied().chain(["licenses"]) {
        println!("cargo:rerun-if-changed=voice-rs/models/moonshine-runtime/{f}");
        assert!(runtime.join(f).exists(), "missing {}: run voice-rs/fetch-moonshine.sh --runtime", runtime.join(f).display());
    }
    // Run in voice-rs so its .cargo/config.toml (+crt-static, to match sherpa-onnx) applies, with
    // our own flags and target dir kept out of it.
    let target_dir = crate_dir.join("target");
    let status = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(&crate_dir)
        .args(["build", "--release", "--locked", "--target", &target])
        .env("CARGO_TARGET_DIR", &target_dir)
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env_remove("RUSTFLAGS")
        .env_remove("CARGO_BUILD_TARGET")
        .env_remove("CARGO_PROFILE_RELEASE_DEBUG")
        .status()
        .expect("run cargo for voice-rs");
    assert!(status.success(), "building the voice-rs helper failed");
    let built = target_dir.join(&target).join("release").join("roamies-voice.exe");
    let dir = root.join("binaries");
    std::fs::create_dir_all(&dir).expect("create binaries dir");
    std::fs::copy(&built, dir.join(format!("roamies-voice-{target}.exe"))).expect("copy roamies-voice.exe");
}
