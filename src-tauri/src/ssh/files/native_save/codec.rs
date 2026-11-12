//! Closed, bounded responses are useful only for the original authenticated authority.
use super::{
    contracts::{
        authority::{Authority, Context, Platform},
        operation::Control,
        receipt::{Observation, Response},
        MAX_OUTPUT, PROTOCOL,
    },
    transport::{Failure, Output, Reason},
};

fn envelope(output: Output, platform: Platform) -> Result<Response, Failure> {
    let fail = |reason| Failure {
        reason,
        dispatched: true,
    };
    if output.stdout.len().saturating_add(output.stderr.len()) > MAX_OUTPUT {
        return Err(fail(Reason::OutputTooLarge));
    }
    match output.code {
        None => return Err(fail(Reason::MissingExitStatus)),
        Some(0) => (),
        Some(_) => return Err(fail(Reason::RemoteRejected)),
    }
    let response: Response =
        serde_json::from_slice(&output.stdout).map_err(|_| fail(Reason::InvalidResponse))?;
    if response.schema_version != 1 || response.protocol != PROTOCOL {
        return Err(fail(Reason::UnsupportedProtocol));
    }
    if response.cleanup_authorized
        || !response.authority.valid(platform)
        || response.binding_sha256 != response.authority.binding()
        || response.observation.as_ref().is_some_and(|v| !v.valid())
    {
        return Err(fail(Reason::InvalidResponse));
    }
    Ok(response)
}
pub(super) fn initialize(
    output: Output,
    context: &Context,
    platform: Platform,
) -> Result<Authority, Failure> {
    let response = envelope(output, platform)?;
    if response.authority.context != *context || response.observation.is_some() {
        return Err(Failure {
            reason: Reason::AuthorityChanged,
            dispatched: true,
        });
    }
    Ok(response.authority)
}
pub(super) fn operation(
    output: Output,
    authority: &Authority,
    control: &Control,
    platform: Platform,
) -> Result<Option<Observation>, Failure> {
    let response = envelope(output, platform)?;
    if response.authority != *authority
        || control.authority_id != authority.authority_id
        || response
            .observation
            .as_ref()
            .is_some_and(|v| !v.matches(control))
    {
        return Err(Failure {
            reason: Reason::AuthorityChanged,
            dispatched: true,
        });
    }
    Ok(response.observation)
}
#[cfg(test)]
mod tests;
