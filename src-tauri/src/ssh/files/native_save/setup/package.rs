//! Reviewed immutable assets; unverified bytes cannot become executable uploads.
use super::super::{contracts, journal::setup::Package as Identity};
use crate::error::{AppError, AppResult};
use std::time::Duration;

const VERSION: &str = "0.28.0";
const RELEASE: &str = "https://github.com/TunneldeDev/Tunnelde-agent/releases/download/v0.28.0";

#[derive(Clone, Copy)]
pub(super) struct Package {
    pub platform: &'static str,
    pub sha256: &'static str,
    pub bytes: usize,
}
const PACKAGES: &[Package] = &[
    Package {
        platform: "linux-x86_64",
        sha256: "406f32d56c569180dba49d49e4d7842f6634fb58ff0fdba14df1cdf4a31fb592",
        bytes: 4_660_728,
    },
    Package {
        platform: "linux-aarch64",
        sha256: "68f8bd1d8d2c5fb212f04c3cd1a863961e6301323b8e618824e3890965ade2a0",
        bytes: 4_281_320,
    },
    Package {
        platform: "macos-x86_64",
        sha256: "bdf42bc46f365fd75eb6a8aa81b24f8eb9ab0918282d6a8749b441871ce830ed",
        bytes: 4_291_696,
    },
    Package {
        platform: "macos-aarch64",
        sha256: "e58f79ff82aa63124246d26b6553d65e67e5313d1e2d4ca2a23c0ae1b6084064",
        bytes: 3_820_944,
    },
    Package {
        platform: "windows-x86_64",
        sha256: "b158ab99f8b56aea3c6c4af3887900e2c00ba35f88b1981d6835ae4dbee2a246",
        bytes: 3_859_968,
    },
];

/// Only this module can construct verified bytes. No caller-supplied URL/hash.
pub(super) struct Verified {
    package: Package,
    bytes: Vec<u8>,
}
impl Verified {
    pub fn identity(&self) -> Identity {
        self.package.identity()
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}
impl Package {
    pub fn select(platform: &str) -> AppResult<Self> {
        PACKAGES
            .iter()
            .copied()
            .find(|item| item.platform == platform)
            .ok_or_else(|| AppError::validation("editor.nativePlatformUnsupported"))
    }
    pub fn identity(self) -> Identity {
        Identity {
            version: VERSION.into(),
            platform: self.platform.into(),
            sha256: self.sha256.into(),
        }
    }
    pub fn filename(self) -> String {
        format!(
            "tunnelde-agent-{VERSION}-{}{}",
            self.platform,
            if self.platform.starts_with("windows-") {
                ".exe"
            } else {
                ""
            }
        )
    }
    pub fn url(self) -> String {
        format!("{RELEASE}/{}", self.filename())
    }
    pub fn verify(self, bytes: Vec<u8>) -> AppResult<Verified> {
        if bytes.len() != self.bytes || contracts::hash(b"", &bytes) != self.sha256 {
            return Err(AppError::validation("editor.nativePackageInvalid"));
        }
        Ok(Verified {
            package: self,
            bytes,
        })
    }
    pub async fn download(self, client: &reqwest::Client) -> AppResult<Verified> {
        self.receive(client, &self.url()).await
    }
    // URL substitution is private and used only by the isolated HTTP tests.
    async fn receive(self, client: &reqwest::Client, url: &str) -> AppResult<Verified> {
        let url = reqwest::Url::parse(url)
            .map_err(|_| AppError::validation("editor.nativeDownloadFailed"))?;
        let mut response = crate::network::requests::idempotent_get(client, url, Duration::from_secs(120))
            .await
            .map_err(|error| {
                tracing::warn!(target: "files.setup", stage = "package_request",
                    timeout = error.is_timeout(), connect = error.is_connect(),
                    detail = crate::network::diagnostics::redact_error_detail(&format!("{:?}", error.without_url())),
                    "Official save helper download request failed");
                AppError::validation("editor.nativeDownloadFailed")
            })?;
        // Range/partial responses may never initialize an executable.
        if response.status() != reqwest::StatusCode::OK {
            tracing::warn!(target: "files.setup", stage = "package_response",
                status = response.status().as_u16(), "Official save helper download was rejected");
            return Err(AppError::validation("editor.nativeDownloadFailed"));
        }
        if response
            .content_length()
            .is_some_and(|length| length != self.bytes as u64)
        {
            return Err(AppError::validation("editor.nativePackageInvalid"));
        }
        let mut bytes = Vec::with_capacity(self.bytes);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| {
                tracing::warn!(target: "files.setup", stage = "package_body", timeout = error.is_timeout(),
                    "Official save helper download was interrupted");
                AppError::validation("editor.nativeDownloadFailed")
            })?
        {
            if chunk.len() > self.bytes.saturating_sub(bytes.len()) {
                return Err(AppError::validation("editor.nativePackageInvalid"));
            }
            bytes.extend_from_slice(&chunk);
        }
        self.verify(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn immutable_catalogue_has_only_reviewed_platforms_and_rejects_wrong_bytes() {
        assert_eq!(PACKAGES.len(), 5);
        let mut platforms = std::collections::HashSet::new();
        for package in PACKAGES {
            assert!(platforms.insert(package.platform));
            assert!(contracts::digest(package.sha256));
            assert!(package.bytes <= 8 * 1024 * 1024);
            assert!(package.identity().platform().is_some());
            assert!(package.verify(vec![0; package.bytes]).is_err());
            assert!(package.verify(Vec::new()).is_err());
        }
        assert!(Package::select("linux-musl-x86_64").is_err());
        assert!(Package::select("../../arbitrary").is_err());
    }

    async fn serve(response: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/asset", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                assert!(request.len() <= 4096, "unexpected fixture request size");
            }
            // Rejections may close the connection before the body is sent.
            let _ = socket.write_all(&response).await;
        });
        (url, task)
    }
    #[tokio::test]
    async fn actual_http_stream_rejects_partial_oversize_short_and_corrupt_responses() {
        let bytes = b"reviewed binary fixture";
        let digest = contracts::hash(b"", bytes);
        let package = Package {
            platform: "linux-x86_64",
            sha256: Box::leak(digest.into_boxed_str()),
            bytes: bytes.len(),
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (header, body, accepted) in [
            (
                format!("200 OK\r\nContent-Length: {}", bytes.len()),
                bytes.as_slice(),
                true,
            ),
            (
                format!("206 Partial Content\r\nContent-Length: {}", bytes.len()),
                bytes.as_slice(),
                false,
            ),
            (
                "200 OK\r\nContent-Length: 9999".into(),
                b"short".as_slice(),
                false,
            ),
            ("200 OK".into(), b"too short".as_slice(), false),
            (
                "200 OK".into(),
                b"longer than the reviewed binary fixture".as_slice(),
                false,
            ),
            (
                "200 OK".into(),
                b"Reviewed binary fixture".as_slice(),
                false,
            ),
        ] {
            let mut response =
                format!("HTTP/1.1 {header}\r\nConnection: close\r\n\r\n").into_bytes();
            response.extend_from_slice(body);
            let (url, server) = serve(response).await;
            assert_eq!(package.receive(&client, &url).await.is_ok(), accepted);
            server.await.unwrap();
        }
    }

    #[test]
    #[ignore = "requires an explicitly selected immutable public helper"]
    fn selected_public_package_matches_the_pinned_catalogue() {
        let path = std::env::var_os("TUNNELDE_TEST_FILE_SAVE_HELPER").expect("explicit QA helper");
        let path = std::path::Path::new(&path);
        let package = PACKAGES
            .iter()
            .copied()
            .find(|item| path.file_name().unwrap() == item.filename().as_str())
            .expect("reviewed asset name");
        let verified = package.verify(std::fs::read(path).unwrap()).unwrap();
        assert_eq!(verified.identity().version, VERSION);
    }
}
