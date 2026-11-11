use std::collections::BTreeMap;

use super::super::{
    contracts::{Issue, Limit, Package, PackageField},
    MAX_CATALOGUE, MAX_RANGE_BYTES,
};
use crate::plugins::manifest::{normalized_version, valid_id};

pub(super) struct Catalogue {
    packages: BTreeMap<String, Package>,
}

impl Catalogue {
    pub fn new(packages: impl IntoIterator<Item = Package>) -> Result<Self, Issue> {
        let mut indexed = BTreeMap::new();
        for (index, package) in packages.into_iter().enumerate() {
            if index >= MAX_CATALOGUE {
                return Err(Issue::Limit {
                    kind: Limit::Catalogue,
                    maximum: MAX_CATALOGUE,
                });
            }
            let id = &package.identity.id;
            if !valid_id(id) {
                // Do not copy an unbounded, invalid identifier into diagnostics.
                return Err(Issue::InvalidPackage {
                    id: String::new(),
                    field: PackageField::Id,
                });
            }
            if indexed.contains_key(id) {
                return Err(Issue::AmbiguousPackage { id: id.clone() });
            }
            indexed.insert(id.clone(), package);
        }
        Ok(Self { packages: indexed })
    }

    pub fn get(&self, id: &str, chain: &[String]) -> Result<&Package, Issue> {
        let package = self.packages.get(id).ok_or_else(|| Issue::Missing {
            id: id.into(),
            chain: chain.to_vec(),
        })?;
        let identity = &package.identity;
        let field = if identity.version.len() > MAX_RANGE_BYTES
            || normalized_version(&identity.version).is_none()
        {
            Some(PackageField::Version)
        } else if identity.fingerprint.len() != 64
            || !identity.fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
        {
            Some(PackageField::Fingerprint)
        } else {
            None
        };
        if let Some(field) = field {
            return Err(Issue::InvalidPackage {
                id: id.into(),
                field,
            });
        }
        Ok(package)
    }
}
