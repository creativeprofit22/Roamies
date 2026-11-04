// Windows drops keys and clicks sent to an app with a higher integrity level than ours (UIPI) without any
// error, so act refuses such apps before sending anything. Integrity level, not elevation: an app can be
// above us without being "elevated" (UIAccess, system services' windows).

/// Windows integrity RIDs: untrusted 0, low 0x1000, medium 0x2000, medium-plus 0x2100, high 0x3000, system 0x4000.
pub const MEDIUM: u32 = 0x2000;

/// Input from us would be dropped. An unknown level counts as above us: refusing beats typing into nothing.
pub fn blocked(ours: Option<u32>, theirs: Option<u32>) -> bool {
    match (ours, theirs) {
        (_, None) => true,
        (None, Some(t)) => t > MEDIUM,
        (Some(o), Some(t)) => t > o,
    }
}

pub fn refusal(name: &str) -> serde_json::Value {
    crate::protocol::fail(
        "access_denied",
        &format!(
            "{name} is running as administrator, so Windows would silently drop any clicks or keys from me. Nothing was clicked or typed. Ask the user to do this step, or restart {name} without admin rights."
        ),
    )
}

#[cfg(windows)]
mod sys {
    use crate::windows::Handle;
    use w32::Win32::Foundation::HANDLE;
    use w32::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
    use w32::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    fn level_of(process: HANDLE) -> Option<u32> {
        unsafe {
            let mut tok = HANDLE::default();
            OpenProcessToken(process, TOKEN_QUERY, &mut tok).ok()?;
            let tok = Handle(tok);
            let mut need = 0u32;
            let _ = GetTokenInformation(tok.0, TokenIntegrityLevel, None, 0, &mut need);
            if need < std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 || need > 4096 {
                return None;
            }
            // u64 storage keeps the label's pointer field aligned.
            let mut buf = vec![0u64; (need as usize).div_ceil(8)];
            GetTokenInformation(tok.0, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), need, &mut need).ok()?;
            let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
            let sid = label.Label.Sid;
            if sid.is_invalid() {
                return None;
            }
            let count = GetSidSubAuthorityCount(sid);
            if count.is_null() || *count == 0 {
                return None;
            }
            let rid = GetSidSubAuthority(sid, (*count - 1) as u32);
            (!rid.is_null()).then(|| *rid)
        }
    }

    pub fn ours() -> Option<u32> {
        level_of(unsafe { GetCurrentProcess() })
    }

    pub fn of_pid(pid: u32) -> Option<u32> {
        unsafe {
            let h = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
            level_of(h.0)
        }
    }
}

/// Clicks and keys sent to this process would be dropped (or we can't tell).
#[cfg(windows)]
pub fn input_blocked(pid: u32) -> bool {
    blocked(sys::ours(), sys::of_pid(pid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn higher_or_unknown_levels_are_refused() {
        assert!(!blocked(Some(MEDIUM), Some(MEDIUM)), "same level gets input");
        assert!(!blocked(Some(MEDIUM), Some(0x1000)), "a low-integrity app (sandboxed browser) gets input");
        assert!(blocked(Some(MEDIUM), Some(0x3000)), "an admin app drops our input");
        assert!(blocked(Some(MEDIUM), Some(0x4000)), "a system app drops our input");
        assert!(blocked(Some(MEDIUM), Some(0x2100)), "medium-plus is above medium");
        assert!(!blocked(Some(0x3000), Some(0x3000)), "an admin helper may drive admin apps");
        assert!(blocked(Some(MEDIUM), None), "unknown target level fails closed");
        assert!(blocked(None, Some(0x3000)) && !blocked(None, Some(MEDIUM)), "unknown own level assumes medium");
    }

    #[test]
    fn refusal_is_access_denied() {
        let r = refusal("Registry Editor");
        assert_eq!(r["code"], "access_denied");
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().is_some_and(|e| e.contains("silently drop")));
    }

    #[cfg(windows)]
    #[test]
    fn reads_our_own_level() {
        let l = sys::ours();
        assert!(l.is_some_and(|l| l >= 0x1000), "{l:?}");
        assert!(!input_blocked(std::process::id()), "we can always send input to ourselves");
    }
}
