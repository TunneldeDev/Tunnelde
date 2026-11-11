//! Explicit initialize transport; discovery failure never selects a file fallback.
pub(crate) mod contracts;
mod input;
pub(super) use input::Request;

use super::{authorize, capabilities, Deployment, HostContext};
use crate::error::{AppError, AppResult};

pub(super) async fn require_support(
    context: &HostContext,
    session: &str,
    deployment: &Deployment,
) -> AppResult<()> {
    if deployment
        .remote_runner
        .as_ref()
        .map(|declaration| declaration.configuration)
        != Some(contracts::Configuration::InitializeV1)
    {
        return Err(AppError::validation(
            "plugin.runners.initializationNotDeclared",
        ));
    }
    authorize(context, &["ssh.exec"])?;
    let result = capabilities::observe(context, session, deployment).await;
    authorize(context, &["ssh.exec"])?;
    super::identity::verify(
        deployment,
        &super::identity::capture(&context.app, session)?,
    )?;
    if supports(&result) {
        Ok(())
    } else {
        Err(AppError::validation(
            "plugin.runners.initializationUnsupported",
        ))
    }
}

pub(in crate::plugins::runners) fn supports(result: &capabilities::contracts::Result) -> bool {
    matches!(result,
        capabilities::contracts::Result::Available { envelope }
            if envelope.runner_protocols.contains(&1)
                && envelope
                    .features
                    .iter()
                    .any(|feature| feature == "runner.initialize-config.v1")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_release_version_and_other_features_never_imply_initialized_support() {
        for (features, expected) in [
            (vec!["runner.control.v1"], false),
            (vec!["runner.initialize-config.v1"], true),
            (vec!["runner.initialize-config.v2"], false),
        ] {
            let result = capabilities::contracts::Result::Available {
                envelope: capabilities::contracts::Envelope {
                    schema_version: 1,
                    helper: "tunnelde-agent".into(),
                    helper_version: "999.0.0".into(),
                    runner_protocols: vec![1],
                    features: features.into_iter().map(String::from).collect(),
                },
            };
            assert_eq!(supports(&result), expected);
        }
        assert!(!supports(&capabilities::contracts::Result::Unavailable {
            reason: capabilities::contracts::Reason::Timeout,
            exit_code: None,
        }));
    }
}
