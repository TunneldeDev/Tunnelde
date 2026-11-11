use super::ApiMethod;

pub const METHODS:&[ApiMethod]=&[
    method!("files.content.prepare",[],"{source:{kind:'local'}|{kind:'remote',sessionId:string},path:string}","Reserve a 20-second read-only descriptor without IO; returns a unique contentId before opening. Requires fs.read for local or sftp.read for remote, not both. At most 8 descriptors per plugin and 64 globally; ordinary plugins only, not scoped tools."),
    method!("files.content.open",[],"{contentId:string}","Open a prepared descriptor exactly once under its endpoint read permission. Pins a regular-file handle; returns size, chunkBytes and idle lease. Close known contentId on cancellation. Expiry and runtime retirement also reclaim ownership. Not an immutable file snapshot."),
    method!("files.content.read",[],"{contentId:string,offset:number,length:number}","Read up to 48KiB of binary bytes as base64 under the source read permission, with explicit safe-integer offset. Clamp at opened size; EOF and source mutations may fail. Successful admission renews a 60-second idle lease. Cancelled actual IO keeps its shared worker budget until settlement."),
    method!("files.content.close",[],"{contentId:string}","Idempotently retire an exact current-runtime descriptor before or after open. Cancels late installation and closes only its dedicated SFTP channel. Logical close does not forcibly stop running local or remote server IO; actual worker budgets remain charged."),
    method!("files.content.observe",[],"{contentId:string}","Observe this runtime's descriptor lifecycle without renewing its idle lease. Missing, foreign and expired IDs all appear closed; no paths, contents or credentials are returned. This observes handle lifetime, not filesystem change events."),
];
