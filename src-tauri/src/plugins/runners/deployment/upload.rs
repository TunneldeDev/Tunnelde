//! Upload only into an acknowledged fresh deployment; never truncate replacements.
use super::{
    super::{authorize, path_join, Deployment, HostContext},
    package::Package,
};
use crate::error::{AppError, AppResult};
use russh_sftp::{
    client::{fs::File, SftpSession},
    protocol::{FileAttributes, OpenFlags},
};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_HELPER: u64 = 64 * 1024 * 1024;

pub(super) async fn helper(path: &Path) -> AppResult<tokio::fs::File> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::validation(
            "plugin.runners.explicitBinaryRequired",
        ));
    }
    let file = tokio::fs::File::open(path).await?;
    if file.metadata().await?.len() > MAX_HELPER {
        return Err(AppError::validation("plugin.runners.binaryTooLarge"));
    }
    Ok(file)
}

async fn create(sftp: &SftpSession, path: &str, mode: u32) -> AppResult<File> {
    sftp.open_with_flags_and_attributes(
        path,
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
        FileAttributes {
            permissions: Some(mode),
            ..Default::default()
        },
    )
    .await
    .map_err(|error| AppError::Ssh(error.to_string()))
}

pub(super) async fn execute(
    context: &HostContext,
    sftp: &SftpSession,
    deployment: &Deployment,
    mut helper: tokio::fs::File,
    package: Package,
) -> AppResult<()> {
    authorize(context, &["sftp.write"])?;
    if deployment.platform != "windows" {
        sftp.set_metadata(
            &deployment.directory,
            FileAttributes {
                permissions: Some(0o700),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    }
    let mut output = create(sftp, &deployment.runner, 0o700).await?;
    let mut chunk = vec![0; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let size = helper.read(&mut chunk).await?;
        if size == 0 {
            break;
        }
        bytes += size as u64;
        if bytes > MAX_HELPER {
            return Err(AppError::validation("plugin.runners.binaryTooLarge"));
        }
        authorize(context, &["sftp.write"])?;
        output.write_all(&chunk[..size]).await?;
    }
    output.shutdown().await?;
    for directory in package.directories {
        authorize(context, &["sftp.write"])?;
        sftp.create_dir(path_join(
            &deployment.directory,
            &directory,
            &deployment.platform,
        ))
        .await
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    }
    for (name, data) in package.files {
        authorize(context, &["sftp.write"])?;
        let path = path_join(&deployment.directory, &name, &deployment.platform);
        let mut output = create(sftp, &path, 0o600).await?;
        for chunk in data.chunks(64 * 1024) {
            authorize(context, &["sftp.write"])?;
            output.write_all(chunk).await?;
        }
        output.shutdown().await?;
    }
    Ok(())
}
