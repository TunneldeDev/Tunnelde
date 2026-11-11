use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("fileBrowser.observe", ["fileBrowser.read"], "{offset?:number,limit?:number,revision?:string}", "Observe committed live file-browser metadata, including suspended views, with a query-bound conditional revision. Catalogue limit 1-32, default 16; pages at most 64KiB. No file contents or filesystem snapshot guarantee. Experimental schemaVersion 1."),
    method!("fileBrowser.read", ["fileBrowser.read"], "{paneId:string,revision:string,offset?:number,limit?:number}", "Read visible entries and selection flags from an exact live browser revision, in its filter/sort order. Limit 1-256, default 64; pages at most 64KiB. Does not read files or return an entire selection. Experimental schemaVersion 1."),
    method!("fileBrowser.action", ["fileBrowser.write"], "{paneId:string,revision:string,action:refresh|navigate|select|open,path?:string,paths?:string[],mode?:open|preview}", "Dispatch existing host browser behavior on an exact live revision. Selection at most 256 visible entries; open must target a visible entry. Suspended, busy and stale browsers reject actions. Returns {accepted:true}, not IO completion; observe subsequent state. Never replay actions automatically. No file contents, writes or private preview handles. Experimental schemaVersion 1."),
];
