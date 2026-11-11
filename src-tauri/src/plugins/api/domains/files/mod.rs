//! File RPC adapters. Local publication, SFTP and owned transfers remain separate.
mod local;
mod remote;
pub(in crate::plugins::api) mod text;
mod transfers;

use crate::{error::AppResult, plugins::api::HostContext};
use serde_json::Value;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    match method {
        "files.local.copy"
        | "files.sftp.copy"
        | "files.upload"
        | "files.download"
        | "files.cancelTransfer"
        | "files.transferStatus" => transfers::dispatch(context, method, params).await,
        name if name.starts_with("files.local.") => local::dispatch(context, method, params).await,
        _ => remote::dispatch(context, method, params).await,
    }
}
