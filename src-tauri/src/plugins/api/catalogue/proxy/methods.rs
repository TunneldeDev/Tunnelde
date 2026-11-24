use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("proxy.routes.saveForHost", ["proxy.write"], "{route:{id:string,hostId:string,name:string,mode:group|dedicated,matchHost:string,matchPort?:number,targetHost:string,targetPort:number,bindHost?:string,bindPort?:number},expectedRevision?:string}", "Create or update a SOCKS5 route for a host, creating the host default proxy group when necessary. Group routes share the group listener; dedicated routes bind their own local IP and port."),
    method!("proxy.groups.list", ["proxy.read"], "{hostId?:string}", "Read revisioned SOCKS5 proxy groups. Password verifiers and salts are never returned."),
    method!("proxy.groups.save", ["proxy.write"], "{group:ProxyGroupInput,expectedRevision?:string}", "Create or update a host-owned SOCKS5 group. Non-loopback group listeners and dedicated route listeners require username/password authentication."),
    method!("proxy.groups.remove", ["proxy.write"], "{id:string,expectedRevision:string}", "Remove an empty, stopped proxy group."),
    method!("proxy.routes.list", ["proxy.read"], "{groupId?:string}", "Read revisioned proxy routes in match-priority display order."),
    method!("proxy.routes.save", ["proxy.write"], "{route:ProxyRoute,expectedRevision?:string}", "Create or update a proxy route. Dedicated routes own a separate local TCP listener; non-loopback dedicated binds require an authenticated group."),
    method!("proxy.routes.remove", ["proxy.write"], "{id:string,expectedRevision:string}", "Remove a route from a stopped group."),
    method!("proxy.runtime.list", ["proxy.read"], "{}", "Read active proxy groups, local SOCKS5 endpoints and connection counts."),
    method!("proxy.runtime.start", ["proxy.write"], "{groupId:string,expectedRevision?:string}", "Start a group listener and its dedicated-route listeners over one host-owned SSH transport."),
    method!("proxy.runtime.stop", ["proxy.write"], "{groupId:string,expectedRevision?:string,runtimeId?:string}", "Stop listeners, live connections and the group SSH transport."),
    method!("proxy.connections.list", ["proxy.read"], "{groupId?:string}", "Read bounded live connection metadata with byte counts and status."),
    method!("proxy.connections.close", ["proxy.write"], "{id:string}", "Close one live proxied connection."),
    method!("proxy.tun.attach", ["proxy.tun"], "{groupId:string}", "Return a current local SOCKS5 endpoint, one-time credentials and a route snapshot for a TUN adapter. SSH handles and stored credentials are never returned."),
];
