use std::{
    collections::{BTreeMap, HashMap},
    pin::Pin,
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{
    error::{AppError, AppResult},
    state::AppState,
    vault,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct NetworkSettings {
    pub profiles: Vec<ProxyProfile>,
    pub default_proxy: String,
    pub features: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyProfile {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ConnectionRoute {
    pub proxy: String,
    pub jump_hosts: Vec<String>,
}

impl NetworkSettings {
    pub fn validate(&self) -> AppResult<()> {
        if self.profiles.len() > 64 || self.features.len() > 256 {
            return Err(AppError::validation("network.invalid"));
        }
        let mut ids = std::collections::HashSet::new();
        for profile in &self.profiles {
            if !valid_id(&profile.id)
                || !ids.insert(&profile.id)
                || profile.name.trim().is_empty()
                || profile.name.len() > 120
                || !["http", "socks5"].contains(&profile.protocol.as_str())
                || !valid_host(&profile.host)
                || profile.port == 0
                || profile.username.len() > 255
                || profile.username.chars().any(char::is_control)
            {
                return Err(AppError::validation("network.invalid"));
            }
        }
        for value in std::iter::once(&self.default_proxy).chain(self.features.values()) {
            if !["", "system", "direct"].contains(&value.as_str()) && !ids.contains(value) {
                return Err(AppError::validation("network.proxyMissing"));
            }
        }
        if self
            .features
            .keys()
            .any(|key| key.len() > 200 || key.chars().any(char::is_control))
        {
            return Err(AppError::validation("network.invalid"));
        }
        Ok(())
    }
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !["system", "direct"].contains(&value)
}
fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '/' | '\\' | '@' | '#' | '?' | '[' | ']')
        })
}

pub fn selection<'a>(
    settings: &'a NetworkSettings,
    feature: &str,
    override_value: Option<&'a str>,
) -> &'a str {
    let chosen = override_value.filter(|v| !v.is_empty()).or_else(|| {
        settings
            .features
            .get(feature)
            .filter(|v| !v.is_empty())
            .map(String::as_str)
    });
    chosen.unwrap_or(if settings.default_proxy.is_empty() {
        "system"
    } else {
        &settings.default_proxy
    })
}

pub fn proxy_url(
    settings: &NetworkSettings,
    feature: &str,
    override_value: Option<&str>,
) -> AppResult<Option<String>> {
    let chosen = selection(settings, feature, override_value);
    if chosen == "system" {
        return Ok(None);
    }
    if chosen == "direct" {
        return Ok(Some(String::new()));
    }
    let profile = settings
        .profiles
        .iter()
        .find(|p| p.id == chosen)
        .ok_or_else(|| AppError::validation("network.proxyMissing"))?;
    let scheme = if profile.protocol == "socks5" {
        "socks5h"
    } else {
        "http"
    };
    let mut url = reqwest::Url::parse(&format!(
        "{scheme}://{}:{}",
        authority(&profile.host),
        profile.port
    ))
    .map_err(|_| AppError::validation("network.invalid"))?;
    if !profile.username.is_empty() {
        url.set_username(&profile.username)
            .map_err(|_| AppError::validation("network.invalid"))?;
        let password = vault::load(&format!("proxy:{}", profile.id))?.unwrap_or_default();
        url.set_password(Some(&password))
            .map_err(|_| AppError::validation("network.invalid"))?;
    }
    Ok(Some(url.to_string()))
}

struct CachedClient {
    route: [u8; 32],
    created: Instant,
    client: reqwest::Client,
}
#[derive(Default)]
pub struct HttpClients(Mutex<HashMap<String, CachedClient>>);

pub fn http_client(app: &AppHandle, feature: &str) -> AppResult<reqwest::Client> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let url = proxy_url(&settings.network, feature, None)?;
    // Reuse TLS connections without retaining plaintext credentials as cache keys.
    // Periodically rebuild system routes so changed OS proxy settings take effect.
    let route: [u8; 32] = Sha256::digest(serde_json::to_vec(&url)?).into();
    let mut clients = state
        .http_clients
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(cached) = clients.get(feature).filter(|cached| {
        cached.route == route
            && (url.is_some() || cached.created.elapsed() < Duration::from_secs(30))
    }) {
        return Ok(cached.client.clone());
    }
    let mut builder = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("Tunnelde/", env!("CARGO_PKG_VERSION")));
    if let Some(url) = url {
        builder = builder.no_proxy();
        if !url.is_empty() {
            builder = builder.proxy(
                reqwest::Proxy::all(url).map_err(|_| AppError::validation("network.invalid"))?,
            );
        }
    }
    let client = builder
        .build()
        .map_err(|_| AppError::validation("network.failed"))?;
    clients.insert(
        feature.to_owned(),
        CachedClient {
            route,
            created: Instant::now(),
            client: client.clone(),
        },
    );
    Ok(client)
}

pub fn process_environment(
    app: &AppHandle,
    plugin: &str,
    command: &mut tokio::process::Command,
) -> AppResult<()> {
    let network = app.state::<AppState>().settings().network;
    let feature = format!("plugin:{plugin}");
    let value = network
        .features
        .get(&feature)
        .filter(|v| !v.is_empty())
        .map(String::as_str);
    if let Some(url) = proxy_url(&network, "processes", value)? {
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ] {
            command.env_remove(key);
        }
        if !url.is_empty() {
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                command.env(key, &url);
            }
            command
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1");
            command.env("NODE_USE_ENV_PROXY", "1");
        } else {
            command.env_remove("NODE_USE_ENV_PROXY");
        }
    }
    Ok(())
}

fn authority(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

pub trait Transport: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Transport for T {}
pub type Stream = Pin<Box<dyn Transport>>;

// Use the same environment/OS matcher as reqwest, including NO_PROXY and CIDR rules.
// SSH uses CONNECT semantics, therefore HTTPS proxy selection applies.
fn system_proxy(host: &str, port: u16) -> AppResult<String> {
    let destination = format!("https://{}:{port}/", authority(host))
        .parse()
        .map_err(|_| AppError::validation("network.invalid"))?;
    let Some(intercept) =
        hyper_util::client::proxy::matcher::Matcher::from_system().intercept(&destination)
    else {
        return Ok(String::new());
    };
    let mut url = reqwest::Url::parse(&intercept.uri().to_string())
        .map_err(|_| AppError::validation("network.invalid"))?;
    let raw = if let Some((user, password)) = intercept.raw_auth() {
        Some((user.to_owned(), password.to_owned()))
    } else {
        intercept
            .basic_auth()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Basic "))
            .and_then(|v| base64::engine::general_purpose::STANDARD.decode(v).ok())
            .and_then(|v| String::from_utf8(v).ok())
            .and_then(|v| v.split_once(':').map(|(u, p)| (u.to_owned(), p.to_owned())))
    };
    if let Some((user, password)) = raw {
        url.set_username(&user)
            .map_err(|_| AppError::validation("network.invalid"))?;
        url.set_password(Some(&password))
            .map_err(|_| AppError::validation("network.invalid"))?;
    }
    Ok(url.to_string())
}

pub async fn tcp(app: &AppHandle, host: &str, port: u16, proxy: &str) -> AppResult<Stream> {
    if !valid_host(host) || port == 0 {
        return Err(AppError::validation("network.invalid"));
    }
    let network = app.state::<AppState>().settings().network;
    let configured = proxy_url(&network, "ssh", Some(proxy))?;
    let url = match configured {
        Some(value) => value,
        None => system_proxy(host, port)?,
    };
    dial(host, port, &url).await
}

async fn dial(host: &str, port: u16, url: &str) -> AppResult<Stream> {
    if !valid_host(host) || port == 0 {
        return Err(AppError::validation("network.invalid"));
    }
    tokio::time::timeout(Duration::from_secs(15), async {
        if url.is_empty() {
            return Ok(Box::pin(tokio::net::TcpStream::connect((host, port)).await?) as Stream);
        }
        let url = reqwest::Url::parse(url).map_err(|_| AppError::validation("network.invalid"))?;
        if !["http", "socks5", "socks5h"].contains(&url.scheme()) {
            return Err(AppError::validation("network.unsupportedProxy"));
        }
        let proxy_host = url
            .host_str()
            .ok_or_else(|| AppError::validation("network.invalid"))?;
        let proxy_port = url
            .port()
            .unwrap_or(if url.scheme() == "http" { 80 } else { 1080 });
        let mut stream =
            tokio::net::TcpStream::connect((proxy_host.trim_matches(['[', ']']), proxy_port))
                .await?;
        let decode = |value: &str| -> AppResult<String> {
            percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .map(|s| s.into_owned())
                .map_err(|_| AppError::validation("network.invalid"))
        };
        let user = decode(url.username())?;
        let password = decode(url.password().unwrap_or_default())?;
        if url.scheme() == "http" {
            let target = format!("{}:{port}", authority(host));
            let auth = if user.is_empty() {
                String::new()
            } else {
                format!(
                    "Proxy-Authorization: Basic {}\r\n",
                    base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))
                )
            };
            stream
                .write_all(
                    format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n{auth}\r\n").as_bytes(),
                )
                .await?;
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                if header.len() >= 16384 {
                    return Err(AppError::validation("network.failed"));
                }
                header.push(stream.read_u8().await?);
            }
            if std::str::from_utf8(&header)
                .ok()
                .and_then(|s| s.lines().next())
                .and_then(|s| s.split_whitespace().nth(1))
                != Some("200")
            {
                return Err(AppError::validation("network.proxyRejected"));
            }
        } else {
            stream
                .write_all(if user.is_empty() {
                    &[5, 1, 0]
                } else {
                    &[5, 1, 2]
                })
                .await?;
            let mut greeting = [0; 2];
            stream.read_exact(&mut greeting).await?;
            if greeting[0] != 5 || greeting[1] != if user.is_empty() { 0 } else { 2 } {
                return Err(AppError::validation("network.proxyRejected"));
            }
            if !user.is_empty() {
                if user.len() > 255 || password.len() > 255 {
                    return Err(AppError::validation("network.invalid"));
                }
                let mut auth = vec![1, user.len() as u8];
                auth.extend(user.as_bytes());
                auth.push(password.len() as u8);
                auth.extend(password.as_bytes());
                stream.write_all(&auth).await?;
                stream.read_exact(&mut greeting).await?;
                if greeting != [1, 0] {
                    return Err(AppError::validation("network.proxyRejected"));
                }
            }
            let mut request = vec![5, 1, 0];
            match host.parse::<std::net::IpAddr>() {
                Ok(std::net::IpAddr::V4(ip)) => {
                    request.push(1);
                    request.extend(ip.octets());
                }
                Ok(std::net::IpAddr::V6(ip)) => {
                    request.push(4);
                    request.extend(ip.octets());
                }
                Err(_) => {
                    if host.len() > 255 {
                        return Err(AppError::validation("network.invalid"));
                    }
                    request.extend([3, host.len() as u8]);
                    request.extend(host.as_bytes());
                }
            }
            request.extend(port.to_be_bytes());
            stream.write_all(&request).await?;
            let mut reply = [0; 4];
            stream.read_exact(&mut reply).await?;
            if reply[..3] != [5, 0, 0] {
                return Err(AppError::validation("network.proxyRejected"));
            }
            let count = match reply[3] {
                1 => 4,
                4 => 16,
                3 => stream.read_u8().await? as usize,
                _ => return Err(AppError::validation("network.failed")),
            };
            let mut bound = vec![0; count + 2];
            stream.read_exact(&mut bound).await?;
        }
        Ok(Box::pin(stream) as Stream)
    })
    .await
    .map_err(|_| AppError::validation("network.timeout"))?
}

pub fn route(app: &AppHandle, host_id: &str) -> AppResult<ConnectionRoute> {
    app.state::<AppState>().db.with(|conn| {
        use rusqlite::OptionalExtension;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [format!("route:{host_id}")],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .unwrap_or_else(|| Ok(ConnectionRoute::default()))
    })
}

#[tauri::command]
pub fn connection_route_get(app: AppHandle, host_id: String) -> AppResult<ConnectionRoute> {
    route(&app, &host_id)
}

#[tauri::command]
pub fn connection_route_save(
    app: AppHandle,
    host_id: String,
    route: ConnectionRoute,
) -> AppResult<()> {
    if route.jump_hosts.len() > 8 {
        return Err(AppError::validation("network.jumpCycle"));
    }
    let state = app.state::<AppState>();
    proxy_url(&state.settings().network, "ssh", Some(&route.proxy))?;
    state.db.with(|conn| {
        crate::db::hosts::find_host(conn, &host_id)?;
        let mut seen = std::collections::HashSet::from([host_id.clone()]);
        for id in &route.jump_hosts {
            if !seen.insert(id.clone()) { return Err(AppError::validation("network.jumpCycle")); }
            crate::db::hosts::find_host(conn, id)?;
        }
        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![format!("route:{host_id}"), serde_json::to_string(&route)?, crate::models::now_ms()])?;
        Ok(())
    })
}

#[tauri::command]
pub fn proxy_password_save(app: AppHandle, id: String, password: Option<String>) -> AppResult<()> {
    if !app
        .state::<AppState>()
        .settings()
        .network
        .profiles
        .iter()
        .any(|p| p.id == id)
    {
        return Err(AppError::validation("network.proxyMissing"));
    }
    let key = format!("proxy:{id}");
    match password {
        Some(value) if value.len() <= 4096 => vault::save(&key, &value),
        None => vault::forget(&key),
        _ => Err(AppError::validation("network.invalid")),
    }
}

#[tauri::command]
pub async fn proxy_test(app: AppHandle, proxy: String, host: String, port: u16) -> AppResult<()> {
    if !valid_host(&host) || port == 0 {
        return Err(AppError::validation("network.invalid"));
    }
    let _ = tcp(&app, &host, port, &proxy).await?;
    Ok(())
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod protocol_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routing_precedence_and_validation() {
        let mut settings = NetworkSettings::default();
        assert_eq!(selection(&settings, "ssh", None), "system");
        settings.default_proxy = "direct".into();
        settings.features.insert("ssh".into(), "system".into());
        assert_eq!(selection(&settings, "ssh", None), "system");
        assert_eq!(selection(&settings, "ssh", Some("direct")), "direct");
        assert!(settings.validate().is_ok());
        settings.features.insert("updates".into(), "missing".into());
        assert!(settings.validate().is_err());
        for host in ["bad\r\nHost:evil", "http://proxy", "user@host", ""] {
            assert!(!valid_host(host));
        }
        assert!(valid_host("::1"));
    }
}
