use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("fileList.setHighlights", ["fileBrowser.read", "workspace.write"], "{id:string,priority?:number,source?:string,directory?:string,highlights:{match:{name?:string,extension?:string,pathPrefix?:string},tooltip?:string,tone?:neutral|info|success|warning|error}[]}", "Replace a runtime-owned file-list highlight collection. Exactly one plain-name, extension or path-prefix matcher is required per highlight; source is local, an active remote session ID (optionally remote:<id>), or empty for all sources; optional directory scopes rules to one listing path. Colors are semantic and rendered by the host. At most 256 rules and 256KiB per collection, 8 collections per plugin and 128 total. Empty highlights clears the collection. Removed on stop, crash, revocation or restart; never modifies files."),
    method!("fileList.removeHighlights", ["fileBrowser.read", "workspace.write"], "{id:string}", "Remove only this plugin runtime's file-list highlight collection; returns false if absent."),
];
