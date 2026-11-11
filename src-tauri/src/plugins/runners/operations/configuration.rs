//! Bounded exclusive config writes. No config values enter durable host metadata.
use crate::{
    error::{AppError, AppResult},
    plugins::runners::{path_join, HostContext, Record},
};
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tokio::io::AsyncWriteExt;

pub(in crate::plugins::runners) mod journal;

pub(super) async fn write(
    context: &HostContext,
    session: &str,
    reserved: &Record,
    bytes: &[u8],
) -> AppResult<(Record, String)> {
    if bytes.len() > 1024 * 1024 {
        return Err(AppError::validation("plugin.runners.inputTooLarge"));
    }
    let deployment = &reserved.deployment;
    super::super::identity::verify(
        deployment,
        &super::super::identity::capture(&context.app, session)?,
    )?;
    let path = path_join(
        &deployment.directory,
        &format!("config-{}.json", reserved.runner_id),
        &deployment.platform,
    );
    let sftp = crate::ssh::files::session(&context.app, session).await?;
    let creating = journal::advance(context, reserved, journal::State::Creating)?;
    let mut file = sftp
        .open_with_flags_and_attributes(
            &path,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            FileAttributes {
                permissions: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let writing = journal::advance(context, &creating, journal::State::Writing)?;
    for chunk in bytes.chunks(64 * 1024) {
        journal::current(context, &writing)?;
        file.write_all(chunk).await?;
    }
    journal::current(context, &writing)?;
    file.shutdown().await?;
    super::super::identity::verify(
        deployment,
        &super::super::identity::capture(&context.app, session)?,
    )?;
    Ok((
        journal::advance(context, &writing, journal::State::Ready)?,
        path,
    ))
}
