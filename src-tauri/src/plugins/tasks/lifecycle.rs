//! Runtime-owned process observation and cooperative cancellation.
use super::*;
pub(in crate::plugins) fn owned_resources(plugin: &str, generation: u64) -> Vec<(String, bool)> {
    lock()
        .iter()
        .filter(|(_, t)| t.plugin == plugin && t.generation == generation && t.status == "running")
        .map(|(id, t)| (id.clone(), *t.cancel.borrow()))
        .collect()
}
pub(in crate::plugins) fn cancel_owned_resource(plugin: &str, generation: u64, id: &str) -> bool {
    let tasks = lock();
    let Some(task) = tasks
        .get(id)
        .filter(|t| t.plugin == plugin && t.generation == generation && t.status == "running")
    else {
        return false;
    };
    task.cancel.send_replace(true);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_current_running_tasks_are_visible_and_cancellation_preserves_running_ownership() {
        let plugin = uuid::Uuid::new_v4().to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let (input, _) = mpsc::channel(1);
        let (cancel, _) = watch::channel(false);
        lock().insert(
            id.clone(),
            Task {
                plugin: plugin.clone(),
                generation: 1,
                status: "running".into(),
                exit_code: None,
                error: None,
                seq: 0,
                bytes: 0,
                events: VecDeque::new(),
                input,
                cancel,
            },
        );
        assert!(owned_resources(&plugin, 2).is_empty());
        assert!(!cancel_owned_resource("foreign", 1, &id));
        assert!(!cancel_owned_resource(&plugin, 2, &id));
        assert_eq!(owned_resources(&plugin, 1), vec![(id.clone(), false)]);
        assert!(cancel_owned_resource(&plugin, 1, &id));
        assert_eq!(owned_resources(&plugin, 1), vec![(id.clone(), true)]);
        lock().get_mut(&id).unwrap().status = "cancelled".into();
        assert!(owned_resources(&plugin, 1).is_empty());
        assert!(!cancel_owned_resource(&plugin, 1, &id));
        lock().remove(&id);
    }
}
