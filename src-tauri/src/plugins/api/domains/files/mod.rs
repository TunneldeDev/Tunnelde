//! File RPC adapters. Local publication, SFTP and owned transfers remain separate.
mod content;
mod local;
mod local_write;
mod preview;
mod remote;
mod remote_mutation;
pub(in crate::plugins::api) mod remote_write;
pub(in crate::plugins::api) mod text;
mod transfers;
mod write_policy;

use crate::{
    error::AppResult,
    plugins::api::{frontend_request, HostContext},
};
use serde_json::Value;

pub(in crate::plugins::api) fn owns_namespace(namespace: &str) -> bool {
    matches!(
        namespace,
        "files" | "fileBrowser" | "filePreview" | "fileList"
    )
}

pub(in crate::plugins::api) fn supports_file_list(method: &str) -> bool {
    matches!(
        method,
        "fileList.setHighlights" | "fileList.removeHighlights"
    )
}

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if supports_file_list(method) {
        return crate::plugins::file_highlights::call(context, method, params);
    }
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
