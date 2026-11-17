use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::contract::{Entry, EntryInput, Issue, IssueCode, Preview};
use crate::error::{AppError, AppResult};

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 64;
const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 1_024;
const MAX_GLOB_RESULTS: usize = 1_024;
const MAX_VALUE: usize = 4_096;

#[derive(Debug, Clone, Default)]
pub(super) struct Discovered {
    pub preview: Preview,
}

#[derive(Debug, Clone)]
struct Source {
    path: PathBuf,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
struct Values {
    hostname: Option<String>,
    user: Option<String>,
    port: Option<String>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
    proxy_command: Option<String>,
    issues: Vec<Issue>,
}

#[derive(Debug, Clone)]
struct Block {
    patterns: Vec<String>,
    body: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default)]
struct Template {
    source_issues: Vec<Issue>,
    values: Values,
}

struct Reader {
    files: Vec<Source>,
    issues: Vec<Issue>,
    total_bytes: u64,
    read_count: usize,
}

impl Reader {
    fn new() -> Self {
        Self {
            files: Vec::new(),
            issues: Vec::new(),
            total_bytes: 0,
            read_count: 0,
        }
    }

    fn parse_file(
        &mut self,
        path: &Path,
        home: &Path,
        depth: usize,
        include_chain: &mut Vec<PathBuf>,
        root: bool,
    ) -> AppResult<Vec<Block>> {
        if depth > MAX_DEPTH || self.read_count >= MAX_FILES {
            if root {
                return Err(AppError::validation("sshImport.tooLarge"));
            }
            self.issue(Issue::new(
                IssueCode::TooLarge,
                "Include depth or file count",
            ));
            return Ok(Vec::new());
        }
        let normalized = normalize(path);
        if include_chain.contains(&normalized) {
            self.issue(Issue::new(
                IssueCode::IncludeCycle,
                display_label(path, home),
            ));
            return Ok(Vec::new());
        }
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) if root => return Err(AppError::validation("sshImport.readFailed")),
            Err(_) => {
                self.issue(Issue::new(IssueCode::ReadFailed, display_label(path, home)));
                return Ok(Vec::new());
            }
        };
        if !metadata.is_file() {
            if root {
                return Err(AppError::validation("sshImport.readFailed"));
            }
            self.issue(Issue::new(IssueCode::ReadFailed, display_label(path, home)));
            return Ok(Vec::new());
        }
        if metadata.len() > MAX_BYTES || self.total_bytes.saturating_add(metadata.len()) > MAX_BYTES
        {
            if root {
                return Err(AppError::validation("sshImport.tooLarge"));
            }
            self.issue(Issue::new(IssueCode::TooLarge, display_label(path, home)));
            return Ok(Vec::new());
        }
        let bytes = match fs::File::open(path).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        }) {
            Ok(bytes) => bytes,
            Err(_) if root => return Err(AppError::validation("sshImport.readFailed")),
            Err(_) => {
                self.issue(Issue::new(IssueCode::ReadFailed, display_label(path, home)));
                return Ok(Vec::new());
            }
        };
        if bytes.len() as u64 > MAX_BYTES
            || self.total_bytes.saturating_add(bytes.len() as u64) > MAX_BYTES
        {
            if root {
                return Err(AppError::validation("sshImport.tooLarge"));
            }
            self.issue(Issue::new(IssueCode::TooLarge, display_label(path, home)));
            return Ok(Vec::new());
        }
        self.total_bytes += bytes.len() as u64;
        self.read_count += 1;
        self.files.push(Source {
            path: path.to_owned(),
            bytes: bytes.clone(),
        });
        include_chain.push(normalized);

        let mut blocks = Vec::new();
        let mut current = Block {
            patterns: vec!["*".into()],
            body: Vec::new(),
        };
        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(_) => {
                include_chain.pop();
                self.issue(Issue::new(
                    IssueCode::InvalidLine,
                    display_label(path, home),
                ));
                return Ok(Vec::new());
            }
        };
        for (index, line) in logical_lines(&text).iter().enumerate() {
            let tokens = match tokenize(line) {
                Ok(tokens) => tokens,
                Err(()) => {
                    self.issue(Issue::new(
                        IssueCode::InvalidLine,
                        format!("line {}", index + 1),
                    ));
                    continue;
                }
            };
            if tokens.is_empty() {
                continue;
            }
            let keyword = tokens[0].to_ascii_lowercase();
            if keyword == "host" {
                if !current.body.is_empty() || current.patterns != ["*"] {
                    blocks.push(current);
                }
                current = Block {
                    patterns: if tokens.len() < 2 {
                        self.issue(Issue::new(IssueCode::InvalidValue, "Host"));
                        Vec::new()
                    } else {
                        tokens.into_iter().skip(1).collect()
                    },
                    body: Vec::new(),
                };
                continue;
            }
            if keyword == "match" {
                if !current.body.is_empty() || current.patterns != ["*"] {
                    blocks.push(current);
                }
                self.issue(Issue::new(IssueCode::UnsupportedOption, "Match"));
                current = Block {
                    patterns: vec!["*".into()],
                    body: vec![("__unsupported_match__".into(), String::new())],
                };
                continue;
            }
            if keyword == "include" {
                if tokens.len() < 2 {
                    self.issue(Issue::new(IssueCode::InvalidValue, "Include"));
                    continue;
                }
                // A conditional Include cannot be represented by a static list:
                // its Host/Match blocks can change evaluation for this target.
                if current.patterns != ["*"] {
                    current
                        .body
                        .push(("__unsupported_include__".into(), "Include".into()));
                    continue;
                }
                for pattern in tokens.iter().skip(1) {
                    if pattern.contains(['%', '[', ']'])
                        || pattern.starts_with("~") && !pattern.starts_with("~/")
                    {
                        current
                            .body
                            .push(("__unsupported_include__".into(), "Include expansion".into()));
                        continue;
                    }
                    let expanded = expand_path(pattern, home);
                    let expanded = if expanded.is_absolute() {
                        expanded
                    } else {
                        home.join(".ssh").join(expanded)
                    };
                    for include in expand_glob(&expanded)? {
                        let mut included =
                            self.parse_file(&include, home, depth + 1, include_chain, false)?;
                        if !included.is_empty() {
                            // Include is textual at global scope, including the
                            // last Host block's scope for the following lines.
                            if !current.body.is_empty() {
                                blocks.push(current);
                            }
                            current = included.pop().expect("nonempty included blocks");
                            blocks.extend(included);
                        }
                    }
                }
                continue;
            }
            let value = if tokens.len() > 1 {
                tokens[1..].join(" ")
            } else {
                String::new()
            };
            current.body.push((keyword, value));
        }
        if !current.body.is_empty() || current.patterns != ["*"] {
            blocks.push(current);
        }
        include_chain.pop();
        Ok(blocks)
    }

    fn issue(&mut self, issue: Issue) {
        if !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }
}

fn logical_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        current.push_str(line);
        if current.trim_end().ends_with('\\') {
            current.pop();
            current.push(' ');
        } else {
            lines.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn tokenize(line: &str) -> Result<Vec<String>, ()> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else if ch == '\\' && q == '"' {
                match chars.peek().copied() {
                    Some(next) if matches!(next, '"' | '\\' | '#') => {
                        current.push(chars.next().expect("peeked character"));
                    }
                    _ => current.push('\\'),
                }
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '#' => break,
            '=' if tokens.is_empty() || tokens.len() == 1 && current.is_empty() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '\\' => match chars.peek().copied() {
                Some(next) if next.is_whitespace() || matches!(next, '#' | '=' | '"' | '\'') => {
                    current.push(chars.next().expect("peeked character"));
                }
                _ => current.push('\\'),
            },
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if quote.is_some() {
        return Err(());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.iter().any(|token| token.len() > MAX_VALUE) {
        return Err(());
    }
    Ok(tokens)
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let mut p = 0;
    let mut v = 0;
    let mut star = None;
    let mut mark = 0;
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            mark = v;
            p += 1;
        } else if let Some(star_pos) = star {
            p = star_pos + 1;
            mark += 1;
            v = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn host_matches(patterns: &[String], alias: &str) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let mut positive = false;
    let mut matched = false;
    for pattern in patterns {
        if let Some(negated) = pattern.strip_prefix('!') {
            if wildcard_match(&negated.to_ascii_lowercase(), &alias.to_ascii_lowercase()) {
                return false;
            }
        } else {
            positive = true;
            if wildcard_match(&pattern.to_ascii_lowercase(), &alias.to_ascii_lowercase()) {
                matched = true;
            }
        }
    }
    positive && matched
}

fn is_wildcard(alias: &str) -> bool {
    alias.contains('*') || alias.contains('?') || alias.starts_with('!')
}

fn expand_path(value: &str, home: &Path) -> PathBuf {
    let home_text = home.to_string_lossy();
    let text = if value == "~" || value.starts_with("~/") {
        value.replacen("~", &home_text, 1)
    } else {
        value.to_owned()
    };
    PathBuf::from(expand_tokens(&text, "", "", 22, "", &home_text))
}

fn expand_glob(pattern: &Path) -> AppResult<Vec<PathBuf>> {
    let raw = pattern.to_string_lossy();
    if raw.contains(['[', ']']) {
        return Err(AppError::validation("sshImport.invalidSelection"));
    }
    if !raw.contains(['*', '?', '[']) {
        return Ok(vec![PathBuf::from(raw.as_ref())]);
    }
    let mut base = PathBuf::new();
    let mut parts = Vec::new();
    for component in Path::new(raw.as_ref()).components() {
        match component {
            Component::RootDir => base.push("/"),
            Component::Prefix(prefix) => base.push(prefix.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.is_empty() {
                    base.push("..");
                } else {
                    parts.push("..".into());
                }
            }
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
        }
    }
    if base.as_os_str().is_empty() {
        base.push(".");
    }
    let mut results = vec![base];
    for part in parts {
        let mut next = Vec::new();
        for path in results {
            if part.contains(['*', '?', '[']) {
                let entries = match fs::read_dir(&path) {
                    Ok(entries) => entries,
                    Err(_) => continue,
                };
                // Bound directory traversal as well as matches, before collecting.
                let mut names = Vec::new();
                for (scanned, entry) in entries.enumerate() {
                    if scanned >= 16_384 {
                        return Err(AppError::validation("sshImport.tooLarge"));
                    }
                    if let Ok(entry) = entry {
                        if wildcard_match(&part, &entry.file_name().to_string_lossy()) {
                            if names.len() >= MAX_GLOB_RESULTS {
                                return Err(AppError::validation("sshImport.tooLarge"));
                            }
                            names.push(entry.path());
                        }
                    }
                }
                names.sort();
                next.extend(names);
                if next.len() > MAX_GLOB_RESULTS {
                    return Err(AppError::validation("sshImport.tooLarge"));
                }
            } else {
                next.push(path.join(&part));
            }
        }
        results = next;
    }
    results.sort();
    Ok(results)
}

fn expand_tokens(
    value: &str,
    hostname: &str,
    user: &str,
    port: u16,
    original_alias: &str,
    home: &str,
) -> String {
    let mut result = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            result.push(ch);
            continue;
        }
        match chars.next() {
            Some('%') => result.push('%'),
            Some('d') => result.push_str(home),
            Some('h') => result.push_str(hostname),
            Some('n') => result.push_str(original_alias),
            Some('r') => result.push_str(user),
            Some('p') => result.push_str(&port.to_string()),
            Some('i') => result.push_str("%i"),
            Some(other) => {
                result.push('%');
                result.push(other);
            }
            None => result.push('%'),
        }
    }
    result
}

fn current_username() -> Option<String> {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn apply_option(values: &mut Values, keyword: &str, value: &str) {
    if value.is_empty() && !matches!(keyword, "proxyjump" | "proxycommand") {
        values
            .issues
            .push(Issue::new(IssueCode::InvalidValue, keyword));
        return;
    }
    match keyword {
        "hostname" => {
            values.hostname.get_or_insert_with(|| value.to_owned());
        }
        "user" => {
            values.user.get_or_insert_with(|| value.to_owned());
        }
        "port" => {
            values.port.get_or_insert_with(|| value.to_owned());
        }
        "identityfile" if values.identity_file.is_none() => {
            values.identity_file = Some(value.to_owned())
        }
        "identityfile" => values.issues.push(Issue::new(
            IssueCode::UnsupportedOption,
            "IdentityFile (multiple)",
        )),
        "proxyjump" => {
            values.proxy_jump.get_or_insert_with(|| value.to_owned());
        }
        "proxycommand" => {
            values.proxy_command.get_or_insert_with(|| value.to_owned());
        }
        "canonicalizehostname" if !value.eq_ignore_ascii_case("no") => values
            .issues
            .push(Issue::new(IssueCode::UnsupportedOption, keyword)),
        "requesttty"
        | "remotecommand"
        | "localcommand"
        | "permitlocalcommand"
        | "dynamicforward"
        | "remoteforward"
        | "localforward"
        | "gatewayports"
        | "exitonforwardfailure"
        | "clearallforwardings"
        | "forwardagent"
        | "forwardx11"
        | "forwardx11trusted"
        | "pubkeyacceptedalgorithms"
        | "hostkeyalgorithms"
        | "preferredauthentications"
        | "passwordauthentication"
        | "kbdinteractiveauthentication"
        | "challengeresponseauthentication"
        | "gssapiauthentication"
        | "hostbasedauthentication"
        | "pubkeyauthentication"
        | "identitiesonly"
        | "addkeystoagent"
        | "securitykeyprovider"
        | "certificatefile"
        | "controlmaster"
        | "controlpath"
        | "controlpersist"
        | "bindaddress"
        | "bindinterface"
        | "addressfamily"
        | "tunnel"
        | "tunneldevice"
        | "setenv"
        | "sendenv"
        | "permitremoteopen"
        | "enableescapecommandline"
        | "verifyhostkeydns"
        | "updatehostkeys"
        | "userknownhostsfile"
        | "globalknownhostsfile"
        | "hostbasedacceptedalgorithms"
        | "hostbasedkeytypes"
        | "casignaturealgorithms"
            if changes_meaning(keyword, value) =>
        {
            values
                .issues
                .push(Issue::new(IssueCode::UnsupportedOption, keyword))
        }
        "canonicalizehostname"
        | "serveraliveinterval"
        | "serveralivecountmax"
        | "tcpkeepalive"
        | "connecttimeout"
        | "connectionattempts"
        | "loglevel"
        | "logverbose"
        | "compression"
        | "ipqos"
        | "visualhostkey"
        | "rekeylimit"
        | "escapechar" => {}
        _ if !changes_meaning(keyword, value)
            && matches!(
                keyword,
                "forwardagent"
                    | "forwardx11"
                    | "forwardx11trusted"
                    | "tunnel"
                    | "requesttty"
                    | "remotecommand"
                    | "localcommand"
                    | "permitlocalcommand"
                    | "dynamicforward"
                    | "remoteforward"
                    | "localforward"
                    | "gatewayports"
                    | "exitonforwardfailure"
                    | "clearallforwardings"
                    | "controlmaster"
                    | "bindaddress"
                    | "bindinterface"
                    | "tunneldevice"
                    | "setenv"
                    | "sendenv"
                    | "enableescapecommandline"
                    | "addressfamily"
            ) => {}
        _ => values
            .issues
            .push(Issue::new(IssueCode::UnsupportedOption, keyword)),
    }
}

fn changes_meaning(keyword: &str, value: &str) -> bool {
    let no = matches!(
        value.to_ascii_lowercase().as_str(),
        "no" | "none" | "false" | "default"
    );
    match keyword {
        "passwordauthentication"
        | "kbdinteractiveauthentication"
        | "challengeresponseauthentication"
        | "gssapiauthentication"
        | "hostbasedauthentication"
        | "pubkeyauthentication"
        | "preferredauthentications"
        | "pubkeyacceptedalgorithms"
        | "hostkeyalgorithms"
        | "hostbasedacceptedalgorithms"
        | "hostbasedkeytypes"
        | "casignaturealgorithms"
        | "identitiesonly"
        | "addkeystoagent"
        | "certificatefile"
        | "securitykeyprovider"
        | "verifyhostkeydns"
        | "updatehostkeys"
        | "userknownhostsfile"
        | "globalknownhostsfile"
        | "permitremoteopen" => true,
        "forwardagent" | "forwardx11" | "forwardx11trusted" | "tunnel" => !no,
        "requesttty"
        | "remotecommand"
        | "localcommand"
        | "permitlocalcommand"
        | "dynamicforward"
        | "remoteforward"
        | "localforward"
        | "gatewayports"
        | "exitonforwardfailure"
        | "clearallforwardings" => !value.eq_ignore_ascii_case("none") && !no,
        "controlmaster" => !no,
        "bindaddress"
        | "bindinterface"
        | "tunneldevice"
        | "setenv"
        | "sendenv"
        | "enableescapecommandline" => !no,
        "addressfamily" => !matches!(value.to_ascii_lowercase().as_str(), "any" | "default"),
        _ => false,
    }
}

fn proxy_jump_aliases(value: &str) -> Result<Vec<String>, Issue> {
    if value.is_empty() || value.eq_ignore_ascii_case("none") {
        return Ok(Vec::new());
    }
    let mut aliases = Vec::new();
    for part in value.split(',') {
        if part.is_empty()
            || part.contains('@')
            || part.contains(':')
            || part.contains('[')
            || part.contains(']')
            || part.starts_with('-')
        {
            return Err(Issue::new(IssueCode::InvalidValue, "ProxyJump"));
        }
        aliases.push(part.to_ascii_lowercase());
    }
    Ok(aliases)
}

fn validate_hostname(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '/' | '\\' | '"' | '\'' | '@' | '#' | '?' | '[' | ']')
        })
}

fn build_template(blocks: &[Block], alias: &str) -> Template {
    let mut template = Template::default();
    for block in blocks {
        if !host_matches(&block.patterns, alias) {
            continue;
        }
        for (keyword, value) in &block.body {
            if keyword == "__unsupported_match__" || keyword == "__unsupported_include__" {
                template.source_issues.push(Issue::new(
                    IssueCode::UnsupportedOption,
                    if keyword == "__unsupported_match__" {
                        "Match"
                    } else {
                        "Include"
                    },
                ));
                continue;
            }
            apply_option(&mut template.values, keyword, value);
        }
    }
    template
        .source_issues
        .extend(template.values.issues.clone());
    template
}

fn unsupported_tokens(value: &str, supported: &str) -> bool {
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '%' && chars.next().is_none_or(|token| !supported.contains(token)) {
            return true;
        }
    }
    false
}

fn identity_path(
    value: &str,
    home: &Path,
    hostname: &str,
    alias: &str,
    user: &str,
    port: u16,
) -> Option<String> {
    if value.eq_ignore_ascii_case("none") {
        return None;
    }
    let home_text = home.to_string_lossy();
    let expanded = if value == "~" || value.starts_with("~/") {
        value.replacen("~", &home_text, 1)
    } else {
        value.to_owned()
    };
    Some(expand_tokens(
        &expanded, hostname, user, port, alias, &home_text,
    ))
}

fn finalize(
    alias: &str,
    template: &Template,
    fallback_user: &str,
    home: &Path,
    issues: &mut Vec<Issue>,
) -> Option<EntryInput> {
    let home_text = home.to_string_lossy();
    let raw_hostname = template
        .values
        .hostname
        .clone()
        .unwrap_or_else(|| alias.to_owned());
    let raw_user = template
        .values
        .user
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback_user.to_owned());
    let raw_port = template.values.port.clone().unwrap_or_else(|| "22".into());
    let user = expand_tokens(&raw_user, alias, &raw_user, 22, alias, &home_text);
    if user.is_empty() || user.chars().count() > 64 || user.chars().any(char::is_whitespace) {
        issues.push(Issue::new(IssueCode::InvalidValue, "User"));
        return None;
    }
    let port = match expand_tokens(&raw_port, alias, &user, 22, alias, &home_text).parse::<u16>() {
        Ok(port) if port > 0 => port,
        _ => {
            issues.push(Issue::new(IssueCode::InvalidValue, "Port"));
            return None;
        }
    };
    let hostname = expand_tokens(&raw_hostname, alias, &user, port, alias, &home_text);
    if !validate_hostname(&hostname) {
        issues.push(Issue::new(IssueCode::InvalidValue, "HostName"));
        return None;
    }
    if template
        .values
        .identity_file
        .as_deref()
        .is_some_and(|value| {
            value.contains("${")
                || value.starts_with('~') && value != "~" && !value.starts_with("~/")
                || unsupported_tokens(value, "dhnrp%")
        })
    {
        issues.push(Issue::new(
            IssueCode::UnsupportedOption,
            "IdentityFile expansion",
        ));
    }
    if unsupported_tokens(&raw_hostname, "hn%") || raw_user.contains('%') || raw_port.contains('%')
    {
        issues.push(Issue::new(
            IssueCode::UnsupportedOption,
            "connection token expansion",
        ));
    }
    let identity = template
        .values
        .identity_file
        .as_deref()
        .and_then(|value| identity_path(value, home, &hostname, alias, &user, port));
    let (auth_method, key_path) = match identity {
        Some(path) => ("key".to_owned(), Some(path)),
        None => ("agent".to_owned(), None),
    };
    Some(EntryInput {
        name: alias.to_owned(),
        group_id: None,
        host: hostname,
        port,
        username: user,
        auth_method,
        key_path,
        favorite: false,
        color: None,
        tags: Vec::new(),
        note: None,
    })
}

pub(super) fn discover(home: &Path) -> AppResult<Discovered> {
    let path = home.join(".ssh").join("config");
    if !path
        .try_exists()
        .map_err(|_| AppError::validation("sshImport.readFailed"))?
    {
        return Ok(Discovered {
            preview: Preview {
                path: path.to_string_lossy().into_owned(),
                found: false,
                revision: revision(&path, &[], &[], &[]),
                entries: Vec::new(),
                issues: Vec::new(),
            },
            ..Discovered::default()
        });
    }
    let mut reader = Reader::new();
    let blocks = reader.parse_file(&path, home, 0, &mut Vec::new(), true)?;
    let mut aliases = Vec::new();
    let mut seen = HashSet::new();
    for block in &blocks {
        for pattern in &block.patterns {
            if !is_wildcard(pattern) && seen.insert(pattern.to_ascii_lowercase()) {
                aliases.push(pattern.to_ascii_lowercase());
            }
        }
    }
    if aliases.len() > MAX_ENTRIES {
        return Err(AppError::validation("sshImport.tooLarge"));
    }
    let fallback_user = current_username().unwrap_or_default();
    let mut entries = Vec::new();
    for alias in aliases {
        let template = build_template(&blocks, &alias);
        let mut issues = template.source_issues.clone();
        issues.extend(reader.issues.clone());
        if template
            .values
            .proxy_command
            .as_deref()
            .is_some_and(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"))
        {
            issues.push(Issue::new(IssueCode::UnsupportedOption, "ProxyCommand"));
        }
        let input = finalize(&alias, &template, &fallback_user, home, &mut issues);
        let jumps = match template
            .values
            .proxy_jump
            .as_deref()
            .map(proxy_jump_aliases)
        {
            Some(Ok(jumps)) => jumps,
            Some(Err(issue)) => {
                issues.push(issue);
                Vec::new()
            }
            None => Vec::new(),
        };
        entries.push(Entry {
            alias,
            input,
            jump_aliases: jumps,
            issues,
            existing_id: None,
        });
    }
    let issues = reader.issues.clone();
    let revision = revision(&path, &reader.files, &entries, &issues);
    Ok(Discovered {
        preview: Preview {
            path: path.to_string_lossy().into_owned(),
            found: true,
            revision,
            entries,
            issues,
        },
    })
}

fn revision(root: &Path, sources: &[Source], entries: &[Entry], issues: &[Issue]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let mut sources = sources.to_vec();
    sources.sort_by(|left, right| left.path.cmp(&right.path));
    for source in sources {
        hasher.update(source.path.to_string_lossy().as_bytes());
        hasher.update(&source.bytes);
    }
    hasher.update(serde_json::to_vec(entries).unwrap_or_default());
    hasher.update(serde_json::to_vec(issues).unwrap_or_default());
    format!("{:x}", hasher.finalize())
}

fn normalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_owned())
}

fn display_label(path: &Path, home: &Path) -> String {
    path.strip_prefix(home)
        .map(|path| format!("~/{}", path.to_string_lossy()))
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_matching_and_negation_are_bounded() {
        assert!(host_matches(&["*".into(), "!bad".into()], "good"));
        assert!(!host_matches(&["*".into(), "!bad".into()], "bad"));
        assert!(host_matches(&["web-?".into()], "web-1"));
        assert!(!host_matches(&["web-?".into()], "web-12"));
    }

    #[test]
    fn tokens_expand_safe_open_ssh_forms() {
        let value = expand_tokens(
            "%h/%n/%r/%p/%%/%i/%d",
            "example.test",
            "user",
            2200,
            "key",
            "/home/u",
        );
        assert_eq!(value, "example.test/key/user/2200/%/%i//home/u");
    }

    #[test]
    fn comments_quotes_equals_and_backslashes_are_tokenized() {
        let tokens = tokenize(r#"Host = "web one" # comment"#).unwrap();
        assert_eq!(tokens, ["Host", "web one"]);
        let tokens = tokenize(r"IdentityFile C:\Users\me\.ssh\id_ed25519").unwrap();
        assert_eq!(tokens[1], r"C:\Users\me\.ssh\id_ed25519");
        let tokens = tokenize(r#"IdentityFile "C:\Users\me\.ssh\id_ed25519""#).unwrap();
        assert_eq!(tokens[1], r"C:\Users\me\.ssh\id_ed25519");
    }

    #[test]
    fn proxy_jump_accepts_alias_chains_and_rejects_literal_overrides() {
        assert_eq!(
            proxy_jump_aliases("bastion,edge").unwrap(),
            ["bastion", "edge"]
        );
        assert!(proxy_jump_aliases("me@host").is_err());
        assert!(proxy_jump_aliases("bastion:22").is_err());
    }

    #[test]
    fn hostname_port_identity_and_auth_defaults_are_known() {
        let home = Path::new("/home/test");
        let template = Template {
            values: Values {
                hostname: Some("example.test".into()),
                user: Some("alice".into()),
                port: Some("2200".into()),
                identity_file: Some("~/.ssh/id_%r".into()),
                ..Values::default()
            },
            ..Template::default()
        };
        let mut issues = Vec::new();
        let input = finalize("alias", &template, "fallback", home, &mut issues).unwrap();
        assert_eq!(input.host, "example.test");
        assert_eq!(input.port, 2200);
        assert_eq!(input.username, "alice");
        assert_eq!(input.auth_method, "key");
        assert_eq!(input.key_path.as_deref(), Some("/home/test/.ssh/id_alice"));
        assert!(issues.is_empty());
    }

    #[test]
    fn invalid_ports_disable_entries() {
        let home = Path::new("/home/test");
        let template = Template {
            values: Values {
                port: Some("not-a-port".into()),
                ..Values::default()
            },
            ..Template::default()
        };
        let mut issues = Vec::new();
        assert!(finalize("alias", &template, "user", home, &mut issues).is_none());
        assert_eq!(issues[0].code, IssueCode::InvalidValue);
    }

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new(config: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("tunnelde-ssh-parser-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join(".ssh")).unwrap();
            let f = Self(path);
            f.file("config", config);
            f
        }
        fn file(&self, name: &str, text: &str) {
            let path = self.0.join(".ssh").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fn entries(&self) -> Vec<Entry> {
            discover(&self.0).unwrap().preview.entries
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn production_parser_preserves_empty_aliases_and_first_value_inheritance() {
        let f = Fixture::new("Host * !Excluded\n User shared\n Port 2200\nHost Web Other\n HostName endpoint.test\n User overridden\nHost Excluded\n User personal\nHost Empty\n");
        let entries = f.entries();
        assert_eq!(entries.len(), 4);
        for alias in ["web", "other"] {
            let entry = entries.iter().find(|e| e.alias == alias).unwrap();
            assert!(entry.issues.is_empty());
            let input = entry.input.as_ref().unwrap();
            assert_eq!(input.host, "endpoint.test");
            assert_eq!(input.username, "shared");
            assert_eq!(input.port, 2200);
        }
        assert_eq!(
            entries
                .iter()
                .find(|e| e.alias == "excluded")
                .unwrap()
                .input
                .as_ref()
                .unwrap()
                .username,
            "personal"
        );
        let empty = entries
            .iter()
            .find(|e| e.alias == "empty")
            .unwrap()
            .input
            .as_ref()
            .unwrap();
        assert_eq!(empty.host, "empty");
        assert_eq!(empty.auth_method, "agent");
        assert!(!host_matches(&["!bad".into()], "good"));
    }

    #[test]
    fn production_parser_expands_identity_variables_and_windows_quotes() {
        let f = Fixture::new("Host App\n HostName = endpoint.test\n User = alice\n Port=2222\n IdentityFile \"~/.ssh/%h_%n_%r_%p_%%\"\nHost win\n User bob\n IdentityFile \"C:\\Users\\bob\\my keys\\id_ed25519\" # note\n");
        let entries = f.entries();
        let app = entries.iter().find(|e| e.alias == "app").unwrap();
        assert!(app.issues.is_empty(), "{:?}", app.issues);
        assert_eq!(
            app.input.as_ref().unwrap().key_path,
            Some(format!(
                "{}/.ssh/endpoint.test_app_alice_2222_%",
                f.0.display()
            ))
        );
        let win = entries.iter().find(|e| e.alias == "win").unwrap();
        assert!(win.issues.is_empty(), "{:?}", win.issues);
        assert_eq!(
            win.input.as_ref().unwrap().key_path.as_deref(),
            Some(r"C:\Users\bob\my keys\id_ed25519")
        );
    }

    #[test]
    fn production_global_includes_are_relative_sorted_and_keep_trailing_scope() {
        let f = Fixture::new("Include parts/*.conf\n Port 2244\nHost final\n User final\n");
        f.file(
            "parts/b.conf",
            "Host web\n HostName second.test\n User second\n",
        );
        f.file(
            "parts/a.conf",
            "Host web\n HostName first.test\n User first\nHost db\n HostName db.test\n",
        );
        let entries = f.entries();
        let web = entries
            .iter()
            .find(|e| e.alias == "web")
            .unwrap()
            .input
            .as_ref()
            .unwrap();
        assert_eq!(web.host, "first.test");
        assert_eq!(web.username, "first");
        assert_eq!(web.port, 2244);
        assert_eq!(
            entries
                .iter()
                .find(|e| e.alias == "db")
                .unwrap()
                .input
                .as_ref()
                .unwrap()
                .port,
            22
        );
    }

    #[test]
    fn uncertain_includes_and_invalid_source_never_import_defaults_silently() {
        let f = Fixture::new("Include absent.conf\nHost web\n User alice\n");
        let entries = f.entries();
        assert!(!entries[0].issues.is_empty());
        f.file("config", "Include cycle.conf\nHost web\n User alice\n");
        f.file("cycle.conf", "Include config\n");
        assert!(f.entries()[0]
            .issues
            .iter()
            .any(|i| i.code == IssueCode::IncludeCycle));
        fs::write(
            f.0.join(".ssh/config"),
            b"Host web\n HostName bad\xff.test\n",
        )
        .unwrap();
        let preview = discover(&f.0).unwrap().preview;
        assert!(preview.entries.is_empty());
        assert!(!preview.issues.is_empty());
    }

    #[test]
    fn conditional_include_disables_affected_hosts_without_reading_it() {
        let f = Fixture::new("Host affected\n Include conditional.conf\nHost safe\n User alice\n");
        f.file("conditional.conf", "Host introduced\n User changed\n");
        let entries = f.entries();
        assert!(!entries
            .iter()
            .find(|e| e.alias == "affected")
            .unwrap()
            .issues
            .is_empty());
        assert!(entries
            .iter()
            .find(|e| e.alias == "safe")
            .unwrap()
            .issues
            .is_empty());
        assert!(!entries.iter().any(|e| e.alias == "introduced"));
    }

    #[test]
    fn unsupported_auth_commands_and_token_expansion_are_explicit() {
        for directive in [
            "IdentityAgent none",
            "PKCS11Provider provider",
            "HostKeyAlias alias",
            "ProxyCommand command",
            "IdentityFile ~/.ssh/id_%x",
            "IdentityFile ${UNSUPPORTED}/key",
        ] {
            let f = Fixture::new(&format!("Host web\n User alice\n {directive}\n"));
            assert!(!f.entries()[0].issues.is_empty(), "{directive}");
        }
        let f = Fixture::new(
            "Match exec \"never-execute-this\"\n User changed\nHost web\n User alice\n",
        );
        assert!(f.entries()[0]
            .issues
            .iter()
            .any(|i| i.code == IssueCode::UnsupportedOption));
    }

    #[test]
    fn source_byte_limit_and_missing_default_config_are_reported() {
        let f = Fixture::new("");
        fs::remove_file(f.0.join(".ssh/config")).unwrap();
        assert!(!discover(&f.0).unwrap().preview.found);
        fs::write(f.0.join(".ssh/config"), vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert!(discover(&f.0).is_err());
    }
}
