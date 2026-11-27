use super::*;

const MAC: &str = "#process-native-meta\nmacos 8 8388608\n#process-macos\n42 501 20 alice staff 1 S 1024 Sat Nov 28 10:02:03 2026 1:02.30 /Applications/Example App.app/Contents/MacOS/Example App\n";
fn windows(cpu: u64, start: u64) -> String {
    format!(
        r#"#process-windows
{{"cores":8,"memory":8388608,"items":[{{"pid":42,"name":"中文 worker.exe","rss":1048576,"parentPid":10,"threads":4,"userName":"DOMAIN\\Alice Smith","start":{start},"cpu":{cpu},"read":1000,"written":2000}},{{"pid":4,"name":"System","rss":4096,"start":null,"cpu":null}}]}}
"#
    )
}

#[test]
fn macos_bsd_rows_preserve_paths_and_safe_calendar_identities() {
    let mut sample = parse(MAC).unwrap();
    calculate(&mut sample, None, false);
    let p = &sample.items[0];
    assert_eq!(
        p.name,
        "/Applications/Example App.app/Contents/MacOS/Example App"
    );
    assert_eq!(p.started_at_ticks, Some(20261128100203));
    assert_eq!(p.uid, Some(501));
    assert_eq!(p.memory, 12.5);
    assert_eq!(p.threads, None);
    assert_eq!(p.disk_read_rate, None);
    assert_eq!(p.cpu_total, None);
    assert_eq!(macos_cpu("1:02.30"), Some(62300));
    assert_eq!(macos_cpu("2-01:02:03.45"), Some(176523450));
    for bad in [
        "NaN",
        "1:NaN",
        "1:99",
        "garbage",
        "18446744073709551615-1:02",
    ] {
        assert_eq!(macos_cpu(bad), None, "{bad}");
    }
}

#[test]
fn windows_unicode_nullable_permissions_and_native_interval_cpu() {
    let now = Instant::now();
    let mut first = parse(&windows(100, 1795831323000)).unwrap();
    first.observed_at = Some(now);
    calculate(&mut first, None, true);
    let mut next = parse(&windows(4100, 1795831323000)).unwrap();
    next.observed_at = Some(now + Duration::from_secs(2));
    calculate(&mut next, Some(&first), true);
    let p = next.items.iter().find(|p| p.pid == 42).unwrap();
    assert_eq!(p.name, "中文 worker.exe");
    assert_eq!(p.user_name.as_deref(), Some("DOMAIN\\Alice Smith"));
    assert_eq!(p.started_at_ticks, Some(1795831323000));
    assert_eq!(p.cpu_total, Some(25.0));
    assert_eq!(p.cpu, 200.0);
    assert_eq!(p.disk_read_rate, Some(0.0));
    assert_eq!(p.gpu_percent, None);
    assert_eq!(p.network_rx_rate, None);
    let protected = next.items.iter().find(|p| p.pid == 4).unwrap();
    assert_eq!(protected.started_at_ticks, None);
    assert_eq!(protected.disk_read_rate, None);
    let mut reused = parse(&windows(999999, 1795831324000)).unwrap();
    reused.observed_at = Some(now + Duration::from_secs(3));
    calculate(&mut reused, Some(&next), true);
    assert_eq!(
        reused.items.iter().find(|p| p.pid == 42).unwrap().cpu_total,
        None
    );
}

#[test]
fn native_resets_stale_samples_and_platform_changes_do_not_spike() {
    let now = Instant::now();
    let mut first = parse(MAC).unwrap();
    first.observed_at = Some(now);
    calculate(&mut first, None, false);
    let mut stale = parse(MAC).unwrap();
    stale.observed_at = Some(now + Duration::from_secs(31));
    calculate(&mut stale, Some(&first), false);
    assert_eq!(stale.items[0].cpu_total, None);
    let mut other = parse(&windows(999999, 20261128100203)).unwrap();
    other.observed_at = Some(now + Duration::from_secs(1));
    calculate(&mut other, Some(&first), false);
    assert!(other.items.iter().all(|p| p.cpu_total.is_none()));
    assert!(parse("#process-windows\n{}").is_err());
    assert!(parse("#process-native-meta\nmacos 0 1\n#process-macos\ninvalid").is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_collector_reads_real_processes_without_proc() {
    let output = std::process::Command::new("sh")
        .args(["-c", include_str!("macos.sh")])
        .output()
        .unwrap();
    assert!(output.status.success());
    let sample = parse(&String::from_utf8(output.stdout).unwrap()).unwrap();
    let current = sample
        .items
        .iter()
        .find(|p| p.pid == std::process::id())
        .unwrap();
    assert!(current.rss > 0);
    assert!(sample.counters.contains_key(&current.pid));
    assert_eq!(sample.platform, Platform::Macos);
}

#[cfg(target_os = "windows")]
#[test]
fn windows_collector_reads_real_cim_processes() {
    let command = Platform::Windows.script(false);
    let args: Vec<_> = command.split_whitespace().collect();
    let output = std::process::Command::new(args[0])
        .args(&args[1..])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let sample = parse(&String::from_utf8(output.stdout).unwrap()).unwrap();
    let current = sample
        .items
        .iter()
        .find(|p| p.pid == std::process::id())
        .unwrap();
    assert!(current.rss > 0);
    assert!(sample.counters.contains_key(&current.pid));
    assert_eq!(sample.platform, Platform::Windows);
}
