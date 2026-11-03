use super::*;
use tokio::net::TcpListener;

async fn echo(mut stream: tokio::net::TcpStream) {
    let (mut read, mut write) = stream.split();
    tokio::io::copy(&mut read, &mut write).await.unwrap();
}
async fn exchange(mut stream: Stream) {
    let data = "代理 tunnel payload 😀".as_bytes();
    stream.write_all(data).await.unwrap();
    let mut result = vec![0; data.len()];
    stream.read_exact(&mut result).await.unwrap();
    assert_eq!(result, data);
}
#[tokio::test]
async fn http_connect_preserves_tunnel_bytes_and_encoded_credentials() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(stream.read_u8().await.unwrap());
        }
        let header = String::from_utf8(header).unwrap();
        assert!(header.starts_with("CONNECT [::1]:22 HTTP/1.1\r\n"));
        let auth = base64::engine::general_purpose::STANDARD.encode("user@host:p:密 码");
        assert!(header.contains(&format!("Proxy-Authorization: Basic {auth}\r\n")));
        stream
            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
            .await
            .unwrap();
        echo(stream).await;
    });
    exchange(
        dial(
            "::1",
            22,
            &format!("http://user%40host:p%3A%E5%AF%86%20%E7%A0%81@127.0.0.1:{port}"),
        )
        .await
        .unwrap(),
    )
    .await;
    server.await.unwrap();
}
#[tokio::test]
async fn rejected_connect_never_falls_back_to_direct() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(stream.read_u8().await.unwrap());
        }
        stream
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            .await
            .unwrap();
    });
    let error = dial("127.0.0.1", port, &format!("http://127.0.0.1:{port}"))
        .await
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "network.proxyRejected");
    server.await.unwrap();
}
#[tokio::test]
async fn socks5_authenticates_and_sends_domain_for_remote_dns() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        stream.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 1, 2]);
        stream.write_all(&[5, 2]).await.unwrap();
        assert_eq!(stream.read_u8().await.unwrap(), 1);
        let len = stream.read_u8().await.unwrap() as usize;
        let mut user = vec![0; len];
        stream.read_exact(&mut user).await.unwrap();
        assert_eq!(user, b"alice");
        let len = stream.read_u8().await.unwrap() as usize;
        let mut pass = vec![0; len];
        stream.read_exact(&mut pass).await.unwrap();
        assert_eq!(pass, b"secret");
        stream.write_all(&[1, 0]).await.unwrap();
        let mut request = [0; 4];
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [5, 1, 0, 3]);
        let len = stream.read_u8().await.unwrap() as usize;
        let mut domain = vec![0; len];
        stream.read_exact(&mut domain).await.unwrap();
        assert_eq!(domain, b"unresolvable.invalid");
        assert_eq!(stream.read_u16().await.unwrap(), 2222);
        stream
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 22])
            .await
            .unwrap();
        echo(stream).await;
    });
    exchange(
        dial(
            "unresolvable.invalid",
            2222,
            &format!("socks5h://alice:secret@127.0.0.1:{port}"),
        )
        .await
        .unwrap(),
    )
    .await;
    server.await.unwrap();
}
#[tokio::test]
async fn socks5_no_auth_supports_ipv4() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        stream.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 1, 0]);
        stream.write_all(&[5, 0]).await.unwrap();
        let mut request = [0; 10];
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [5, 1, 0, 1, 192, 0, 2, 1, 0, 22]);
        stream
            .write_all(&[
                5, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 22,
            ])
            .await
            .unwrap();
        echo(stream).await;
    });
    exchange(
        dial("192.0.2.1", 22, &format!("socks5h://127.0.0.1:{port}"))
            .await
            .unwrap(),
    )
    .await;
    server.await.unwrap();
}
#[test]
fn matcher_preserves_bypass_and_separate_feature_settings() {
    use hyper_util::client::proxy::matcher::Matcher;
    let matcher = Matcher::builder()
        .all("http://127.0.0.1:7890")
        .no("localhost,192.168.0.0/16,.internal")
        .build();
    for target in [
        "https://localhost/",
        "https://192.168.5.204/",
        "https://service.internal/",
    ] {
        assert!(matcher.intercept(&target.parse().unwrap()).is_none());
    }
    assert!(matcher
        .intercept(&"https://example.com/".parse().unwrap())
        .is_some());
    let settings: NetworkSettings = serde_json::from_str(r#"{"defaultProxy":"direct","features":{"ssh":"system","marketplace":"direct","plugin:test":"system"}}"#).unwrap();
    assert_eq!(selection(&settings, "updates", None), "direct");
    assert_eq!(selection(&settings, "ssh", None), "system");
    assert_eq!(
        selection(
            &settings,
            "processes",
            settings.features.get("plugin:test").map(String::as_str)
        ),
        "system"
    );
}
