use super::*;
#[tokio::test]
async fn shared_local_worker_creates_renames_and_removes_real_isolated_files() {
    let root = std::env::temp_dir().join(format!("tunnelde-file-page-{}", uuid::Uuid::new_v4()));
    let path = |name: &str| root.join(name).to_string_lossy().into_owned();
    let budget = Budget::new(1, ERRORS);
    local_operation(
        &budget,
        Operation::Mkdir {
            source: Source::Local {},
            path: root.to_string_lossy().into_owned(),
        },
    )
    .await
    .unwrap();
    local_operation(
        &budget,
        Operation::CreateFile {
            source: Source::Local {},
            path: path("before"),
        },
    )
    .await
    .unwrap();
    assert!(root.join("before").is_file());
    local_operation(
        &budget,
        Operation::Rename {
            source: Source::Local {},
            from: path("before"),
            to: path("after"),
            overwrite: false,
        },
    )
    .await
    .unwrap();
    assert!(!root.join("before").exists());
    assert!(root.join("after").is_file());
    local_operation(
        &budget,
        Operation::Remove {
            source: Source::Local {},
            path: root.to_string_lossy().into_owned(),
            is_dir: true,
        },
    )
    .await
    .unwrap();
    assert!(!root.exists());
}
struct Retired;
impl Authority for Retired {
    fn with_current(&self, _: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        Err(AppError::validation("retired-file-origin"))
    }
}
#[tokio::test]
async fn actual_local_worker_rechecks_retained_origin_before_filesystem_effect() {
    let root = std::env::temp_dir().join(format!(
        "tunnelde-file-page-denied-{}",
        uuid::Uuid::new_v4()
    ));
    let result = WorkLifetime::authorized(Arc::new(Retired))
        .scope(local_operation(
            &Budget::new(1, ERRORS),
            Operation::Mkdir {
                source: Source::Local {},
                path: root.to_string_lossy().into_owned(),
            },
        ))
        .await;
    assert_eq!(result.unwrap_err().to_string(), "retired-file-origin");
    assert!(!root.exists());
}
