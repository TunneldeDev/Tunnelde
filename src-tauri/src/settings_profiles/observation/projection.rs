//! Bounded private-row decoding; preference contents are never materialized here.
use super::contracts::Metadata;
use crate::error::{AppError, AppResult};
use serde::{
    de::{SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use std::{collections::HashSet, fmt};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    id: String,
    name: String,
    updated_at: i64,
    #[serde(rename = "settings")]
    _settings: serde::de::IgnoredAny,
}

struct Items(Vec<Stored>);
impl<'de> Deserialize<'de> for Items {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Bounded;
        impl<'de> Visitor<'de> for Bounded {
            type Value = Items;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("bounded profile metadata")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<Stored>()? {
                    if items.len() >= super::super::MAX_PROFILES {
                        return Err(serde::de::Error::custom("profile metadata limit"));
                    }
                    items.push(item);
                }
                Ok(Items(items))
            }
        }
        deserializer.deserialize_seq(Bounded)
    }
}

pub(super) fn items(raw: &str) -> AppResult<Vec<Metadata>> {
    let invalid = || AppError::validation("profiles.invalidStorage");
    let Items(items) = serde_json::from_str::<Items>(raw).map_err(|_| invalid())?;
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    items
        .into_iter()
        .map(|item| {
            if item.id.is_empty()
                || item.id.len() > 128
                || item.id.chars().any(char::is_control)
                || !ids.insert(item.id.clone())
                || super::super::validate_name(&item.name).ok().as_ref() != Some(&item.name)
                || !names.insert(item.name.to_lowercase())
                || !(0..=9_007_199_254_740_991).contains(&item.updated_at)
            {
                return Err(invalid());
            }
            Ok(Metadata {
                id: item.id,
                name: item.name,
                updated_at: item.updated_at,
            })
        })
        .collect()
}
