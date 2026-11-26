//! Loopback-only synthetic SSH/SFTP service. No shell execution or outside paths.
use russh::{
    server::{self, Server as _, Session},
    Channel, ChannelId,
};
use russh_sftp::protocol::{
    Attrs, Data, File as SftpFile, FileAttributes, Handle, Name, OpenFlags, Packet, Status,
    StatusCode, Version,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};
#[derive(Serialize)]
pub(super) struct Descriptor {
    pub port: u16,
    password: String,
}
pub(super) async fn start(root: PathBuf) -> Result<Descriptor, String> {
    let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| e.to_string())?;
    let port = socket.local_addr().map_err(|e| e.to_string())?.port();
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .map_err(|e| e.to_string())?;
    let password = uuid::Uuid::new_v4().to_string();
    let mut server = FixtureServer {
        root: Arc::new(root.canonicalize().map_err(|e| e.to_string())?),
        password: password.clone(),
        channels: HashMap::new(),
        shells: HashSet::new(),
    };
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: std::time::Duration::from_millis(50),
        ..Default::default()
    });
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &socket).await;
    });
    Ok(Descriptor { port, password })
}
struct FixtureServer {
    root: Arc<PathBuf>,
    password: String,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    shells: HashSet<ChannelId>,
}
impl server::Server for FixtureServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Self {
            root: self.root.clone(),
            password: self.password.clone(),
            channels: HashMap::new(),
            shells: HashSet::new(),
        }
    }
}
impl server::Handler for FixtureServer {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "debugger" && password == self.password {
            server::Auth::Accept
        } else {
            server::Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            }
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shells.insert(channel);
        session.channel_success(channel)?;
        session.data(channel, b"Tunnelde isolated SSH fixture\r\nNo system shell. Type to verify terminal input.\r\n$ ".to_vec())?;
        Ok(())
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.shells.contains(&channel) {
            return Ok(());
        }
        let output = data
            .iter()
            .flat_map(|byte| {
                if *byte == b'\r' {
                    b"\r\n$ ".to_vec()
                } else {
                    vec![*byte]
                }
            })
            .collect::<Vec<_>>();
        session.data(channel, output)?;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let response = if command == b"pwd" {
            "/\n"
        } else {
            "Synthetic SSH fixture: exec is intentionally unavailable\n"
        };
        session.data(channel, response.as_bytes().to_vec())?;
        session.exit_status_request(channel, if command == b"pwd" { 0 } else { 127 })?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        if let Some(stream) = self.channels.remove(&channel) {
            let handler = Sftp {
                root: self.root.clone(),
                files: HashMap::new(),
                directories: HashMap::new(),
            };
            tokio::spawn(russh_sftp::server::run(stream.into_stream(), handler));
        }
        Ok(())
    }
    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.remove(&channel);
        self.shells.remove(&channel);
        Ok(())
    }
}
struct Sftp {
    root: Arc<PathBuf>,
    files: HashMap<String, std::fs::File>,
    directories: HashMap<String, Vec<SftpFile>>,
}
fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
fn io_error(error: std::io::Error) -> StatusCode {
    match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}
fn attributes(metadata: &std::fs::Metadata) -> FileAttributes {
    #[cfg(unix)]
    let (mode, uid, gid) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.mode(), metadata.uid(), metadata.gid())
    };
    #[cfg(not(unix))]
    let (mode, uid, gid) = (
        if metadata.is_dir() {
            0o040700
        } else {
            0o100600
        },
        1000,
        1000,
    );
    FileAttributes {
        size: Some(metadata.len()),
        permissions: Some(mode),
        uid: Some(uid),
        gid: Some(gid),
        atime: Some(1_795_558_400),
        mtime: Some(1_795_558_400),
        ..FileAttributes::empty()
    }
}
impl Sftp {
    fn path(&self, input: &str) -> Result<PathBuf, StatusCode> {
        let mut result = self.root.as_ref().clone();
        for component in Path::new(input).components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(part) => {
                    result.push(part);
                    if std::fs::symlink_metadata(&result).is_ok_and(|m| m.file_type().is_symlink())
                    {
                        return Err(StatusCode::PermissionDenied);
                    }
                }
                _ => return Err(StatusCode::PermissionDenied),
            }
        }
        Ok(result)
    }
}
impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, StatusCode> {
        let mut version = Version::new();
        version
            .extensions
            .insert("posix-rename@openssh.com".into(), "1".into());
        version
            .extensions
            .insert("fsync@openssh.com".into(), "1".into());
        Ok(version)
    }
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, StatusCode> {
        fn string(data: &mut &[u8]) -> Result<String, StatusCode> {
            if data.len() < 4 {
                return Err(StatusCode::BadMessage);
            }
            let len = u32::from_be_bytes(data[..4].try_into().map_err(|_| StatusCode::BadMessage)?)
                as usize;
            if len > 4096 || data.len() < len + 4 {
                return Err(StatusCode::BadMessage);
            }
            let value = std::str::from_utf8(&data[4..len + 4])
                .map_err(|_| StatusCode::BadMessage)?
                .to_owned();
            *data = &data[len + 4..];
            Ok(value)
        }
        let mut bytes = data.as_slice();
        if request == "posix-rename@openssh.com" {
            let from = self.path(&string(&mut bytes)?)?;
            let to = self.path(&string(&mut bytes)?)?;
            if !bytes.is_empty() || from == *self.root || to == *self.root {
                return Err(StatusCode::PermissionDenied);
            }
            std::fs::rename(from, to).map_err(io_error)?;
        } else if request == "fsync@openssh.com" {
            let handle = string(&mut bytes)?;
            if !bytes.is_empty() {
                return Err(StatusCode::BadMessage);
            }
            self.files
                .get(&handle)
                .ok_or(StatusCode::Failure)?
                .sync_all()
                .map_err(io_error)?;
        } else {
            return Err(StatusCode::OpUnsupported);
        }
        Ok(Packet::Status(status(id)))
    }
    async fn fsetstat(
        &mut self,
        id: u32,
        handle: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?;
        if let Some(size) = attrs.size {
            if size > 16 * 1024 * 1024 {
                return Err(StatusCode::Failure);
            }
            file.set_len(size).map_err(io_error)?;
        }
        #[cfg(unix)]
        if let Some(permissions) = attrs.permissions {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(permissions & 0o777))
                .map_err(io_error)?;
        }
        Ok(status(id))
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        let path = self.path(&path)?;
        #[cfg(unix)]
        if let Some(permissions) = attrs.permissions {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(permissions & 0o777))
                .map_err(io_error)?;
        }
        Ok(status(id))
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        let resolved = self.path(&path)?;
        let relative = resolved
            .strip_prefix(self.root.as_ref())
            .map_err(|_| StatusCode::PermissionDenied)?;
        Ok(Name {
            id,
            files: vec![SftpFile::dummy(format!("/{}", relative.to_string_lossy()))],
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: attributes(&std::fs::metadata(self.path(&path)?).map_err(io_error)?),
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        self.stat(id, path).await
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: attributes(
                &self
                    .files
                    .get(&handle)
                    .ok_or(StatusCode::Failure)?
                    .metadata()
                    .map_err(io_error)?,
            ),
        })
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        if self.directories.len() >= 64 {
            return Err(StatusCode::Failure);
        }
        let entries = std::fs::read_dir(self.path(&path)?)
            .map_err(io_error)?
            .map(|entry| {
                let entry = entry.map_err(io_error)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let metadata = entry.metadata().map_err(io_error)?;
                Ok(SftpFile {
                    filename: name.clone(),
                    longname: name,
                    attrs: attributes(&metadata),
                })
            })
            .collect::<Result<Vec<_>, StatusCode>>()?;
        let handle = uuid::Uuid::new_v4().to_string();
        self.directories.insert(handle.clone(), entries);
        Ok(Handle { id, handle })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        let directory = self
            .directories
            .get_mut(&handle)
            .ok_or(StatusCode::Failure)?;
        if directory.is_empty() {
            return Err(StatusCode::Eof);
        }
        let count = directory.len().min(128);
        Ok(Name {
            id,
            files: directory.drain(..count).collect(),
        })
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if self.files.len() >= 64 {
            return Err(StatusCode::Failure);
        }
        let mut options = std::fs::OpenOptions::new();
        options
            .read(flags.contains(OpenFlags::READ))
            .write(flags.contains(OpenFlags::WRITE))
            .create(flags.contains(OpenFlags::CREATE))
            .truncate(flags.contains(OpenFlags::TRUNCATE))
            .create_new(flags.contains(OpenFlags::EXCLUDE));
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(attrs.permissions.unwrap_or(0o600) & 0o777);
        }
        let file = options.open(self.path(&filename)?).map_err(io_error)?;
        let handle = uuid::Uuid::new_v4().to_string();
        self.files.insert(handle.clone(), file);
        Ok(Handle { id, handle })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let mut data = vec![0; len.min(65536) as usize];
        let size = file.read(&mut data).map_err(io_error)?;
        if size == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(size);
        Ok(Data { id, data })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, StatusCode> {
        if offset > 16 * 1024 * 1024 || data.len() > 1024 * 1024 {
            return Err(StatusCode::Failure);
        }
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        file.write_all(&data).map_err(io_error)?;
        Ok(status(id))
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        self.files.remove(&handle);
        self.directories.remove(&handle);
        Ok(status(id))
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        let path = self.path(&path)?;
        std::fs::create_dir(&path).map_err(io_error)?;
        #[cfg(unix)]
        if let Some(mode) = attrs.permissions {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o777))
                .map_err(io_error)?;
        }
        Ok(status(id))
    }
    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, StatusCode> {
        std::fs::remove_file(self.path(&filename)?).map_err(io_error)?;
        Ok(status(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        let path = self.path(&path)?;
        if path == *self.root {
            return Err(StatusCode::PermissionDenied);
        }
        std::fs::remove_dir(path).map_err(io_error)?;
        Ok(status(id))
    }
    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, StatusCode> {
        let from = self.path(&oldpath)?;
        let to = self.path(&newpath)?;
        if from == *self.root || to == *self.root {
            return Err(StatusCode::PermissionDenied);
        }
        if to.exists() {
            return Err(StatusCode::Failure);
        }
        std::fs::rename(from, to).map_err(io_error)?;
        Ok(status(id))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_cannot_escape_fixture() {
        let root = std::env::temp_dir();
        let sftp = Sftp {
            root: Arc::new(root.clone()),
            files: HashMap::new(),
            directories: HashMap::new(),
        };
        assert_eq!(sftp.path("/README.md").unwrap(), root.join("README.md"));
        assert!(sftp.path("../outside").is_err());
    }
}
