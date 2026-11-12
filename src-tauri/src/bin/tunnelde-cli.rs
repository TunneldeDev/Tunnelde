fn main() {
    std::process::exit(tunnelde_lib::automation::cli::run(
        std::env::args_os().skip(1),
    ));
}
