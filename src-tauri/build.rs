fn main() {
    println!("cargo:rerun-if-env-changed=NOTGRAM_API_ID");
    println!("cargo:rerun-if-env-changed=NOTGRAM_API_HASH");
    tauri_build::build()
}
