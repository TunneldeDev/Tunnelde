use super::*;
use russh_sftp::protocol::*;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct Tree {
    pub directory: bool,
    pub bytes: Option<Vec<u8>>,
    pub modes: Vec<u32>,
    pub opens: Vec<OpenFlags>,
    pub external: Option<Vec<u8>>,
    pub failure: &'static str,
    pub closes: usize,
}

struct Server(Arc<Mutex<Tree>>);

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, StatusCode> {
        Ok(Version::new())
    }
    async fn realpath(&mut self, id: u32, _: String) -> Result<Name, StatusCode> {
        if self.0.lock().unwrap().failure == "home" {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(Name {
            id,
            files: vec![File {
                filename: "/home/qa".into(),
                longname: String::new(),
                attrs: FileAttributes::empty(),
            }],
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        assert_eq!(path, "/home/qa/.ssh");
        let tree = self.0.lock().unwrap();
        if !tree.directory {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                permissions: Some(0o40700),
                ..Default::default()
            },
        })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        assert_eq!(path, "/home/qa/.ssh");
        let mut tree = self.0.lock().unwrap();
        if tree.failure == "mkdir" {
            return Err(StatusCode::PermissionDenied);
        }
        tree.directory = true;
        if tree.failure == "competing-mkdir" {
            return Err(StatusCode::Failure);
        }
        tree.modes.push(attrs.permissions.unwrap());
        Ok(ok(id))
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        assert_eq!(path, "/home/qa/.ssh/authorized_keys");
        let mut tree = self.0.lock().unwrap();
        tree.opens.push(flags);
        if flags.contains(OpenFlags::READ) {
            if tree.failure == "read-open" {
                return Err(StatusCode::PermissionDenied);
            }
            if tree.bytes.is_none() {
                return Err(StatusCode::NoSuchFile);
            }
            return Ok(Handle {
                id,
                handle: "read".into(),
            });
        }
        if let Some(external) = tree.external.take() {
            tree.bytes.get_or_insert_default().extend(external);
        }
        if !flags.contains(OpenFlags::CREATE) && tree.bytes.is_none() {
            return Err(StatusCode::NoSuchFile);
        }
        if tree.bytes.is_none() {
            tree.modes.push(attrs.permissions.unwrap());
        }
        let bytes = tree.bytes.get_or_insert_default();
        if flags.contains(OpenFlags::TRUNCATE) {
            bytes.clear();
        }
        Ok(Handle {
            id,
            handle: if flags.contains(OpenFlags::APPEND) {
                "append"
            } else {
                "write"
            }
            .into(),
        })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        assert_eq!(handle, "read");
        let tree = self.0.lock().unwrap();
        if tree.failure == "read" {
            return Err(StatusCode::PermissionDenied);
        }
        let bytes = tree.bytes.as_ref().unwrap();
        let offset = offset as usize;
        if offset >= bytes.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: bytes[offset..(offset + len as usize).min(bytes.len())].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, StatusCode> {
        let mut tree = self.0.lock().unwrap();
        if tree.failure == "write" {
            return Err(StatusCode::Failure);
        }
        let bytes = tree.bytes.as_mut().unwrap();
        let offset = if handle == "append" {
            bytes.len()
        } else {
            offset as usize
        };
        if bytes.len() < offset + data.len() {
            bytes.resize(offset + data.len(), 0);
        }
        bytes[offset..offset + data.len()].copy_from_slice(&data);
        Ok(ok(id))
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        let mut tree = self.0.lock().unwrap();
        tree.closes += 1;
        if handle != "read" && tree.failure == "close" {
            return Err(StatusCode::Failure);
        }
        Ok(ok(id))
    }
}

pub(super) async fn client(tree: Tree) -> (RawSftpSession, Arc<Mutex<Tree>>) {
    let (client, server) = tokio::io::duplex(65536);
    let tree = Arc::new(Mutex::new(tree));
    russh_sftp::server::run(server, Server(tree.clone())).await;
    let client = RawSftpSession::new(client);
    client.init().await.unwrap();
    (client, tree)
}
