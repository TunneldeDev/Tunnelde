//! Explicit calls only. A timeout/lost response never starts a replacement operation.
use super::{
    codec,
    contracts::{
        authority::{Authority, Context, Platform},
        operation::{Control, Prepared, Request},
        receipt::{Observation, Phase, Publication},
        MAX_PACKET,
    },
    transport::{Exchange, Failure, Reason},
};

pub(super) struct Client<T> {
    transport: T,
    authority: Authority,
    platform: Platform,
}
impl<T: Exchange> Client<T> {
    #[cfg(test)]
    pub fn test_transport(&self) -> &T {
        &self.transport
    }
    pub async fn initialize(
        transport: T,
        context: Context,
        platform: Platform,
    ) -> Result<Self, Failure> {
        if !context.valid(platform) {
            return Err(Failure::before(Reason::InvalidRequest));
        }
        transport.authorize(&context)?;
        let bytes = encode(&Request::Initialize {
            schema_version: 1,
            storage: "local",
            context: &context,
        })?;
        let authority = codec::initialize(transport.exchange(bytes).await?, &context, platform)?;
        Ok(Self {
            transport,
            authority,
            platform,
        })
    }
    // Restore only an original authority; this never initializes or resets remote storage.
    pub fn restore(
        transport: T,
        authority: Authority,
        platform: Platform,
    ) -> Result<Self, Failure> {
        if !authority.valid(platform) {
            return Err(Failure::before(Reason::InvalidRequest));
        }
        transport.authorize(&authority.context)?;
        Ok(Self {
            transport,
            authority,
            platform,
        })
    }
    pub fn authority(&self) -> &Authority {
        &self.authority
    }
    async fn request(
        &self,
        request: Request<'_>,
        control: &Control,
    ) -> Result<Option<Observation>, Failure> {
        if !control.valid() || control.authority_id != self.authority.authority_id {
            return Err(Failure::before(Reason::AuthorityChanged));
        }
        self.transport.authorize(&self.authority.context)?;
        codec::operation(
            self.transport.exchange(encode(&request)?).await?,
            &self.authority,
            control,
            self.platform,
        )
    }
    pub async fn submit(
        &self,
        prepared: &Prepared,
        permit: super::journal::DispatchPermit,
    ) -> Result<Observation, Failure> {
        if !prepared.valid(&self.authority) || !permit.matches(&self.authority, prepared) {
            return Err(Failure::before(Reason::InvalidRequest));
        }
        self.request(
            Request::Submit {
                control: &prepared.control,
                intent: &prepared.intent,
                content: &prepared.content,
            },
            &prepared.control,
        )
        .await?
        .ok_or(Failure {
            reason: Reason::MissingOperation,
            dispatched: true,
        })
    }
    pub async fn status(
        &self,
        control: &Control,
        previous: Option<&Observation>,
    ) -> Result<Option<Observation>, Failure> {
        if previous.is_some_and(|v| !v.matches(control) || !v.valid()) {
            return Err(Failure::before(Reason::InvalidRequest));
        }
        let next = self.request(Request::Status { control }, control).await?;
        if previous.is_some_and(|old| next.as_ref().is_none_or(|new| !follows(old, new))) {
            return Err(Failure {
                reason: Reason::StaleReceipt,
                dispatched: true,
            });
        }
        Ok(next)
    }
    pub async fn cancel(&self, control: &Control) -> Result<Observation, Failure> {
        self.request(Request::Cancel { control }, control)
            .await?
            .ok_or(Failure {
                reason: Reason::MissingOperation,
                dispatched: true,
            })
    }
    pub async fn release(
        &self,
        control: &Control,
        receipt: &Observation,
        discard_backup: bool,
    ) -> Result<Observation, Failure> {
        if !receipt.valid()
            || !receipt.matches(control)
            || !receipt.releasable()
            || (receipt.backup_retained == Some(true) && !discard_backup)
        {
            return Err(Failure::before(Reason::NotReleasable));
        }
        let response = self
            .request(
                Request::Release {
                    control,
                    revision: receipt.revision,
                    discard_backup,
                },
                control,
            )
            .await?
            .ok_or(Failure {
                reason: Reason::MissingOperation,
                dispatched: true,
            })?;
        if response.phase != Phase::Released || !follows(receipt, &response) {
            return Err(Failure {
                reason: Reason::InvalidResponse,
                dispatched: true,
            });
        }
        Ok(response)
    }
}
fn encode(request: &Request<'_>) -> Result<Vec<u8>, Failure> {
    let bytes = serde_json::to_vec(request).map_err(|_| Failure::before(Reason::InvalidRequest))?;
    if bytes.len() > MAX_PACKET {
        return Err(Failure::before(Reason::InvalidRequest));
    }
    Ok(bytes)
}
pub(super) fn follows(old: &Observation, new: &Observation) -> bool {
    if old.operation_id != new.operation_id
        || old.generation != new.generation
        || old.intent_sha256 != new.intent_sha256
        || new.revision < old.revision
        || (old.publication == Publication::Published && new.publication != Publication::Published)
    {
        return false;
    }
    // Projection may temporarily become unknown without a durable revision.
    // Every other phase change requires a newer durable server receipt.
    if old.revision == new.revision
        && old.phase != new.phase
        && !matches!(old.phase, Phase::Unknown)
        && !matches!(new.phase, Phase::Unknown)
    {
        return false;
    }
    if old.phase == Phase::Released {
        return new.phase == Phase::Released;
    }
    if old.phase == Phase::Publishing
        && matches!(
            new.phase,
            Phase::Prepared | Phase::Running | Phase::Failed | Phase::Cancelled
        )
    {
        return false;
    }
    if old.phase == Phase::Releasing
        && !matches!(
            new.phase,
            Phase::Releasing | Phase::Released | Phase::Unknown
        )
    {
        return false;
    }
    if matches!(
        old.phase,
        Phase::Succeeded | Phase::Conflict | Phase::Failed | Phase::Cancelled | Phase::Released
    ) {
        return new.phase == old.phase
            || (new.revision > old.revision
                && matches!(
                    new.phase,
                    Phase::Releasing | Phase::Released | Phase::Unknown
                ));
    }
    new.phase != Phase::Prepared || old.phase == Phase::Prepared
}
#[cfg(test)]
mod tests;
