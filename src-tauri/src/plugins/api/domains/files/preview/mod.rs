mod requests;

use crate::{
    error::AppResult,
    plugins::api::{
        frontend_request, transport::frontend::frontend_request_with_permissions, HostContext,
    },
};
use serde_json::Value;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if method == "filePreview.open" {
        let request: requests::Open =
            serde_json::from_value(params.clone()).map_err(|_| requests::invalid())?;
        request.validate()?;
        frontend_request_with_permissions(context, method, params, request.permissions()).await
    } else {
        frontend_request(context, method, params).await
    }
}
