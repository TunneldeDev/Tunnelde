//! Deterministic SFTP server for mutation acknowledgement and recovery tests.
use super::*;
use russh_sftp::protocol::*;
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub(super) struct Tree {
    pub directories: std::collections::HashSet<String>,
    pub files: HashMap<String, Vec<u8>>,
    pub modes: HashMap<String, u32>,
    pub lstats: usize,
}

pub(super) struct Gate {
    pub before_create: bool,
    pub arrived: tokio::sync::Semaphore,
    pub release: tokio::sync::Semaphore,
    pub finished: tokio::sync::Semaphore,
}

struct Server {
    tree: Arc<Mutex<Tree>>,
    gate: Option<Arc<Gate>>,
    mkdir_gate: Option<Arc<Gate>>,
    remove_gate: Option<Arc<Gate>>,
    listed: std::collections::HashSet<String>,
}

impl Server {
    async fn wait_removal(&self, before: bool) {
        if let Some(gate) = &self.remove_gate {
            if gate.before_create == before {
                gate.arrived.add_permits(1);
                gate.release.acquire().await.unwrap().forget();
            }
            if !before {
                gate.finished.add_permits(1);
            }
        }
    }
}

fn status(id: u32) -> Status {
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
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        let mut tree = self.tree.lock().unwrap();
        tree.lstats += 1;
        let mut attrs = FileAttributes::empty();
        if tree.directories.contains(&path) {
            attrs.permissions = Some(tree.modes.get(&path).copied().unwrap_or(0o40700));
        } else if let Some(data) = tree.files.get(&path) {
            attrs.permissions = Some(tree.modes.get(&path).copied().unwrap_or(0o100600));
            attrs.size = Some(data.len() as u64);
        } else {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Attrs { id, attrs })
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if let Some(gate) = self.gate.as_ref().filter(|g| g.before_create) {
            gate.arrived.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
        }
        let created = {
            let mut tree = self.tree.lock().unwrap();
            let parent = path.rsplit_once('/').unwrap().0;
            if !tree.directories.contains(parent) {
                Err(StatusCode::NoSuchFile)
            } else if flags.contains(OpenFlags::EXCLUDE) && tree.files.contains_key(&path) {
                Err(StatusCode::Failure)
            } else {
                tree.files.entry(path).or_default();
                Ok(())
            }
        };
        if let Some(gate) = self.gate.as_ref().filter(|g| !g.before_create) {
            gate.arrived.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
        }
        if let Some(gate) = &self.gate {
            gate.finished.add_permits(1);
        }
        created?;
        Ok(Handle {
            id,
            handle: "empty-writer".into(),
        })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        if let Some(gate) = self.mkdir_gate.as_ref().filter(|gate| gate.before_create) {
            gate.arrived.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
        }
        {
            let mut tree = self.tree.lock().unwrap();
            if tree.directories.contains(&path) || tree.files.contains_key(&path) {
                return Err(StatusCode::Failure);
            }
            tree.modes
                .insert(path.clone(), 0o40000 | attrs.permissions.unwrap_or(0o755));
            tree.directories.insert(path);
        }
        if let Some(gate) = &self.mkdir_gate {
            if !gate.before_create {
                gate.arrived.add_permits(1);
                gate.release.acquire().await.unwrap().forget();
            }
            gate.finished.add_permits(1);
        }
        Ok(status(id))
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        if !self.tree.lock().unwrap().directories.contains(&path) {
            return Err(StatusCode::NoSuchFile);
        }
        self.listed.remove(&path);
        Ok(Handle { id, handle: path })
    }
    async fn readdir(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        if !self.listed.insert(path.clone()) {
            return Err(StatusCode::Eof);
        }
        let tree = self.tree.lock().unwrap();
        let prefix = path + "/";
        let files: Vec<_> = tree
            .files
            .keys()
            .chain(tree.directories.iter())
            .filter_map(|path| path.strip_prefix(&prefix))
            .filter(|name| !name.contains('/'))
            .map(|name| File {
                filename: name.into(),
                longname: name.into(),
                attrs: FileAttributes::empty(),
            })
            .collect();
        if files.is_empty() {
            return Err(StatusCode::Eof);
        }
        Ok(Name { id, files })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
        Ok(status(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        self.wait_removal(true).await;
        self.tree
            .lock()
            .unwrap()
            .files
            .remove(&path)
            .ok_or(StatusCode::NoSuchFile)?;
        self.wait_removal(false).await;
        Ok(status(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        self.wait_removal(true).await;
        {
            let mut tree = self.tree.lock().unwrap();
            let prefix = path.clone() + "/";
            if tree.files.keys().any(|p| p.starts_with(&prefix))
                || tree.directories.iter().any(|p| p.starts_with(&prefix))
            {
                return Err(StatusCode::Failure);
            }
            if !tree.directories.remove(&path) {
                return Err(StatusCode::NoSuchFile);
            }
        }
        self.wait_removal(false).await;
        Ok(status(id))
    }
}

pub(super) async fn client(tree: Arc<Mutex<Tree>>, gate: Option<Arc<Gate>>) -> Arc<SftpSession> {
    metadata_client(tree, gate, None).await
}

pub(super) async fn cleanup_client(tree: Arc<Mutex<Tree>>, gate: Arc<Gate>) -> Arc<SftpSession> {
    metadata_client(tree, None, Some(gate)).await
}

async fn metadata_client(
    tree: Arc<Mutex<Tree>>,
    gate: Option<Arc<Gate>>,
    remove_gate: Option<Arc<Gate>>,
) -> Arc<SftpSession> {
    let (client, server) = tokio::io::duplex(65536);
    russh_sftp::server::run(
        server,
        Server {
            tree,
            gate,
            mkdir_gate: None,
            remove_gate,
            listed: Default::default(),
        },
    )
    .await;
    Arc::new(SftpSession::new(client).await.unwrap())
}

pub(super) async fn directory_client(
    tree: Arc<Mutex<Tree>>,
    mkdir_gate: Option<Arc<Gate>>,
) -> range_io::DataSession {
    let (client, server) = tokio::io::duplex(65536);
    russh_sftp::server::run(
        server,
        Server {
            tree,
            gate: None,
            mkdir_gate,
            remove_gate: None,
            listed: Default::default(),
        },
    )
    .await;
    range_io::DataSession::new(client).await.unwrap()
}
