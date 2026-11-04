// Fixed-width transparent carrier: captions and controls do not shrink with the avatar.
pub const WIDTH: f64 = 280.0;
pub const CHARACTER_TOP: f64 = 420.0;
pub const MAC_BOTTOM_SPACE: f64 = 420.0;
pub fn bottom_padding(panel: bool) -> f64 {
    70.0 + if cfg!(target_os="macos") && panel { MAC_BOTTOM_SPACE } else { 0.0 }
}
pub fn height(scale: f64) -> f64 { 210.0 + 280.0 * scale }
pub fn scale(size: &str) -> Result<f64, String> {
    match size { "large" => Ok(1.0), "medium" => Ok(0.75), "small" => Ok(0.5),
        _ => Err("Invalid avatar size".into()) }
}
pub struct Layout { pub x: i32, pub y: i32, pub width: u32, pub height: u32, pub scale: f64, pub fit: f64 }
// macOS permits transparent padding outside the display. Constrain the visible
// character and toolbar instead, otherwise the 420px header consumes half a screen.
pub fn fit_character(size: &str, dpr: f64, area: [i32;4], previous: Option<[i32;4]>) -> Result<Layout,String> {
    if !dpr.is_finite() || dpr<=0.0 || area[2]<=0 || area[3]<=0 { return Err("Invalid display geometry".into()); }
    let s=scale(size)?;
    let body=280.0*s+50.0;
    let fit=1.0_f64.min(area[2] as f64/(380.0*dpr)).min(area[3] as f64/(body*dpr));
    let unit=fit*dpr;
    let w=(380.0*unit).round().max(1.0) as u32;
    // Permanently reserve space below as well as above. A panel can flip below
    // a character at the screen top without resizing or moving its window.
    let h=((height(s)+280.0+MAC_BOTTOM_SPACE)*unit).round().max(1.0) as u32;
    let right=area[0] as f64+area[2] as f64;
    let bottom=area[1] as f64+area[3] as f64;
    let (x,y)=previous.map(|p|(p[0] as f64+p[2] as f64-w as f64,p[1] as f64+p[3] as f64-h as f64))
        .unwrap_or((right-w as f64-24.0*dpr,bottom-h as f64-24.0*dpr));
    let min_y=area[1] as f64-CHARACTER_TOP*unit;
    let max_y=(bottom-(CHARACTER_TOP+body)*unit).max(min_y);
    Ok(Layout{x:x.clamp(area[0] as f64,(right-w as f64).max(area[0] as f64)).round() as i32,
        y:y.clamp(min_y,max_y).round() as i32,width:w,height:h,scale:s,fit})
}
pub fn fit(size: &str, dpr: f64, area: [i32; 4], previous: Option<[i32; 4]>) -> Result<Layout, String> {
    fit_panel(size,dpr,area,previous,false)
}
pub fn fit_panel(size: &str, dpr: f64, area: [i32; 4], previous: Option<[i32; 4]>, panel: bool) -> Result<Layout, String> {
    if !dpr.is_finite() || dpr <= 0.0 || area[2] <= 0 || area[3] <= 0 { return Err("Invalid display geometry".into()); }
    let s = scale(size)?;
    let width=if panel {380.0} else {WIDTH};
    let height=height(s)+if panel {280.0} else {0.0};
    let fit = 1.0_f64.min(area[2] as f64 / (width*dpr)).min(area[3] as f64 / (height*dpr));
    let w = (width*fit*dpr).round().max(1.0).min(area[2] as f64) as u32;
    let h = (height*fit*dpr).round().max(1.0).min(area[3] as f64) as u32;
    let right = area[0] as f64 + area[2] as f64;
    let bottom = area[1] as f64 + area[3] as f64;
    let (x,y) = previous.map(|p|(p[0] as f64+p[2] as f64-w as f64,p[1] as f64+p[3] as f64-h as f64))
        .unwrap_or((right-w as f64-24.0*dpr,bottom-h as f64-24.0*dpr));
    Ok(Layout{x:x.clamp(area[0] as f64,right-w as f64).round() as i32,
        y:y.clamp(area[1] as f64,bottom-h as f64).round() as i32,width:w,height:h,scale:s,fit})
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn character_can_reach_top_on_both_displays() {
        for area in [[0,25,1440,875],[-1920,-1080,1920,1055]] {
            for size in ["small","medium","large"] {
                for dpr in [1.0,2.0] {
                    let p=fit_character(size,dpr,area,Some([area[0],area[1]-5000,380,770])).unwrap();
                    assert!((p.y as f64+420.0*p.fit*dpr-area[1] as f64).abs()<=1.0);
                    let again=fit_character(size,dpr,area,Some([p.x,p.y,p.width as i32,p.height as i32])).unwrap();
                    assert_eq!((p.x,p.y),(again.x,again.y));
                }
            }
        }
    }
    #[test] fn character_restore_and_resize_keep_anchor_without_padding_clamp() {
        let a=fit_character("large",2.0,[0,50,2880,1750],Some([200,-650,760,2380])).unwrap();
        assert_eq!(a.y,-650);
        let b=fit_character("small",2.0,[0,50,2880,1750],Some([a.x,a.y,a.width as i32,a.height as i32])).unwrap();
        assert_eq!(a.y+a.height as i32,b.y+b.height as i32);
    }
    #[test] fn three_sizes_retina_and_negative_monitor_origin() {
        for (name,s) in [("large",1.0),("medium",0.75),("small",0.5)] {
            for dpr in [1.0,2.0] {
                let p=fit(name,dpr,[-3000,-200,3000,2000],None).unwrap();
                assert_eq!(p.width,(WIDTH*dpr).round() as u32);
                assert_eq!(p.height,(height(s)*dpr).round() as u32);
                assert!(p.x>=-3000 && p.x+p.width as i32<=0);
                assert!(p.y>=-200 && p.y+p.height as i32<=1800);
            }
        }
    }
    #[test] fn keeps_bottom_right_when_switching() {
        let a=fit("large",2.0,[0,0,3000,2000],None).unwrap();
        let b=fit("small",2.0,[0,0,3000,2000],Some([a.x,a.y,a.width as i32,a.height as i32])).unwrap();
        assert_eq!(a.x+a.width as i32,b.x+b.width as i32);
        assert_eq!(a.y+a.height as i32,b.y+b.height as i32);
    }
    #[test] fn clamps_growth_and_small_work_area() {
        let p=fit("large",2.0,[-500,0,500,400],Some([-600,-20,140,245])).unwrap();
        assert!(p.x>=-500 && p.x+p.width as i32<=0 && p.y>=0 && p.y+p.height as i32<=400);
        assert!(p.fit<0.5);assert_eq!(p.scale,1.0);
        assert!(fit("unknown",1.0,[0,0,100,100],None).is_err());
        assert!(fit("small",f64::NAN,[0,0,100,100],None).is_err());
    }
}
