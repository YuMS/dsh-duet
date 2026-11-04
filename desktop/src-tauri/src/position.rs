// Local-only placement preferences. Never hold HitState while accessing a window.
use std::{fs, path::Path};
use serde_json::{json, Value};
use tauri::Manager;

#[derive(Debug, PartialEq)]
pub struct Placement {
    pub monitor: Option<String>,
    pub area: [i32; 4],
    pub rect: [i32; 4],
    pub dpr: f64,
    pub bottom_padding: f64,
}
impl Placement {
    fn decode(value: Value) -> Option<Self> {
        fn rect(v: &Value) -> Option<[i32; 4]> {
            let a=v.as_array()?;
            if a.len()!=4 { return None; }
            let mut r=[0;4];
            for (i,n) in a.iter().enumerate() { r[i]=i32::try_from(n.as_i64()?).ok()?; }
            (r[2]>0 && r[3]>0).then_some(r)
        }
        let bottom_padding=match value["version"].as_u64()? {
            1 => 70.0,
            2 => value["bottomPadding"].as_f64()?,
            _ => return None,
        };
        if !bottom_padding.is_finite() || !(0.0..=1000.0).contains(&bottom_padding) { return None; }
        let dpr=value["dpr"].as_f64()?;
        if !dpr.is_finite() || !(0.25..=8.0).contains(&dpr) { return None; }
        Some(Self{monitor:value["monitor"].as_str().map(str::to_owned),
            area:rect(&value["area"] )?,rect:rect(&value["rect"] )?,dpr,bottom_padding})
    }
    // Keep the bottom-right anchor in logical pixels relative to this display.
    // layout::fit subsequently clamps it to the current work area.
    pub fn previous(&self, area: [i32;4], dpr: f64, padding: f64) -> [i32;4] {
        let right=(self.rect[0] as f64+self.rect[2] as f64-self.area[0] as f64)/self.dpr;
        let bottom=(self.rect[1] as f64+self.rect[3] as f64-self.area[1] as f64)/self.dpr-self.bottom_padding+padding;
        [(area[0] as f64+right*dpr-1.0).round() as i32,
         (area[1] as f64+bottom*dpr-1.0).round() as i32,1,1]
    }
}
pub fn load(path: &Path) -> Option<Placement> {
    if fs::metadata(path).ok()?.len()>4096 { return None; }
    Placement::decode(serde_json::from_slice(&fs::read(path).ok()?).ok()?)
}
pub fn save(path: &Path, p: &Placement) -> std::io::Result<()> {
    if let Some(parent)=path.parent() { fs::create_dir_all(parent)?; }
    let bytes=serde_json::to_vec(&json!({"version":2,"monitor":p.monitor,"area":p.area,"rect":p.rect,"dpr":p.dpr,"bottomPadding":p.bottom_padding}))?;
    // Separate temporary names allow the close handler and debounce worker to overlap.
    let suffix=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let tmp=path.with_extension(format!("{}.{}.tmp",std::process::id(),suffix));
    fs::write(&tmp,bytes)?;
    let result=fs::rename(&tmp,path);
    if result.is_err() { let _=fs::remove_file(tmp); }
    result
}
fn path(window: &tauri::WebviewWindow) -> Option<std::path::PathBuf> {
    window.app_handle().path().app_local_data_dir().ok().map(|p|p.join("avatar-placement.json"))
}
pub fn restore(window: &tauri::WebviewWindow) -> Option<Placement> { load(&path(window)?) }
pub fn character_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    let pos=window.inner_position().ok()?;
    let size=window.inner_size().ok()?;
    let unit=size.width as f64/380.0;
    // Center of the visible character, not the large transparent carrier.
    let x=pos.x as f64+size.width as f64/2.0;
    let padding=crate::layout::bottom_padding(true);
    let y=pos.y as f64+(crate::layout::CHARACTER_TOP-padding)*unit/2.0+size.height as f64/2.0;
    window.available_monitors().ok()?.into_iter().find(|m| {
        let p=m.position();let s=m.size();
        x>=p.x as f64 && y>=p.y as f64 && x<(p.x as f64+s.width as f64) && y<(p.y as f64+s.height as f64)
    }).or_else(||window.current_monitor().ok().flatten())
}
pub fn remember(window: &tauri::WebviewWindow) {
    let capture=|| -> Option<()> {
        let path=path(window)?;
        let monitor=character_monitor(window)?;
        let area=monitor.work_area();
        let pos=window.inner_position().ok()?;
        let size=window.inner_size().ok()?;
        let p=Placement{monitor:monitor.name().cloned(),
            area:[area.position.x,area.position.y,area.size.width as i32,area.size.height as i32],
            rect:[pos.x,pos.y,size.width as i32,size.height as i32],dpr:monitor.scale_factor(),bottom_padding:crate::layout::bottom_padding(true)*size.width as f64/(380.0*monitor.scale_factor())};
        save(&path,&p).ok()
    };
    // An unwritable preference file must not prevent hiding or using the avatar.
    capture();
}

#[cfg(test)] mod tests {
    use super::*;
    fn sample() -> Placement { Placement{monitor:Some("External".into()),area:[-3000,0,3000,2000],rect:[-1800,600,560,700],dpr:2.0,bottom_padding:70.0} }
    #[test] fn restores_exact_position_and_preserves_anchor_on_resize() {
        let p=sample();
        let a=crate::layout::fit("small",2.0,p.area,Some(p.previous(p.area,2.0,70.0))).unwrap();
        assert_eq!([a.x,a.y,a.width as i32,a.height as i32],p.rect);
        let b=crate::layout::fit("large",2.0,p.area,Some(p.previous(p.area,2.0,70.0))).unwrap();
        assert_eq!(b.y+b.height as i32,1300);
    }
    #[test] fn handles_display_removal_resolution_and_dpi_changes() {
        let p=sample();
        let area=[0,30,1440,870];
        let a=crate::layout::fit("small",1.0,area,Some(p.previous(area,1.0,70.0))).unwrap();
        assert_eq!((a.x,a.y),(600,330));
        let area=[0,0,400,300];
        let b=crate::layout::fit("large",2.0,area,Some(p.previous(area,2.0,70.0))).unwrap();
        assert!(b.x>=0 && b.y>=0 && b.x+b.width as i32<=400 && b.y+b.height as i32<=300);
    }
    #[test] fn roundtrip_replace_and_corrupt_preferences() {
        let dir=std::env::temp_dir().join(format!("duet-placement-test-{}",std::process::id()));
        let path=dir.join("placement.json");
        let _=fs::remove_dir_all(&dir);
        assert!(load(&path).is_none());
        save(&path,&sample()).unwrap();
        assert_eq!(load(&path),Some(sample()));
        let mut moved=sample();moved.rect[0]=-1500;
        save(&path,&moved).unwrap();assert_eq!(load(&path),Some(moved));
        fs::write(&path,b"incomplete json").unwrap();assert!(load(&path).is_none());
        fs::write(&path,vec![b' ';4097]).unwrap();assert!(load(&path).is_none());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test] fn rejects_invalid_or_future_state() {
        for v in [json!({"version":2}),json!({"version":1,"dpr":0}),
            json!({"version":1,"dpr":1,"rect":[0,0,-1,3],"area":[0,0,100,100]}),
            json!({"version":1,"dpr":1,"rect":[9223372036854775807i64,0,10,10],"area":[0,0,100,100]})] {
            assert!(Placement::decode(v).is_none());
        }
    }
    #[test] fn legacy_padding_migration_preserves_character_position() {
        let old=Placement::decode(json!({"version":1,"monitor":"External",
            "area":[0,50,2880,1750],"rect":[200,-650,760,1260],"dpr":2})).unwrap();
        let next=crate::layout::fit_character("small",2.0,old.area,
            Some(old.previous(old.area,2.0,490.0))).unwrap();
        assert_eq!((next.x,next.y),(200,-650));
        assert_eq!(next.height,2100);
        let current=Placement{rect:[next.x,next.y,next.width as i32,next.height as i32],
            bottom_padding:490.0,..old};
        let again=crate::layout::fit_character("small",2.0,current.area,
            Some(current.previous(current.area,2.0,490.0))).unwrap();
        assert_eq!((next.x,next.y),(again.x,again.y));
    }
}
