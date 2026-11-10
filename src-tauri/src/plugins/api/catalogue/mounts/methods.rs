use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("mounts.browse", ["mounts.read"], "{sessionId:string,path?:string}", "Browse directories through an authenticated SFTP session for the mount chooser."),
    method!("mounts.open", ["mounts.write"], "{id:string}", "Open this plugin's mount in the system file manager."),
    method!("mounts.documentation", ["mounts.read"], "{}", "Open platform SSHFS installation instructions in the system browser."),
    method!("mounts.dependencies", ["mounts.read"], "{}", "Detect SSHFS and FUSE compatibility; never install software or drivers."),
    method!("mounts.list", ["mounts.read"], "{}", "List this plugin's own SSHFS mounts."),
    method!("mounts.mount", ["mounts.write"], "{sessionId:string,remotePath:string,mountPoint:string,readOnly?:boolean}", "Mount using an authenticated SSH subsystem and the host's proxy/jump route. Defaults read-only."),
    method!("mounts.unmount", ["mounts.write"], "{id:string,force?:boolean}", "Unmount this plugin's own SSHFS filesystem; never terminate unrelated processes."),
];
