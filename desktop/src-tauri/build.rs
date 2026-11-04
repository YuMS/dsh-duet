fn main() {
    println!("cargo:rerun-if-changed=src/macos_window.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new().file("src/macos_window.m").flag("-fobjc-arc").compile("duet_window");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
    tauri_build::build()
}
