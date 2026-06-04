// Desktop entry point. Mobile entry is the `run` fn in lib.rs (via tauri-cli's
// generated mobile main). Keep this file dumb.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    taffy_studio_lib::run();
}
