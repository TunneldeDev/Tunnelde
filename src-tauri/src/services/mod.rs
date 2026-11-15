//! Domain operations shared by native commands and plugin transports.
//! Authorization belongs to the caller; validation and effects belong here.
pub(crate) mod credentials;
pub(crate) mod editor;
pub mod files;
pub mod forwarding;
pub mod history;
pub mod host_fields;
pub mod hosts;
pub(crate) mod operations;
pub mod plugin_configuration;
pub mod settings;
