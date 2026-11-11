use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("editor.observe", ["editor.read"], "{tabId?:string,revision?:string}", "Observe ready buffer metadata only, with a bounded opaque conditional revision. Omit tabId for the active tab. Latest-state observation may coalesce changes; no disk IO or content. Experimental schemaVersion 1."),
    method!("editor.readRange", ["editor.read"], "{tabId:string,documentId:string,version:number,offset:number,limit?:number}", "Read a version-bound loaded buffer range. UTF-16 offsets, limit 2-16384 (default 16384), scalar boundaries only. Reject stale or unavailable buffers. No disk IO. Experimental schemaVersion 1."),
    method!("editor.applyEdits", ["editor.write"], "{tabId:string,documentId:string,version:number,edits:array}", "Apply at most 128 ascending nonoverlapping original-buffer edits in one undo step. Distinct starts, scalar boundaries, well-formed replacement text totaling at most 64KiB UTF-8; resulting buffer at most 2MiB. Exact identity/version required. Never saves. Experimental schemaVersion 1."),
    stable_method!("editor.active", ["editor.read"], "{}", "Read the active ready editor document or null. Returns tabId, documentId, version, path, name, content and dirty. Maximum UTF-8 content 128KiB. Does not read files from disk.", "0.29.0-beta.2"),
    stable_method!("editor.replace", ["editor.write"], "{tabId:string,documentId:string,version:number,text:string}", "Replace an open editor buffer only if the document identity and version still match. Maximum UTF-8 text 128KiB. Undoable; never saves automatically. Rejects stale, closed, loading or disconnected documents.", "0.29.0-beta.2"),
];
