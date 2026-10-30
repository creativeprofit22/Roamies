// The Node sidecar (the agent): finding Node, starting it and reading its messages.

use super::*;
use std::io::{BufRead, BufReader};

fn find_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ROAMIES_NODE") {
        return Some(PathBuf::from(p));
    }
    // The Node.js shipped inside the app (bundle.externalBin), so users don't need Node installed.
    if let Some(p) = helper_binary("node") {
        return Some(p);
    }
    // GUI apps don't get the shell's PATH on macOS, so check the usual installs too.
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "C:\\Program Files\\nodejs"] {
        dirs.push(PathBuf::from(d));
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

// Tauri's resource_dir is a verbatim `\\?\C:\...` path on Windows, which Node can't load as a script.
fn plain_path(p: PathBuf) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

fn sidecar_script(app: &AppHandle) -> PathBuf {
    let bundled = app.path().resource_dir().map(|d| plain_path(d.join("sidecar").join("sidekick.mjs")));
    match bundled {
        Ok(p) if p.is_file() => p,
        _ => PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/sidekick.mjs")),
    }
}

pub(crate) fn spawn_sidecar(app: &AppHandle) {
    let Some(node) = find_node() else {
        fallback_menu(app, "Sidekick's runtime is missing; reinstall Roamies");
        return;
    };
    let script = sidecar_script(app);
    let stderr = log_stdio("sidekick.log");
    let mut cmd = Command::new(node);
    hide_console(&mut cmd);
    cmd.arg(&script)
        .env("ROAMIES_VERSION", app.package_info().version.to_string())
        .env("ROAMIES_HANDS", helper_binary("roamies-hands").map(|p| p.to_string_lossy().into_owned()).unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr);
    if let Some(dir) = script.parent() {
        cmd.current_dir(dir);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            fallback_menu(app, &format!("Sidekick failed to start: {e}"));
            return;
        }
    };
    *app.state::<Sidecar>().0.lock().unwrap() = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || handle_sidecar(&app2, msg));
        }
        let _ = child.wait();
        *app.state::<Sidecar>().0.lock().unwrap() = None;
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || fallback_menu(&app2, "Sidekick stopped"));
    });
}

#[cfg(test)]
mod tests {
    use super::plain_path;
    use std::path::PathBuf;

    #[test]
    fn plain_path_strips_verbatim_drive_prefix_only() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\E:\app\sidekick.mjs")), PathBuf::from(r"E:\app\sidekick.mjs"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\srv\share")), PathBuf::from(r"\\?\UNC\srv\share"));
        assert_eq!(plain_path(PathBuf::from("/Applications/Roamies.app")), PathBuf::from("/Applications/Roamies.app"));
    }
}
