use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportRequest {
    document: Document,
    revision: String,
    selected: Vec<String>,
    #[serde(default)]
    copies: bool,
    #[serde(default)]
    mount_points: HashMap<String, String>,
}
pub(crate) fn apply_at(conn: &Connection, request: ImportRequest) -> AppResult<Vec<Host>> {
    validate(&request.document)?;
    if request.selected.is_empty()
        || request.selected.len() > 500
        || request.mount_points.len() > 2048
    {
        return Err(invalid());
    }
    unique(request.selected.iter().map(String::as_str))?;
    let document = &request.document;
    let selected = dependencies(document, &request.selected)?;
    let preview = preview_at(conn, document.clone())?;
    if preview.revision != request.revision {
        return Err(changed());
    }
    if !request.copies
        && preview
            .entries
            .iter()
            .any(|h| h.conflict && selected.contains(&h.id))
    {
        return Err(AppError::validation("hostTransfer.conflict"));
    }
    // Every write is inside one transaction, including credential identity
    // stamps, proxy configuration, rules and their relationship remapping.
    crate::db::atomic(conn, |conn| {
        if revision(conn)? != request.revision {
            return Err(changed());
        }
        let host_ids: HashMap<_, _> = selected
            .iter()
            .map(|id| (id.clone(), String::new()))
            .collect();
        let mut mapped_hosts = host_ids;
        let mut folder_ids = HashSet::new();
        for host in document.hosts.iter().filter(|h| selected.contains(&h.id)) {
            let mut folder = host.group_id.as_deref();
            while let Some(id) = folder {
                folder_ids.insert(id);
                folder = document
                    .folders
                    .iter()
                    .find(|g| g.id == id)
                    .ok_or_else(invalid)?
                    .parent_id
                    .as_deref();
            }
        }
        let mut mapped_folders = HashMap::new();
        while mapped_folders.len() < folder_ids.len() {
            let previous = mapped_folders.len();
            for folder in document
                .folders
                .iter()
                .filter(|g| folder_ids.contains(g.id.as_str()))
            {
                if mapped_folders.contains_key(&folder.id)
                    || folder
                        .parent_id
                        .as_ref()
                        .is_some_and(|id| !mapped_folders.contains_key(id))
                {
                    continue;
                }
                let parent = folder
                    .parent_id
                    .as_ref()
                    .and_then(|id| mapped_folders.get(id))
                    .map(String::as_str);
                let group = db::hosts::create_group(conn, &folder.name, parent)?;
                mapped_folders.insert(folder.id.clone(), group.id);
            }
            if previous == mapped_folders.len() {
                return Err(invalid());
            }
        }
        let mut imported = Vec::new();
        for host in document.hosts.iter().filter(|h| selected.contains(&h.id)) {
            let input = host.input(
                host.group_id
                    .as_ref()
                    .and_then(|id| mapped_folders.get(id))
                    .cloned(),
            );
            let mut draft = input.validate()?;
            if preview
                .entries
                .iter()
                .any(|h| h.id == host.id && h.conflict)
            {
                draft.name = format!("{} (copy)", draft.name.chars().take(73).collect::<String>());
            }
            let created = db::hosts::create_host(conn, &draft)?;
            mapped_hosts.insert(host.id.clone(), created.id.clone());
            imported.push(created);
        }
        let mut settings = db::settings::load_checked(conn)?;
        let mut mapped_proxies = HashMap::new();
        for proxy in &document.proxies {
            if !document
                .hosts
                .iter()
                .any(|h| selected.contains(&h.id) && h.route.proxy == proxy.id)
            {
                continue;
            }
            let mut proxy = proxy.clone();
            let old = proxy.id.clone();
            proxy.id = uuid::Uuid::new_v4().to_string();
            mapped_proxies.insert(old, proxy.id.clone());
            settings.network.profiles.push(proxy);
        }
        settings.network.validate()?;
        db::settings::save(conn, &settings)?;
        for host in document.hosts.iter().filter(|h| selected.contains(&h.id)) {
            let route = ConnectionRoute {
                proxy: mapped_proxies
                    .get(&host.route.proxy)
                    .cloned()
                    .unwrap_or_else(|| host.route.proxy.clone()),
                jump_hosts: host
                    .route
                    .jump_hosts
                    .iter()
                    .map(|id| mapped_hosts.get(id).cloned().ok_or_else(invalid))
                    .collect::<AppResult<_>>()?,
            };
            crate::network::save_route_at(conn, &mapped_hosts[&host.id], &route)?;
        }
        let mut mapped_groups = HashMap::new();
        for group in document
            .forward_groups
            .iter()
            .filter(|g| selected.contains(&g.host_id))
        {
            let created = forwarding::groups::save_at(
                conn,
                None,
                &mapped_hosts[&group.host_id],
                &group.name,
                None,
            )?;
            mapped_groups.insert(group.id.clone(), created.id);
        }
        for forward in document
            .forwards
            .iter()
            .filter(|r| selected.contains(&r.rule.host_id))
        {
            let mut rule = forward.rule.clone();
            rule.id = uuid::Uuid::new_v4().to_string();
            rule.host_id = mapped_hosts[&rule.host_id].clone();
            let group = forward
                .group_id
                .as_ref()
                .and_then(|id| mapped_groups.get(id));
            forwarding::repository::import_at(
                conn,
                &rule,
                forward.automation,
                group.map(String::as_str),
            )?;
        }
        let mut mapped_mounts = HashMap::new();
        for group in document
            .mount_groups
            .iter()
            .filter(|g| selected.contains(&g.host_id))
        {
            let mut group = group.clone();
            let old = group.id.clone();
            group.id = uuid::Uuid::new_v4().to_string();
            group.host_id = mapped_hosts[&group.host_id].clone();
            mapped_mounts.insert(old, group.id.clone());
            mounts::repository::save(
                conn,
                mounts::contract::Save {
                    value: group,
                    expected_revision: None,
                },
            )?;
        }
        for rule in document
            .mount_rules
            .iter()
            .filter(|r| selected.contains(&r.host_id))
        {
            let mut rule = rule.clone();
            if let Some(path) = request.mount_points.get(&rule.id) {
                rule.mount_point = path.clone();
            }
            // Cross-platform paths are never guessed. The preview must supply a
            // valid destination mount point before any configuration is saved.
            mounts::contract::validate_rule(&rule)?;
            rule.id = uuid::Uuid::new_v4().to_string();
            rule.host_id = mapped_hosts[&rule.host_id].clone();
            rule.group_id = mapped_mounts[&rule.group_id].clone();
            mounts::repository::save(
                conn,
                mounts::contract::Save {
                    value: rule,
                    expected_revision: None,
                },
            )?;
        }
        Ok(imported)
    })
}
