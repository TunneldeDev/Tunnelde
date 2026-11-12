#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = tunnelde_lib::automation::cli::from_desktop() {
        std::process::exit(code);
    }
    tunnelde_lib::run();
}
