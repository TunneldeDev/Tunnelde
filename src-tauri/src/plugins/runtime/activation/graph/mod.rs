mod catalogue;
mod declaration;
mod resolution;

pub(super) use resolution::{resolve, revalidate};

pub(super) fn validate_declaration(
    owner: &str,
    dependencies: &[super::PluginDependency],
) -> Result<(), super::contracts::Issue> {
    declaration::parse(owner, dependencies).map(|_| ())
}
