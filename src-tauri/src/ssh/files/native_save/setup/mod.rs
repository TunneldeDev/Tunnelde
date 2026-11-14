//! Host-owned installation. Kept separate from plugin packages and runner authority.
mod consent;
mod installation;
mod package;
mod paths;
mod preparation;
mod remote;

pub(in crate::ssh::files) use installation::install;
pub(in crate::ssh::files::native_save) use paths::{
    canonical_path as canonical_editor_path, split as split_editor_path,
};
pub(in crate::ssh::files::native_save) use remote::canonical_scope;

#[cfg(test)]
mod tests;
