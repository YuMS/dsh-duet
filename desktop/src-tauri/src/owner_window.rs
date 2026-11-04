// Only the application owning this companion may be activated. No URLs or
// process IDs are accepted from menu actions.
#[cfg(not(target_os = "macos"))]
fn matches_owner(name: &str) -> bool {
    let name=name.to_lowercase();
    let words:Vec<_>=name.split(|c:char|!c.is_ascii_alphanumeric()).collect();
    let has=|value:&str|words.contains(&value);
    let kind=std::env::var("DUET_AVATAR_OWNER_KIND").unwrap_or_else(|_|"browser".into());
    match kind.as_str() {
        "desktop" => has("dsh") || has("deepseek"),
        "chrome" => has("chrome") || has("chromium") || has("brave") || has("arc"),
        "edge" => has("msedge") || name.contains("microsoft-edge"),
        "firefox" => has("firefox"),
        "safari" => has("safari"),
        _ => ["chrome","chromium","brave","firefox","msedge","safari","arc"].iter().any(|s|has(s)) || name.contains("microsoft-edge"),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    extern "C" { fn duet_remember_owner() -> i32; fn duet_focus_owner() -> i32; }
    pub fn capture() { unsafe { duet_remember_owner(); } }
    pub fn focus() -> bool { unsafe { duet_focus_owner()==1 } }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::sync::Mutex;
    type Handle=*mut c_void;
    static OWNER: Mutex<Option<(usize,u32)>>=Mutex::new(None);
    #[link(name="user32")]
    extern "system" {
        fn GetForegroundWindow() -> Handle;
        fn GetWindowThreadProcessId(window: Handle, pid: *mut u32) -> u32;
        fn IsWindow(window: Handle) -> i32;
        fn IsIconic(window: Handle) -> i32;
        fn ShowWindow(window: Handle, command: i32) -> i32;
        fn SetForegroundWindow(window: Handle) -> i32;
    }
    #[link(name="kernel32")]
    extern "system" {
        fn OpenProcess(access:u32, inherit:i32, pid:u32) -> Handle;
        fn QueryFullProcessImageNameW(process:Handle, flags:u32, path:*mut u16, size:*mut u32) -> i32;
        fn CloseHandle(handle:Handle) -> i32;
    }
    fn identity(window:Handle) -> Option<u32> {
        unsafe {
            if window.is_null() || IsWindow(window)==0 {return None}
            let mut pid=0;GetWindowThreadProcessId(window,&mut pid);
            if pid==std::process::id(){return None}
            let process=OpenProcess(0x1000,0,pid);if process.is_null(){return None}
            let mut path=[0u16;32768];let mut size=path.len() as u32;
            let ok=QueryFullProcessImageNameW(process,0,path.as_mut_ptr(),&mut size)!=0;
            CloseHandle(process);
            if !ok{return None}
            let path=String::from_utf16_lossy(&path[..size as usize]);
            if super::matches_owner(path.rsplit(['\\','/']).next().unwrap_or("")) {Some(pid)} else {None}
        }
    }
    pub fn capture() {
        unsafe {let window=GetForegroundWindow();if let Some(pid)=identity(window){if let Ok(mut owner)=OWNER.lock(){*owner=Some((window as usize,pid));}}}
    }
    pub fn focus() -> bool {
        let Some((raw,pid))=OWNER.lock().ok().and_then(|v|*v) else{return false};
        let window=raw as Handle;if identity(window)!=Some(pid){return false}
        unsafe {if IsIconic(window)!=0 {ShowWindow(window,9);}SetForegroundWindow(window)!=0}
    }
}

#[cfg(not(any(target_os = "windows",target_os = "macos")))]
mod platform {
    use std::sync::Mutex;
    use std::process::Command;
    static OWNER:Mutex<Option<(String,String)>>=Mutex::new(None);
    fn query(args:&[&str]) -> Option<String> {
        let output=Command::new("/usr/bin/xprop").args(args).output().ok()?;
        output.status.success().then(||String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
    fn identity(id:&str) -> Option<String> {
        let class=query(&["-id",id,"WM_CLASS"])?;
        if !super::matches_owner(&class){return None}
        let pid=query(&["-id",id,"_NET_WM_PID"])?;
        if !pid.contains(" = "){return None}Some(format!("{class}\n{pid}"))
    }
    pub fn capture() {
        let Some(active)=query(&["-root","_NET_ACTIVE_WINDOW"]) else{return};
        let id=active.split_whitespace().last().unwrap_or("");
        if !id.starts_with("0x")||!id[2..].chars().all(|c|c.is_ascii_hexdigit()){return}
        if let Some(value)=identity(id){if let Ok(mut owner)=OWNER.lock(){*owner=Some((id.into(),value));}}
    }
    pub fn focus() -> bool {
        let Some((id,previous))=OWNER.lock().ok().and_then(|v|v.clone()) else{return false};
        if identity(&id).as_ref()!=Some(&previous){return false}
        Command::new("/usr/bin/wmctrl").args(["-ia",&id]).status().is_ok_and(|s|s.success())
    }
}
pub use platform::{capture,focus};
