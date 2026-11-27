// Suppress only the local visual carrier. Audio, IPC and task processing continue.
#[derive(Default)]
pub struct Visibility {
    requested: bool,
    suppressed: bool,
    clear_since: Option<u64>,
    last_observation: Option<u64>,
    pub visible: bool,
}

impl Visibility {
    pub fn request(&mut self) { self.requested = true; }
    pub fn observe(&mut self, fullscreen: Option<bool>, now: u64) {
        let fullscreen = match fullscreen {
            Some(value) => { self.last_observation = Some(now); value }
            // A failed OS query must not leave the companion permanently hidden.
            None if self.last_observation.is_some_and(|t| now.saturating_sub(t) < 3000) => return,
            None => false,
        };
        if fullscreen {
            self.suppressed = true;
            self.clear_since = None;
        } else if self.suppressed {
            let since = *self.clear_since.get_or_insert(now);
            if now.saturating_sub(since) >= 800 { self.suppressed = false; }
        }
    }
    pub fn desired(&self) -> bool { self.requested && !self.suppressed }
}

// Coordinates must all be physical pixels (Windows) or display points (macOS).
pub fn covers(window: [f64; 4], screen: [f64; 4]) -> bool {
    window.iter().chain(screen.iter()).all(|n| n.is_finite())
        && screen[2] > screen[0] && screen[3] > screen[1]
        && window[0] <= screen[0] + 1.0 && window[1] <= screen[1] + 1.0
        && window[2] >= screen[2] - 1.0 && window[3] >= screen[3] - 1.0
}

pub type State = std::sync::Arc<std::sync::Mutex<Visibility>>;

pub fn refresh(window: &tauri::WebviewWindow, state: &State, request: bool) -> Result<(), String> {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    let now = START.get_or_init(Instant::now).elapsed().as_millis() as u64;
    let observation = platform::detect(window);
    let (target, applied) = {
        let mut guard = state.lock().map_err(|_| "Visibility unavailable")?;
        if request { guard.request(); }
        guard.observe(observation, now);
        (guard.desired(), guard.visible)
    };
    // Check both the last applied intent and the HWND. Native visibility alone
    // cannot prove that Tao's cached window flags were synchronized.
    #[cfg(target_os = "windows")]
    let native_matches = platform::visible(window)? == target;
    #[cfg(not(target_os = "windows"))]
    let native_matches = true;
    if target == applied && native_matches { return Ok(()); }
    // Called on the UI thread. Do not keep the state lock across native window calls.
    if target { platform::show(window)?; } else { platform::hide(window)?; }
    #[cfg(target_os = "windows")]
    let visible = platform::visible(window)?;
    #[cfg(not(target_os = "windows"))]
    let visible = target;
    state.lock().map_err(|_| "Visibility unavailable")?.visible = visible;
    if target && !visible { return Err("Avatar window did not become visible".into()); }
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    extern "C" {
        fn duet_fullscreen_at_character(window: *mut std::ffi::c_void, top: f64) -> i32;
        fn duet_show_without_activation(window: *mut std::ffi::c_void);
    }
    pub fn detect(window: &tauri::WebviewWindow) -> Option<bool> {
        let size = window.inner_size().ok()?;
        let scale = window.scale_factor().ok()?;
        let unit = size.width as f64 / 380.0;
        let top = ((crate::layout::CHARACTER_TOP - crate::layout::bottom_padding(true))
            * unit / 2.0 + size.height as f64 / 2.0) / scale;
        match unsafe { duet_fullscreen_at_character(window.ns_window().ok()?, top) } {
            0 => Some(false), 1 => Some(true), _ => None,
        }
    }
    pub fn show(window: &tauri::WebviewWindow) -> Result<(), String> {
        unsafe { duet_show_without_activation(window.ns_window().map_err(|e| e.to_string())?); }
        Ok(())
    }
    pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> {
        window.hide().map_err(|e|e.to_string())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)] #[derive(Default)]
    struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
    #[repr(C)] #[derive(Default)]
    struct Point { x: i32, y: i32 }
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> Handle;
        fn GetDesktopWindow() -> Handle;
        fn GetShellWindow() -> Handle;
        fn GetWindowThreadProcessId(window: Handle, pid: *mut u32) -> u32;
        fn IsWindowVisible(window: Handle) -> i32;
        fn IsIconic(window: Handle) -> i32;
        fn GetClientRect(window: Handle, rect: *mut Rect) -> i32;
        fn ClientToScreen(window: Handle, point: *mut Point) -> i32;
        fn ShowWindow(window: Handle, command: i32) -> i32;
        fn SetWindowPos(window: Handle, after: Handle, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(window: Handle, attribute: u32, value: *mut c_void, size: u32) -> i32;
    }
    pub fn detect(window: &tauri::WebviewWindow) -> Option<bool> {
        let monitor = crate::position::character_monitor(window)?;
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.is_null() { return None; }
            let mut pid = 0;
            if GetWindowThreadProcessId(foreground, &mut pid) == 0 { return None; }
            if pid == std::process::id() || foreground == GetDesktopWindow()
                || foreground == GetShellWindow() || IsIconic(foreground) != 0
                || IsWindowVisible(foreground) == 0 { return Some(false); }
            let mut cloaked: u32 = 0;
            if DwmGetWindowAttribute(foreground, 14, (&mut cloaked as *mut u32).cast(), 4) == 0
                && cloaked != 0 { return Some(false); }
            let mut bounds = Rect::default();
            if DwmGetWindowAttribute(foreground, 9, (&mut bounds as *mut Rect).cast(),
                std::mem::size_of::<Rect>() as u32) != 0 { return None; }
            let p = monitor.position(); let s = monitor.size();
            let screen = [p.x as f64, p.y as f64, p.x as f64 + s.width as f64, p.y as f64 + s.height as f64];
            if !super::covers([bounds.left as f64, bounds.top as f64, bounds.right as f64, bounds.bottom as f64], screen) {
                return Some(false);
            }
            // A maximized decorated window is not a fullscreen game, even with
            // an auto-hidden taskbar. Its client area still excludes the title bar.
            let mut client = Rect::default(); let mut origin = Point::default();
            if GetClientRect(foreground, &mut client) == 0 || ClientToScreen(foreground, &mut origin) == 0 {
                return None;
            }
            Some(super::covers([origin.x as f64, origin.y as f64,
                origin.x as f64 + client.right as f64, origin.y as f64 + client.bottom as f64], screen))
        }
    }
    pub fn show(window: &tauri::WebviewWindow) -> Result<(), String> {
        // Synchronize Tao's VISIBLE flag before touching the HWND. Otherwise a
        // later set_ignore_cursor_events() reapplies the cached hidden style
        // when the pointer crosses the avatar, hiding it until the next probe.
        window.show().map_err(|e|e.to_string())?;
        // SWP_SHOWWINDOW is not overridden by STARTUPINFO's SW_HIDE. Preserve
        // position/size and never take focus. Keep this native startup fallback.
        let hwnd = window.hwnd().map_err(|e|e.to_string())?.0 as Handle;
        if unsafe { SetWindowPos(hwnd, -1isize as Handle, 0, 0, 0, 0, 0x0001|0x0002|0x0010|0x0040) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    pub fn visible(window: &tauri::WebviewWindow) -> Result<bool, String> {
        Ok(unsafe { IsWindowVisible(window.hwnd().map_err(|e|e.to_string())?.0 as Handle) } != 0)
    }
    pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> {
        // Keep Tao's cached flags in sync on fullscreen suppression as well.
        window.hide().map_err(|e|e.to_string())?;
        unsafe { ShowWindow(window.hwnd().map_err(|e|e.to_string())?.0 as Handle, 0); }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    pub fn detect(_: &tauri::WebviewWindow) -> Option<bool> { Some(false) }
    pub fn show(window: &tauri::WebviewWindow) -> Result<(), String> { window.show().map_err(|e| e.to_string()) }
    pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> { window.hide().map_err(|e| e.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn never_shows_before_renderer_ready() {
        let mut state = Visibility::default(); state.observe(Some(false), 0);
        assert!(!state.desired());
    }
    #[test] fn ready_during_fullscreen_does_not_flash() {
        let mut state = Visibility::default(); state.observe(Some(true), 0); state.request();
        assert!(!state.desired()); state.request(); assert!(!state.desired());
    }
    #[test] fn restores_after_stable_exit_and_not_during_space_switch() {
        let mut state = Visibility::default(); state.request();
        assert!(state.desired()); state.observe(Some(true), 0); assert!(!state.desired());
        state.observe(Some(false), 500); state.observe(Some(true), 1000);
        state.observe(Some(false), 1500); state.observe(Some(false), 2200); assert!(!state.desired());
        state.observe(Some(false), 2500); assert!(state.desired());
    }
    #[test] fn failed_probes_eventually_recover_without_flashing_on_one_failure() {
        let mut state = Visibility::default(); state.request(); state.observe(Some(true), 0);
        state.observe(None, 500); assert!(!state.desired());
        state.observe(None, 3000); state.observe(None, 4000); assert!(state.desired());
    }
    #[test] fn full_display_not_work_area_or_other_monitor() {
        let screen = [-1920., 0., 0., 1080.];
        assert!(covers(screen, screen));
        assert!(!covers([-1920., 0., 0., 1040.], screen));
        assert!(!covers([0., 0., 1920., 1080.], screen));
        assert!(!covers([f64::NAN, 0., 0., 1080.], screen));
    }
}
