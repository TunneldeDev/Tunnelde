use super::*;
use serde_json::json;
use std::time::Instant;
fn metadata(window: &str, visible: bool) -> LayoutMetadata {
    serde_json::from_value(json!({"presentation":"workspace","visible":visible,"pinned":true,"bounds":null,"available":true,"presentations":if window==MAIN {vec!["sidebar","workspace","floating"]}else{vec!["workspace","floating"]}})).unwrap()
}
#[test]
fn closed_schema_rejects_secrets_invalid_geometry_and_unsupported_vocabularies() {
    let good = serde_json::to_value(metadata(MAIN, true)).unwrap();
    for (key, value) in [
        ("draft", json!("secret")),
        ("token", json!("bearer")),
        ("visible", json!("true")),
        ("presentation", json!("webview")),
    ] {
        let mut value2 = good.clone();
        value2[key] = value;
        assert!(serde_json::from_value::<LayoutMetadata>(value2).is_err());
    }
    for rect in [
        Bounds {
            x: f64::NAN,
            y: 0.,
            width: 300.,
            height: 200.,
        },
        Bounds {
            x: 0.,
            y: 0.,
            width: -1.,
            height: 200.,
        },
        Bounds {
            x: 0.,
            y: 0.,
            width: f64::INFINITY,
            height: 200.,
        },
        Bounds {
            x: 20_000_000.,
            y: 0.,
            width: 300.,
            height: 200.,
        },
    ] {
        let mut m = metadata(MAIN, true);
        m.bounds = Some(rect);
        assert!(m.validate(MAIN).is_err());
    }
    let mut m = metadata(MAIN, true);
    assert!(m.validate("satellite").is_err());
    m.presentations = vec![Presentation::Workspace, Presentation::Workspace];
    assert!(m.validate(MAIN).is_err());
    m.presentations = vec![];
    assert!(m.validate(MAIN).is_err());
    m = metadata(MAIN, true);
    m.available = false;
    assert!(m.validate(MAIN).is_err());
}
#[test]
fn only_exact_owner_publishes_and_staged_target_metadata_moves_with_commit() {
    let mut o = Ownership::default();
    let main = o.register(MAIN).unwrap();
    let target = o.register("target").unwrap();
    o.ready(MAIN, &main).unwrap();
    o.ready("target", &target).unwrap();
    let lease = o.add_panel(MAIN, &main, "tasks").unwrap();
    assert!(o
        .publish_presentation("target", &target, &lease, metadata("target", true))
        .is_err());
    assert!(o
        .publish_presentation(MAIN, "old", &lease, metadata(MAIN, true))
        .is_err());
    assert!(o
        .publish_presentation(MAIN, &main, &lease, metadata(MAIN, true))
        .unwrap());
    assert!(!o
        .publish_presentation(MAIN, &main, &lease, metadata(MAIN, true))
        .unwrap());
    let now = Instant::now();
    let offer = o
        .prepare(
            MAIN,
            &main,
            &lease,
            "target",
            json!({"draft":"private-sentinel"}),
            now,
        )
        .unwrap();
    assert!(o
        .publish_staged_presentation(MAIN, &main, &offer.id, metadata(MAIN, false), now)
        .is_err());
    o.publish_staged_presentation("target", &target, &offer.id, metadata("target", false), now)
        .unwrap();
    assert_eq!(o.panel_metadata(&lease).unwrap()["visible"], true);
    o.acknowledge("target", &target, &offer.id, now).unwrap();
    let moved = o.commit(MAIN, &main, &offer.id, now).unwrap();
    let row = o.panel_metadata(&moved).unwrap();
    assert_eq!(row["windowId"], "target");
    assert_eq!(row["visible"], false);
    assert_eq!(row["presentations"], json!(["workspace", "floating"]));
    assert!(!row.to_string().contains("private-sentinel"));
    assert!(o
        .publish_presentation(MAIN, &main, &lease, metadata(MAIN, true))
        .is_err());
    o.register("target").unwrap();
    assert!(o.panel_metadata(&moved).is_err());
    assert!(o.presentation_projection().is_none());
}
#[test]
fn cancelled_staging_never_overwrites_source_or_leaks_into_later_offer() {
    let mut o = Ownership::default();
    let main = o.register(MAIN).unwrap();
    let target = o.register("target").unwrap();
    o.ready(MAIN, &main).unwrap();
    o.ready("target", &target).unwrap();
    let lease = o.add_panel(MAIN, &main, "tasks").unwrap();
    o.publish_presentation(MAIN, &main, &lease, metadata(MAIN, true))
        .unwrap();
    let now = Instant::now();
    let offer = o
        .prepare(MAIN, &main, &lease, "target", json!(null), now)
        .unwrap();
    o.publish_staged_presentation("target", &target, &offer.id, metadata("target", false), now)
        .unwrap();
    o.cancel("target", &target, &offer.id).unwrap();
    assert_eq!(o.panel_metadata(&lease).unwrap()["visible"], true);
    let second = o
        .prepare(MAIN, &main, &lease, "target", json!(null), now)
        .unwrap();
    o.acknowledge("target", &target, &second.id, now).unwrap();
    let moved = o.commit(MAIN, &main, &second.id, now).unwrap();
    assert!(o.panel_metadata(&moved).is_err());
}
#[test]
fn unavailable_preview_catalogue_is_main_document_scoped_and_never_shadows_live_preview() {
    let mut o = Ownership::default();
    let main = o.register(MAIN).unwrap();
    let target = o.register("target").unwrap();
    let mut absent = metadata(MAIN, false);
    absent.available = false;
    assert!(o
        .publish_unavailable_preview("target", &target, absent.clone())
        .is_err());
    assert!(o
        .publish_unavailable_preview(MAIN, &main, metadata(MAIN, true))
        .is_err());
    o.publish_unavailable_preview(MAIN, &main, absent).unwrap();
    assert_eq!(
        o.presentation_projection().unwrap()["panels"][0]["available"],
        false
    );
    let live = o.add_panel(MAIN, &main, "filePreview").unwrap();
    assert!(o.presentation_projection().is_none());
    o.publish_presentation(MAIN, &main, &live, metadata(MAIN, true))
        .unwrap();
    assert_eq!(
        o.presentation_projection().unwrap()["panels"][0]["available"],
        true
    );
    o.register(MAIN).unwrap();
    assert!(o.preview_placeholder.is_none());
    assert!(o.presentation_projection().is_none());
}
