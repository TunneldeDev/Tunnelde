use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Renderer {
    Image,
    Audio,
    Video,
    Pdf,
    Markdown,
    Text,
}

impl Renderer {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Image => "application/octet-stream",
            Self::Audio => "audio/mpeg",
            Self::Video => "video/mp4",
            Self::Pdf => "application/pdf",
            Self::Markdown | Self::Text => "text/plain; charset=utf-8",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub renderer: Renderer,
    pub extensions: Vec<String>,
}

pub fn valid(providers: &[Provider]) -> bool {
    let mut ids = HashSet::new();
    providers.len() <= 16
        && providers.iter().all(|provider| {
            let mut extensions = HashSet::new();
            crate::plugins::manifest::valid_id(&provider.id)
                && ids.insert(&provider.id)
                && !provider.name.trim().is_empty()
                && provider.name.len() <= 120
                && !provider.name.chars().any(char::is_control)
                && !provider.extensions.is_empty()
                && provider.extensions.len() <= 128
                && provider.extensions.iter().all(|extension| {
                    !extension.is_empty()
                        && extension.len() <= 64
                        && extension
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'+' | b'-'))
                        && !extension.starts_with('.')
                        && !extension.ends_with('.')
                        && extensions.insert(extension.to_ascii_lowercase())
                })
        })
}

impl Provider {
    pub fn matches(&self, path: &str) -> bool {
        let name = path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(path)
            .to_ascii_lowercase();
        self.extensions.iter().any(|extension| {
            name.strip_suffix(&extension.to_ascii_lowercase())
                .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
        })
    }

    pub fn mime(&self, path: &str) -> &'static str {
        let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        match (self.renderer, extension.as_str()) {
            (Renderer::Image, "png") => "image/png",
            (Renderer::Image, "jpg" | "jpeg") => "image/jpeg",
            (Renderer::Image, "gif") => "image/gif",
            (Renderer::Image, "webp") => "image/webp",
            (Renderer::Image, "avif") => "image/avif",
            (Renderer::Image, "bmp") => "image/bmp",
            (Renderer::Image, "ico") => "image/x-icon",
            (Renderer::Audio, "ogg" | "opus") => "audio/ogg",
            (Renderer::Audio, "wav") => "audio/wav",
            (Renderer::Audio, "flac") => "audio/flac",
            (Renderer::Audio, "m4a") => "audio/mp4",
            (Renderer::Video, "webm") => "video/webm",
            (Renderer::Video, "mov") => "video/quicktime",
            _ => self.renderer.mime(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn providers_only_select_host_renderers_and_bounded_suffixes() {
        let value =
            json!({"id":"images","name":"Images","renderer":"image","extensions":["png","jpg"]});
        let provider: Provider = serde_json::from_value(value.clone()).unwrap();
        assert!(valid(std::slice::from_ref(&provider)));
        assert!(provider.matches("/home/a.PnG"));
        assert!(!provider.matches("/home/png"));
        assert!(!provider.matches("/home/.png"));
        assert_eq!(provider.mime("test.jpg"), "image/jpeg");
        for change in [
            json!({"renderer":"html"}),
            json!({"url":"https://example.com"}),
            json!({"extensions":["PNG","png"]}),
            json!({"extensions":["../png"]}),
        ] {
            let mut bad = value.clone();
            bad.as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(!serde_json::from_value::<Provider>(bad).is_ok_and(|p| valid(&[p])));
        }
    }
}
