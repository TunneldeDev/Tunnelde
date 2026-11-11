//! Domain mappings are private; neither internal names nor stores cross the API.
mod appearance;
mod editor;
mod files;
mod general;
mod monitoring;
mod network;
mod shortcuts;
mod terminal;
mod transfers;
mod updates;
mod workspace;

pub(super) struct Group {
    pub id: &'static str,
    pub fields: &'static [(&'static str, &'static str)],
    pub schema: &'static str,
}

pub(super) const GROUPS: &[Group] = &[
    Group {
        id: "general",
        fields: general::FIELDS,
        schema: include_str!("../schema/general.json"),
    },
    Group {
        id: "appearance",
        fields: appearance::FIELDS,
        schema: include_str!("../schema/appearance.json"),
    },
    Group {
        id: "workspace",
        fields: workspace::FIELDS,
        schema: include_str!("../schema/workspace.json"),
    },
    Group {
        id: "terminal",
        fields: terminal::FIELDS,
        schema: include_str!("../schema/terminal.json"),
    },
    Group {
        id: "files",
        fields: files::FIELDS,
        schema: include_str!("../schema/files.json"),
    },
    Group {
        id: "transfers",
        fields: transfers::FIELDS,
        schema: include_str!("../schema/transfers.json"),
    },
    Group {
        id: "editor",
        fields: editor::FIELDS,
        schema: include_str!("../schema/editor.json"),
    },
    Group {
        id: "monitoring",
        fields: monitoring::FIELDS,
        schema: include_str!("../schema/monitoring.json"),
    },
    Group {
        id: "shortcuts",
        fields: shortcuts::FIELDS,
        schema: include_str!("../schema/shortcuts.json"),
    },
    Group {
        id: "network",
        fields: network::FIELDS,
        schema: include_str!("../schema/network.json"),
    },
    Group {
        id: "updates",
        fields: updates::FIELDS,
        schema: include_str!("../schema/updates.json"),
    },
];
