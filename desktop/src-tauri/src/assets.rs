use std::{collections::HashMap, fs, path::Path};
pub const PROTOCOL: u64 = 2;
pub const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: ws://127.0.0.1:* ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'";
pub fn content_type(path: &str) -> Option<&'static str> {
    match path {
        "/index.html" => Some("text/html; charset=utf-8"),
        "/companion.mjs" | "/renderer.mjs" => Some("text/javascript; charset=utf-8"),
        "/character.glb" => Some("model/gltf-binary"),
        "/portrait.png" => Some("image/png"), _ => None,
    }
}
/// Snapshot local plugin assets once; an in-place npm upgrade cannot mix two UI versions.
pub fn load(path: &Path) -> Result<HashMap<String, Vec<u8>>, Box<dyn std::error::Error>> {
    let root=path.canonicalize()?;
    let manifest: serde_json::Value=serde_json::from_slice(&fs::read(root.join("manifest.json"))?)?;
    if manifest["protocol"].as_u64()!=Some(PROTOCOL) { return Err("Incompatible desktop UI".into()); }
    let mut files=HashMap::new();
    for name in ["index.html","companion.mjs","renderer.mjs","character.glb","portrait.png"] {
        let file=root.join(name).canonicalize()?;
        if file.parent()!=Some(root.as_path()) || fs::metadata(&file)?.len()>64*1024*1024 { return Err("Invalid desktop asset".into()); }
        files.insert(format!("/{name}"),fs::read(file)?);
    }
    Ok(files)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn only_exact_assets_are_public() {
        assert!(content_type("/index.html").is_some());
        for path in ["/../Cargo.toml","/%2e%2e/secrets","/manifest.json","//index.html","/index.html/extra"] {assert!(content_type(path).is_none());}
    }
}
