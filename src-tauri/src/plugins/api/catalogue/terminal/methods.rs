use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("terminal.write", ["ssh.exec"], "{sessionId:string,data:string}", "Write plain UTF-8 terminal input, including remote shell commands; the host handles transport encoding."),
    method!("terminal.resize", ["ssh.exec"], "{sessionId:string,cols:number,rows:number}", "Resize the remote terminal through the validated session service."),
];
