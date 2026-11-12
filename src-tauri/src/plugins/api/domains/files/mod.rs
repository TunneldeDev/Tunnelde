//! File RPC adapters. Local publication, SFTP and owned transfers remain separate.
mod content;
mod local;
mod preview;
mod remote;
pub(in crate::plugins::api) mod text;
mod transfers;

use crate::{
    error::AppResult,
    plugins::api::{frontend_request, HostContext},
};
use serde_json::Value;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    match method {
        name if name.starts_with("filePreview.") => preview::dispatch(context, name, params).await,
        name if name.starts_with("files.content.") => {
            content::dispatch(context, name, params).await
        }
        name if name.starts_with("fileBrowser.") => frontend_request(context, name, params).await,
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
