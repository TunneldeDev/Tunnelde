use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::Path;

/// Data-only views never evaluate JavaScript and never resolve a Node runtime.
pub fn render(dir: &Path, entry: &str, view: &str) -> AppResult<Value> {
    let path = super::manifest::entry_path(dir, entry)?;
    let file = std::fs::File::open(path)?;
    use std::io::Read;
    let mut raw = String::new();
    file.take(256 * 1024 + 1).read_to_string(&mut raw)?;
    if raw.len() > 256 * 1024 {
        return Err(AppError::validation("plugin.resultTooLarge"));
    }
    let document: Value = serde_json::from_str(&raw)?;
    let value = document
        .get("views")
        .and_then(|views| views.get(view))
        .ok_or_else(|| AppError::NotFound("plugin.view.notFound".into()))?;
    Ok(value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renders_json_without_evaluating_scripts_and_refuses_escape() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-declarative-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("views.json"),
            r#"{"views":{"main":{"title":"Mounts","blocks":[{"type":"mounts"}]}}}"#,
        )
        .unwrap();
        assert_eq!(
            render(&root, "views.json", "main").unwrap()["blocks"][0]["type"],
            "mounts"
        );
        assert!(render(&root, "views.json", "missing").is_err());
        std::fs::write(
            root.join("evil.js"),
            "require('fs').writeFileSync('escaped', 'bad');",
        )
        .unwrap();
        assert!(render(&root, "evil.js", "main").is_err());
        let outside = root.with_extension("json");
        std::fs::write(&outside, r#"{"views":{"main":{}}}"#).unwrap();
        assert!(render(&root, outside.to_str().unwrap(), "main").is_err());
        std::fs::write(root.join("huge.json"), vec![b' '; 256 * 1024 + 1]).unwrap();
        assert!(render(&root, "huge.json", "main").is_err());
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
