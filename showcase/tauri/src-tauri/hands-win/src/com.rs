// COM apartment for the worker thread. A thread someone already initialized differently (RPC_E_CHANGED_MODE)
// still works, it just mustn't be uninitialized by us. Idea from oh-my-pi, written fresh.
use w32::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
use w32::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

pub struct ComGuard {
    uninit: bool,
}

impl ComGuard {
    pub fn mta() -> Result<ComGuard, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr == S_OK || hr == S_FALSE {
            Ok(ComGuard { uninit: true })
        } else if hr == RPC_E_CHANGED_MODE {
            Ok(ComGuard { uninit: false })
        } else {
            Err(format!("COM didn't start: {hr:?}"))
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.uninit {
            unsafe { CoUninitialize() };
        }
    }
}
