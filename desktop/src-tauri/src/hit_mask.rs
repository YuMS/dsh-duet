#[derive(Default)]
pub struct HitMask {
    pub mask: Vec<u8>,
    pub avatar: [f64; 4],
    pub regions: Vec<[f64; 4]>,
}
impl HitMask {
    pub fn valid(&self) -> bool {
        self.mask.len() == 48 * 64 && self.mask.iter().all(|v| *v <= 1)
            && self.regions.len() <= 8
            && std::iter::once(&self.avatar).chain(self.regions.iter()).all(|r|
                r.iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 2000.0))
            && self.avatar[2] > 0.0 && self.avatar[3] > 0.0
    }
    pub fn hits_avatar(&self, x: f64, y: f64) -> bool {
        if !self.valid() || !x.is_finite() || !y.is_finite() { return false; }
        let [ax,ay,w,h] = self.avatar;
        if x<ax || y<ay || x>=ax+w || y>=ay+h { return false; }
        let i = ((y-ay)/h*64.0) as usize*48 + ((x-ax)/w*48.0) as usize;
        self.mask.get(i).copied().unwrap_or(0) == 1
    }
    pub fn ignores(&self, x: f64, y: f64) -> bool {
        if !self.valid() { return false; } // Fail open to mouse interaction.
        let inside = |r: &[f64; 4]| x >= r[0] && y >= r[1] && x < r[0]+r[2] && y < r[1]+r[3];
        !self.regions.iter().any(inside) && !self.hits_avatar(x,y)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn respects_offset_avatar_controls_and_bubble() {
        let mut h=HitMask{mask:vec![0;48*64],avatar:[10.0,140.0,260.0,280.0],regions:vec![[36.0,422.0,208.0,40.0],[12.0,20.0,256.0,100.0]]};
        assert!(h.valid()); assert!(h.ignores(0.0,0.0));
        assert!(!h.ignores(60.0,440.0)); assert!(!h.ignores(40.0,50.0));
        assert!(h.ignores(140.0,280.0));h.mask[32*48+24]=1;
        assert!(!h.ignores(140.0,280.0));
    }
    #[test]
    fn invalid_masks_never_lock_out_mouse() {
        let h=HitMask::default();assert!(!h.valid());assert!(!h.ignores(20.0,30.0));
    }
    #[test]
    fn hidden_toolbar_is_not_a_hit_region_but_character_still_is() {
        let mut h=HitMask{mask:vec![0;48*64],avatar:[75.0,140.0,130.0,140.0],regions:vec![]};
        h.mask[32*48+24]=1;
        assert!(h.ignores(100.0,300.0));assert!(!h.hits_avatar(76.0,141.0));
        assert!(h.hits_avatar(141.0,211.0));assert!(!h.ignores(141.0,211.0));
        h.regions.push([16.0,282.0,248.0,42.0]);assert!(!h.ignores(100.0,300.0));
        h.regions.clear();assert!(h.ignores(100.0,300.0));
    }
    #[test]
    fn scaled_content_and_control_regions_share_logical_coordinates() {
        for s in [0.5,0.75,1.0] {
            let mut h=HitMask{mask:vec![0;48*64],avatar:[(280.0-260.0*s)/2.0,140.0,260.0*s,280.0*s],regions:vec![[16.0,142.0+280.0*s,248.0,42.0],[12.0,0.0,256.0,134.0]]};
            h.mask[32*48+24]=1;
            assert!(h.valid());assert!(!h.ignores(140.0,140.0+140.0*s));
            assert!(!h.ignores(80.0,162.0+280.0*s));assert!(!h.ignores(80.0,50.0));
            assert!(h.ignores(1.0,1.0));assert!(h.ignores(5.0,180.0));
        }
    }
}
