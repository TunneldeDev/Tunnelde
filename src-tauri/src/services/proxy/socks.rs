//! Bounded SOCKS5 CONNECT server. Destination names stay unresolved until SSH.
use super::contract::{MissPolicy, ProxyRoute};
use crate::error::{AppError, AppResult};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpListener,
    sync::Semaphore,
};

pub const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub const MAX_CONNECTIONS: usize = 256;
pub type Verifier<'a> = &'a (dyn Fn(&str, &str) -> bool + Sync);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Destination {
    Ip(IpAddr),
    Domain(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectRequest {
    pub destination: Destination,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Route(usize),
    Miss(MissPolicy),
}

fn route_rank(route: &ProxyRoute, destination: &Destination, port: u16) -> Option<(u8, u16)> {
    if route.match_port.is_some_and(|expected| expected != port) {
        return None;
    }
    let matcher = route
        .match_host
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host = match destination {
        Destination::Domain(value) => value.trim_end_matches('.').to_ascii_lowercase(),
        Destination::Ip(value) => value.to_string(),
    };
    let (family, length) = if let Some(suffix) = matcher.strip_prefix("*.") {
        if !host.ends_with(&format!(".{suffix}")) {
            return None;
        }
        (2, suffix.len() as u16)
    } else if let Ok(network) = matcher.parse::<ipnet::IpNet>() {
        let contained = match (destination, network) {
            (Destination::Ip(IpAddr::V4(value)), ipnet::IpNet::V4(network)) => {
                network.contains(value)
            }
            (Destination::Ip(IpAddr::V6(value)), ipnet::IpNet::V6(network)) => {
                network.contains(value)
            }
            _ => false,
        };
        if !contained {
            return None;
        }
        (4, network.prefix_len() as u16)
    } else if matcher == host {
        (0, 0)
    } else {
        return None;
    };
    Some((
        family * 2 + u8::from(route.match_port != Some(port)),
        length,
    ))
}
/// Fixed priority: exact host+port, exact host, longest wildcard+port,
/// wildcard, longest CIDR+port, CIDR, then the group miss policy.
pub fn match_route(
    routes: &[ProxyRoute],
    destination: &Destination,
    port: u16,
    miss: MissPolicy,
) -> Decision {
    let best = routes
        .iter()
        .enumerate()
        .filter_map(|(index, route)| route_rank(route, destination, port).map(|rank| (rank, index)))
        .min_by(|(left, _), (right, _)| left.cmp(right));
    match best {
        Some((_, index)) => Decision::Route(index),
        None => Decision::Miss(miss),
    }
}

pub fn error_reply(code: u8) -> [u8; 10] {
    [0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

async fn read_exact<S: AsyncRead + Unpin>(socket: &mut S, bytes: &mut [u8]) -> AppResult<()> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.read_exact(bytes))
        .await
        .map_err(|_| AppError::validation("proxy.timeout"))?
        .map(|_| ())
        .map_err(|_| AppError::validation("proxy.protocol"))
}

pub async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut S,
    allow_none: bool,
    verify: Option<Verifier<'_>>,
) -> AppResult<u8> {
    let mut greeting = [0_u8; 2];
    read_exact(socket, &mut greeting).await?;
    if greeting[0] != 0x05 {
        return Err(AppError::validation("proxy.protocol"));
    }
    let count = greeting[1] as usize;
    if count == 0 || count > 8 {
        return Err(AppError::validation("proxy.protocol"));
    }
    let mut methods = vec![0_u8; count];
    read_exact(socket, &mut methods).await?;
    let wanted = if verify.is_some() && methods.contains(&0x02) {
        if allow_none && methods.contains(&0x00) {
            // The standard greeting does not carry a preference order. Keep
            // no-auth available for ordinary clients while allowing the TUN
            // attachment to authenticate with username/password.
            0x00
        } else {
            0x02
        }
    } else if allow_none && methods.contains(&0x00) {
        0x00
    } else {
        socket.write_all(&[0x05, 0xff]).await?;
        return Err(AppError::validation("proxy.authRequired"));
    };
    socket.write_all(&[0x05, wanted]).await?;
    if wanted == 0x02 {
        let mut head = [0_u8; 2];
        read_exact(socket, &mut head).await?;
        if head[0] != 0x01 {
            return Err(AppError::validation("proxy.protocol"));
        }
        let mut user = vec![0_u8; head[1] as usize];
        read_exact(socket, &mut user).await?;
        let mut plen = [0_u8; 1];
        read_exact(socket, &mut plen).await?;
        if plen[0] == 0 {
            socket.write_all(&[0x01, 0x01]).await?;
            return Err(AppError::validation("proxy.authFailed"));
        }
        let mut pass = vec![0_u8; plen[0] as usize];
        read_exact(socket, &mut pass).await?;
        let valid = verify.is_some_and(|verify| {
            std::str::from_utf8(&user).ok().is_some_and(|username| {
                std::str::from_utf8(&pass)
                    .ok()
                    .is_some_and(|password| verify(username, password))
            })
        });
        socket
            .write_all(&[0x01, if valid { 0x00 } else { 0x01 }])
            .await?;
        if !valid {
            return Err(AppError::validation("proxy.authFailed"));
        }
    }
    Ok(wanted)
}

pub async fn read_request<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut S,
) -> AppResult<ConnectRequest> {
    let mut head = [0_u8; 4];
    read_exact(socket, &mut head).await?;
    if head[0] != 0x05 {
        return Err(AppError::validation("proxy.protocol"));
    }
    if head[2] != 0x00 {
        socket.write_all(&error_reply(0x08)).await?;
        return Err(AppError::validation("proxy.protocol"));
    }
    if head[1] != 0x01 {
        socket.write_all(&error_reply(0x07)).await?;
        return Err(AppError::validation("proxy.unsupportedCommand"));
    }
    let destination = match head[3] {
        0x01 => {
            let mut value = [0_u8; 4];
            read_exact(socket, &mut value).await?;
            Destination::Ip(IpAddr::V4(value.into()))
        }
        0x04 => {
            let mut value = [0_u8; 16];
            read_exact(socket, &mut value).await?;
            Destination::Ip(IpAddr::V6(value.into()))
        }
        0x03 => {
            let mut len = [0_u8; 1];
            read_exact(socket, &mut len).await?;
            if len[0] == 0 {
                socket.write_all(&error_reply(0x08)).await?;
                return Err(AppError::validation("proxy.protocol"));
            }
            let mut value = vec![0_u8; len[0] as usize];
            read_exact(socket, &mut value).await?;
            let value =
                String::from_utf8(value).map_err(|_| AppError::validation("proxy.protocol"))?;
            if !super::contract::valid_host(&value) {
                return Err(AppError::validation("proxy.protocol"));
            }
            Destination::Domain(value)
        }
        _ => {
            socket.write_all(&error_reply(0x08)).await?;
            return Err(AppError::validation("proxy.protocol"));
        }
    };
    let mut port = [0_u8; 2];
    read_exact(socket, &mut port).await?;
    let port = u16::from_be_bytes(port);
    if port == 0 {
        socket.write_all(&error_reply(0x08)).await?;
        return Err(AppError::validation("proxy.protocol"));
    }
    Ok(ConnectRequest { destination, port })
}

pub async fn accept<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut S,
    allow_none: bool,
    verify: Option<Verifier<'_>>,
) -> AppResult<(ConnectRequest, u8)> {
    let method = handshake(socket, allow_none, verify).await?;
    Ok((read_request(socket).await?, method))
}

pub fn success_reply() -> [u8; 10] {
    [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

pub struct Listener {
    pub listener: TcpListener,
    pub permits: Arc<Semaphore>,
}

pub async fn bind(host: &str, port: u16) -> AppResult<Listener> {
    let address: IpAddr = host
        .parse()
        .map_err(|_| AppError::validation("proxy.bindFailed"))?;
    let listener = TcpListener::bind(SocketAddr::new(address, port))
        .await
        .map_err(|_| AppError::validation("proxy.bindFailed"))?;
    Ok(Listener {
        listener,
        permits: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::proxy::contract::RouteMode;

    fn route(id: &str, host: &str, port: Option<u16>) -> ProxyRoute {
        ProxyRoute {
            id: id.into(),
            group_id: "g".into(),
            name: id.into(),
            mode: RouteMode::Group,
            match_host: host.into(),
            match_port: port,
            target_host: "127.0.0.1".into(),
            target_port: 80,
            bind_host: None,
            bind_port: None,
        }
    }

    #[test]
    fn priority_is_fixed_and_longest_wildcard_wins() {
        let routes = vec![
            route("wild", "*.example.com", None),
            route("wild-port", "*.example.com", Some(443)),
            route("exact", "api.example.com", None),
            route("exact-port", "api.example.com", Some(443)),
            route("cidr", "10.0.0.0/8", None),
            route("cidr-port", "10.0.0.0/8", Some(443)),
        ];
        let destination = Destination::Domain("api.example.com".into());
        assert_eq!(
            match_route(&routes, &destination, 443, MissPolicy::Direct),
            Decision::Route(3)
        );
        assert_eq!(
            match_route(&routes, &destination, 80, MissPolicy::Direct),
            Decision::Route(2)
        );
        assert_eq!(
            match_route(
                &routes,
                &Destination::Domain("x.example.com".into()),
                443,
                MissPolicy::Direct
            ),
            Decision::Route(1)
        );
        assert_eq!(
            match_route(
                &routes,
                &Destination::Domain("x.example.com".into()),
                80,
                MissPolicy::Direct
            ),
            Decision::Route(0)
        );
        assert_eq!(
            match_route(
                &routes,
                &Destination::Ip("10.1.2.3".parse().unwrap()),
                443,
                MissPolicy::Direct
            ),
            Decision::Route(5)
        );
        assert_eq!(
            match_route(
                &routes,
                &Destination::Ip("10.1.2.3".parse().unwrap()),
                80,
                MissPolicy::Direct
            ),
            Decision::Route(4)
        );
        assert_eq!(
            match_route(
                &routes,
                &Destination::Domain("other.test".into()),
                80,
                MissPolicy::Reject
            ),
            Decision::Miss(MissPolicy::Reject)
        );
    }

    #[test]
    fn exact_domain_does_not_include_subdomains() {
        let routes = vec![route("exact", "example.com", None)];
        assert!(matches!(
            match_route(
                &routes,
                &Destination::Domain("api.example.com".into()),
                80,
                MissPolicy::Direct
            ),
            Decision::Miss(_)
        ));
        assert_eq!(
            match_route(
                &routes,
                &Destination::Domain("example.com".into()),
                80,
                MissPolicy::Direct
            ),
            Decision::Route(0)
        );
    }
}

#[cfg(test)]
mod handshake_tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    fn pair() -> (tokio::io::DuplexStream, tokio::io::DuplexStream) {
        tokio::io::duplex(4096)
    }

    #[tokio::test]
    async fn fragmented_no_auth_and_ipv4_connect_are_accepted() {
        let (mut server, mut client) = pair();
        let task = tokio::spawn(async move {
            let (request, method) = accept(&mut server, true, None).await.unwrap();
            assert_eq!(method, 0);
            assert_eq!(
                request,
                ConnectRequest {
                    destination: Destination::Ip("127.0.0.1".parse().unwrap()),
                    port: 8080
                }
            );
        });
        for byte in [0x05, 0x01, 0x00] {
            client.write_all(&[byte]).await.unwrap();
            tokio::task::yield_now().await;
        }
        let mut reply = [0_u8; 2];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [0x05, 0x00]);
        client
            .write_all(&[0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90])
            .await
            .unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn username_password_domain_connect_is_accepted() {
        let (mut server, mut client) = pair();
        let task = tokio::spawn(async move {
            let verify = |username: &str, password: &str| username == "u" && password == "p";
            let (request, method) = accept(&mut server, false, Some(&verify)).await.unwrap();
            assert_eq!(method, 2);
            assert_eq!(
                request,
                ConnectRequest {
                    destination: Destination::Domain("gitlab.justalk.com".into()),
                    port: 443
                }
            );
        });
        client.write_all(&[0x05, 0x01, 0x02]).await.unwrap();
        let mut reply = [0_u8; 2];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [0x05, 0x02]);
        client.write_all(&[0x01, 1, b'u', 1, b'p']).await.unwrap();
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [0x01, 0x00]);
        let host = b"gitlab.justalk.com";
        client
            .write_all(&[0x05, 0x01, 0x00, 0x03, host.len() as u8])
            .await
            .unwrap();
        client.write_all(host).await.unwrap();
        client.write_all(&[0x01, 0xbb]).await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn optional_authentication_accepts_no_auth_or_password_clients() {
        let (mut server, mut client) = pair();
        let task = tokio::spawn(async move {
            let verify = |username: &str, password: &str| username == "tun" && password == "once";
            let (_, method) = accept(&mut server, true, Some(&verify)).await.unwrap();
            assert_eq!(method, 0);
        });
        client.write_all(&[0x05, 0x02, 0x00, 0x02]).await.unwrap();
        let mut reply = [0_u8; 2];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [0x05, 0x00]);
        client
            .write_all(&[0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 80])
            .await
            .unwrap();
        task.await.unwrap();

        let (mut server, mut client) = pair();
        let task = tokio::spawn(async move {
            let verify = |username: &str, password: &str| username == "tun" && password == "once";
            let (_, method) = accept(&mut server, true, Some(&verify)).await.unwrap();
            assert_eq!(method, 2);
        });
        client.write_all(&[0x05, 0x01, 0x02]).await.unwrap();
        let mut reply = [0_u8; 2];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [0x05, 0x02]);
        client
            .write_all(&[0x01, 3, b't', b'u', b'n', 4, b'o', b'n', b'c', b'e'])
            .await
            .unwrap();
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [0x01, 0x00]);
        client
            .write_all(&[0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 80])
            .await
            .unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn bind_and_udp_commands_are_rejected() {
        for command in [0x02, 0x03] {
            let (mut server, mut client) = pair();
            let task = tokio::spawn(async move {
                assert!(accept(&mut server, true, None).await.is_err());
            });
            client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
            let mut reply = [0_u8; 2];
            client.read_exact(&mut reply).await.unwrap();
            client
                .write_all(&[0x05, command, 0x00, 0x01, 127, 0, 0, 1, 0, 80])
                .await
                .unwrap();
            let mut error = [0_u8; 10];
            client.read_exact(&mut error).await.unwrap();
            assert_eq!(error[1], 0x07);
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn invalid_auth_is_rejected() {
        let (mut server, mut client) = pair();
        let task = tokio::spawn(async move {
            let verify = |_: &str, _: &str| false;
            assert!(accept(&mut server, false, Some(&verify)).await.is_err());
        });
        client.write_all(&[0x05, 0x01, 0x02]).await.unwrap();
        let mut reply = [0_u8; 2];
        client.read_exact(&mut reply).await.unwrap();
        client.write_all(&[0x01, 1, b'u', 1, b'x']).await.unwrap();
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [0x01, 0x01]);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn zero_length_domain_and_port_are_rejected() {
        for request in [
            vec![0x05, 0x01, 0x00, 0x03, 0x00, 0x00, 0x50],
            vec![0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x00],
        ] {
            let (mut server, mut client) = pair();
            let task = tokio::spawn(async move {
                assert!(accept(&mut server, true, None).await.is_err());
            });
            client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
            let mut reply = [0_u8; 2];
            client.read_exact(&mut reply).await.unwrap();
            client.write_all(&request).await.unwrap();
            let mut error = [0_u8; 10];
            client.read_exact(&mut error).await.unwrap();
            assert_eq!(error[1], 0x08);
            task.await.unwrap();
        }
    }
}
