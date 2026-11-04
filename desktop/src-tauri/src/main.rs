#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use std::sync::{Arc, Mutex};
use std::time::Duration;
mod hit_mask;
mod layout;
mod position;
mod assets;
mod owner_window;
use hit_mask::HitMask;
#[cfg(target_os = "macos")]
extern "C" {
    fn duet_install_window_geometry(window: *mut std::ffi::c_void) -> i32;
    fn duet_begin_window_drag(window: *mut std::ffi::c_void) -> i32;
}

type HitState = Arc<Mutex<HitMask>>;
async fn owner_operation(app: tauri::AppHandle, activate: bool) -> Result<(),String> {
    let (tx,rx)=std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let ok=if activate {owner_window::focus()} else {owner_window::capture();true};
        let _=tx.send(ok);
    }).map_err(|e|e.to_string())?;
    if rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false){Ok(())}else{Err("Unable to activate the owning DSH window".into())}
}
#[tauri::command]
async fn focus_dsh(app:tauri::AppHandle) -> Result<(),String> {owner_operation(app,true).await}
#[tauri::command]
async fn remember_dsh(app:tauri::AppHandle) -> Result<(),String> {owner_operation(app,false).await}
#[tauri::command]
fn avatar_hit_mask(mask: Vec<u8>, avatar: [f64; 4], regions: Vec<[f64; 4]>, state: tauri::State<'_, HitState>) -> Result<(), String> {
    let value=HitMask{mask,avatar,regions};
    if !value.valid() { return Err("Invalid mask".into()); }
    *state.lock().map_err(|_| "Mask unavailable")? = value;
    Ok(())
}

#[tauri::command]
fn hide_avatar(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    position::remember(&window);
    app.exit(0);
}
#[tauri::command]
fn show_avatar(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}
#[tauri::command]
fn avatar_geometry(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    let monitors=window.available_monitors().map_err(|e|e.to_string())?;
    if monitors.is_empty(){return Err("Display unavailable".into());}
    let left=monitors.iter().map(|m|i64::from(m.position().x)).min().unwrap();
    let top=monitors.iter().map(|m|i64::from(m.position().y)).min().unwrap();
    let right=monitors.iter().map(|m|i64::from(m.position().x)+i64::from(m.size().width)).max().unwrap();
    let bottom=monitors.iter().map(|m|i64::from(m.position().y)+i64::from(m.size().height)).max().unwrap();
    let origin=window.inner_position().map_err(|e|e.to_string())?;
    let scale=window.scale_factor().map_err(|e|e.to_string())?;
    Ok(serde_json::json!({"total_resolution":{"width":right-left,"height":bottom-top},
        "desktop_origin":{"x":left,"y":top},"window_origin":{"x":origin.x,"y":origin.y},"scale":scale}))
}
#[tauri::command]
fn drag_avatar(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pointer=window.ns_window().map_err(|e|e.to_string())?;
        if unsafe { duet_begin_window_drag(pointer) } == 1 { Ok(()) }
        else { Err("Unable to start avatar drag".into()) }
    }
    #[cfg(not(target_os = "macos"))]
    window.start_dragging().map_err(|e| e.to_string())
}
fn resize_avatar(window: &tauri::WebviewWindow, size: &str, initial: bool, panel: bool) -> Result<serde_json::Value, String> {
    layout::scale(size)?;
    let saved=if initial { position::restore(window) } else { None };
    let remembered_monitor=saved.as_ref().and_then(|p| {
        window.available_monitors().ok()?.into_iter().find(|m| {
            p.monitor.as_ref().is_some_and(|name|m.name()==Some(name))
                && m.work_area().position.x==p.area[0] && m.work_area().position.y==p.area[1]
        }).or_else(||window.available_monitors().ok()?.into_iter().find(|m|
            p.monitor.as_ref().is_some_and(|name|m.name()==Some(name))))
    });
    let monitor=remembered_monitor.or_else(||if initial {window.current_monitor().ok().flatten()} else {position::character_monitor(window)})
        .or(window.primary_monitor().map_err(|e|e.to_string())?).ok_or("Display unavailable")?;
    let area=monitor.work_area();
    let area=[area.position.x,area.position.y,area.size.width as i32,area.size.height as i32];
    let dpr=monitor.scale_factor();
    let previous=if initial { saved.as_ref().map(|p|p.previous(area,dpr,layout::bottom_padding(panel))) } else {
        let pos=window.inner_position().map_err(|e|e.to_string())?;
        let dim=window.inner_size().map_err(|e|e.to_string())?;
        Some([pos.x,pos.y,dim.width as i32,dim.height as i32])
    };
    let p=if cfg!(target_os="macos") && panel { layout::fit_character(size,dpr,area,previous)? }
        else { layout::fit_panel(size,dpr,area,previous,panel)? };
    window.set_size(tauri::PhysicalSize::new(p.width,p.height)).map_err(|e|e.to_string())?;
    window.set_position(tauri::PhysicalPosition::new(p.x,p.y)).map_err(|e|e.to_string())?;
    Ok(serde_json::json!({"size":size,"scale":p.scale,"fit":p.fit,"width":p.width as f64/dpr,"height":p.height as f64/dpr}))
}
#[tauri::command]
fn set_avatar_size(window: tauri::WebviewWindow, size: String, panel: Option<bool>, state: tauri::State<'_, HitState>) -> Result<serde_json::Value, String> {
    layout::scale(&size)?;
    *state.lock().map_err(|_|"Mask unavailable")?=HitMask::default();
    resize_avatar(&window,&size,false,panel.unwrap_or(false))
}
fn main() {
    owner_window::capture();
    // Portable Windows helper: npm does not run a WebView2 installer.
    // Report a dedicated failure to the Host instead of silently closing.
    #[cfg(target_os = "windows")]
    if tauri::webview_version().is_err() { std::process::exit(78); }
    // A single helper is resized in place; voice playback remains in DSH.
    let url = std::env::var("DUET_AVATAR_IPC").expect("Start this helper from duet");
    let token = std::env::var("DUET_AVATAR_TOKEN").expect("Missing IPC token");
    let endpoint=tauri::Url::parse(&url).expect("Invalid IPC address");
    assert!(endpoint.scheme()=="ws" && endpoint.host_str()==Some("127.0.0.1")
        && endpoint.port().is_some() && endpoint.username().is_empty() && endpoint.password().is_none()
        && endpoint.path()=="/" && endpoint.query().is_none() && endpoint.fragment().is_none()
        && token.len()==64 && token.bytes().all(|c| c.is_ascii_hexdigit()));
    let size=std::env::var("DUET_AVATAR_SIZE").ok().filter(|s|layout::scale(s).is_ok()).unwrap_or_else(||"large".into());
    let asset_path=std::env::var("DUET_AVATAR_ASSETS").expect("Missing local UI assets");
    let files=assets::load(std::path::Path::new(&asset_path)).expect("Invalid local UI assets");
    let init = format!("window.__DUET_AVATAR__={};", serde_json::json!({"url":url,"token":token,"size":size}));
    let hit: HitState = Arc::new(Mutex::new(HitMask::default()));
    tauri::Builder::default()
        .register_uri_scheme_protocol("duet-avatar",move |_context,request| {
            let path=request.uri().path();
            let mime=assets::content_type(path);
            let data=if request.method()==tauri::http::Method::GET {files.get(path)} else {None};
            tauri::http::Response::builder().status(if data.is_some() {200} else {404})
                .header("Content-Type",mime.unwrap_or("text/plain"))
                .header("Content-Security-Policy",assets::CSP)
                .header("X-Content-Type-Options","nosniff").header("Cache-Control","no-store")
                .body(data.cloned().unwrap_or_default()).unwrap()
        })
        .manage(hit.clone())
        .invoke_handler(tauri::generate_handler![hide_avatar, show_avatar, drag_avatar, avatar_hit_mask, set_avatar_size, focus_dsh, remember_dsh, avatar_geometry])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            app.remove_menu()?;
            let win = WebviewWindowBuilder::new(app, "avatar", WebviewUrl::CustomProtocol(tauri::Url::parse("duet-avatar://localhost/index.html")?))
                .title("duet").inner_size(280.0, 490.0).transparent(true)
                .decorations(false).shadow(false).always_on_top(true).skip_taskbar(true)
                .resizable(false).focused(false).accept_first_mouse(true).visible(false)
                .on_navigation(|url| url.path()=="/index.html" && url.query().is_none()
                    && ((url.scheme()=="duet-avatar"&&url.host_str()==Some("localhost"))
                    || (url.scheme()=="http"&&url.host_str()==Some("duet-avatar.localhost"))))
                .initialization_script(&init).build()?;
            #[cfg(target_os = "macos")]
            if unsafe { duet_install_window_geometry(win.ns_window()?) } != 1 {
                return Err(std::io::Error::other("Unable to configure avatar placement").into());
            }
            // Restore once with the final carrier dimensions, not a short temporary
            // window whose work-area clamp destroys a saved upper-screen position.
            resize_avatar(&win,&size,true,true).map_err(std::io::Error::other)?;
            std::thread::spawn(move || {
                let mut ignored = false;
                let mut geometry=None;
                let mut display_check=std::time::Instant::now()-Duration::from_secs(1);
                let mut changed=std::time::Instant::now();
                let mut pending=false;
                loop {
                    std::thread::sleep(Duration::from_millis(50));
                    let Ok(position) = win.inner_position() else { break };
                    let scale = win.scale_factor().unwrap_or(1.0);
                    let size=win.inner_size().ok();
                    let geometry_changed=size.map(|dim|geometry!=Some((position.x,position.y,dim.width,dim.height,scale))).unwrap_or(false);
                    if geometry_changed || display_check.elapsed()>=Duration::from_secs(1) {
                      display_check=std::time::Instant::now();
                      if let Some(monitor)=position::character_monitor(&win) {
                        let area=monitor.work_area();
                        let visible=[(area.position.x as f64-position.x as f64)/scale,
                            (area.position.y as f64-position.y as f64)/scale,
                            area.size.width as f64/scale,area.size.height as f64/scale];
                        // Repeat at the slow display cadence: the first event can
                        // precede the WebView listener during model loading.
                        let _=win.emit("avatar-viewport",visible);
                      }
                    }
                    if let Some(dim)=size {
                        let current=(position.x,position.y,dim.width,dim.height,scale);
                        if geometry!=Some(current) {
                            geometry=Some(current);
                            changed=std::time::Instant::now();
                            pending=true;
                        } else if pending && changed.elapsed()>=Duration::from_millis(500) {
                            position::remember(&win);
                            pending=false;
                        }
                    }
                    let target = if let Ok(cursor) = win.cursor_position() {
                        let (x,y) = ((cursor.x-position.x as f64)/scale,(cursor.y-position.y as f64)/scale);
                        // Window calls can synchronously dispatch to the main thread, whose
                        // avatar_hit_mask command takes HitState. Never hold it across them.
                        let (over_avatar, ignore_cursor) = {
                            let Ok(h) = hit.lock() else { break };
                            (h.hits_avatar(x,y), h.ignores(x,y))
                        };
                        // Relative pointer state remains available while transparent pixels pass through.
                        // No pointer coordinates leave this local helper.
                        let inside=size.map(|s|x>=0.0&&y>=0.0&&x<s.width as f64/scale&&y<s.height as f64/scale).unwrap_or(false);
                        let _=win.emit("avatar-pointer",serde_json::json!({"x":if inside{x}else{-1.0},"y":if inside{y}else{-1.0},"overAvatar":over_avatar}));
                        ignore_cursor
                    } else { false };
                    if target!=ignored && win.set_ignore_cursor_events(target).is_ok() { ignored=target; }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!()).expect("duet companion failed");
}
