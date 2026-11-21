use super::*;
#[test]
fn layout_revisions_are_stable_for_equal_metadata_and_invalidate_unready_projection() {
    let public = PublicPanels::default();
    assert_eq!(public.update(None), (None, None));
    let projection =
        json!({"windowId":"main","panels":[{"id":"tasks","windowId":"source","visible":true}]});
    let (first, revision) = public.update(Some(projection.clone()));
    let first = first.unwrap();
    assert!(revision.is_some());
    let (same, revision) = public.update(Some(projection.clone()));
    assert_eq!(same, Some(first.clone()));
    assert!(revision.is_none());
    let (empty, revision) = public.update(None);
    assert!(empty.is_none());
    assert!(revision.is_some());
    let (next, _) = public.update(Some(projection));
    assert_ne!(next.unwrap()["revision"], first["revision"]);
}
