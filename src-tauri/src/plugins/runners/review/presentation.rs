//! Make exact-record consent readable in native dialogs with narrow text areas.
use super::{super::Record, Kind};
use crate::ssh::session::SessionIdentity;

fn visible(value: &str, limit: usize) -> String {
    let mut characters = value.chars();
    let mut text = String::new();
    for character in characters.by_ref().take(limit) {
        if character.is_control()
            || matches!(character, '\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
        {
            text.extend(character.escape_unicode());
        } else {
            text.push(character);
        }
    }
    if characters.next().is_some() {
        text.push('…');
    }
    text
}

fn width(character: char) -> usize {
    if character.is_ascii() {
        1
    } else {
        2
    }
}

pub(super) fn field(chinese: bool, labels: (&str, &str), value: &str, limit: usize) -> String {
    let label = if chinese { labels.1 } else { labels.0 };
    let value = visible(value, limit);
    if label.chars().map(width).sum::<usize>() + 2 + value.chars().map(width).sum::<usize>() <= 72 {
        return format!("{label}: {value}");
    }
    let mut wrapped = String::new();
    let mut column = 0;
    for character in value.chars() {
        let size = width(character);
        if column + size > 72 {
            wrapped.push('\n');
            column = 0;
        }
        wrapped.push(character);
        column += size;
    }
    format!("{label}:\n{wrapped}")
}

pub(super) fn record(chinese: bool, id: &str, record: &Record) -> String {
    [
        field(chinese, ("Plugin", "插件"), id, 64),
        field(chinese, ("Task", "任务"), &record.runner_id, 80),
        field(
            chinese,
            ("Directory", "目录"),
            &record.deployment.directory,
            4096,
        ),
    ]
    .join("\n")
}

pub(super) fn review(
    chinese: bool,
    id: &str,
    record: &Record,
    actual: &SessionIdentity,
    kind: Kind,
    fingerprint: &str,
) -> String {
    let mut parts = vec![
        self::record(chinese, id, record),
        field(chinese, ("Destination", "目标"), &actual.address, 512),
        field(chinese, ("Server key", "主机密钥"), &actual.server_key, 128),
        field(
            chinese,
            ("Original package", "原插件包"),
            &record.deployment.fingerprint,
            128,
        ),
    ];
    if matches!(kind, Kind::Control) {
        parts.push(field(
            chinese,
            ("Current package", "当前插件包"),
            fingerprint,
            128,
        ));
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_fields_wrap_without_losing_destination_text_or_hiding_control_characters() {
        for path in [
            "C:/remote/directory/".repeat(12),
            "/用户/远端任务/".repeat(12),
        ] {
            let text = field(false, ("Directory", "目录"), &path, 4096);
            assert!(text.starts_with("Directory:\n"));
            assert_eq!(
                text.strip_prefix("Directory:\n").unwrap().replace('\n', ""),
                path
            );
            assert!(text
                .lines()
                .all(|line| line.chars().map(width).sum::<usize>() <= 72));
        }
        assert_eq!(field(true, ("Task", "任务"), "task", 80), "任务: task");
        assert_eq!(
            visible("name\n\u{202e}other", 64),
            "name\\u{a}\\u{202e}other"
        );
        assert_eq!(visible("abcde", 3), "abc…");
    }

    #[test]
    fn destination_review_does_not_show_an_empty_controller_and_control_review_names_both_packages()
    {
        let record:Record=serde_json::from_value(serde_json::json!({"runnerId":"task","stopPending":false,
            "deployment":{"hostId":"host","directory":"/tasks/one","platform":"posix","executable":"runtime","runner":"helper","entry":"main","fingerprint":"original"}})).unwrap();
        let actual = SessionIdentity {
            host_id: "host".into(),
            address: "user@host:22".into(),
            server_key: "SHA256:key".into(),
        };
        let destination = review(false, "plugin", &record, &actual, Kind::Destination, "");
        assert!(!destination.contains("Current package"));
        assert!(destination.contains("Original package: original"));
        let control = review(true, "plugin", &record, &actual, Kind::Control, "current");
        assert!(control.contains("原插件包: original"));
        assert!(control.contains("当前插件包: current"));
    }
}
