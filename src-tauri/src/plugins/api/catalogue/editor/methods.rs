use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    stable_method!("editor.active", ["editor.read"], "{}", "Read the active ready editor document or null. Returns tabId, documentId, version, path, name, content and dirty. Maximum UTF-8 content 128KiB. Does not read files from disk.", "0.29.0-beta.2"),
    stable_method!("editor.replace", ["editor.write"], "{tabId:string,documentId:string,version:number,text:string}", "Replace an open editor buffer only if the document identity and version still match. Maximum UTF-8 text 128KiB. Undoable; never saves automatically. Rejects stale, closed, loading or disconnected documents.", "0.29.0-beta.2"),
];
