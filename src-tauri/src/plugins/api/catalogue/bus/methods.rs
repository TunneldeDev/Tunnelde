use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("bus.advertise", ["bus.communicate"], "{capability:string,version?:number}", "Advertise an online runtime capability and its positive protocol version. Omit version to withdraw."),
    method!("bus.discover", ["bus.communicate"], "{capability:string}", "Read online providers of a capability as {pluginId,version} entries."),
    method!("bus.create", ["bus.communicate"], "{}", "Create a runtime-owned private bus and return its opaque ID."),
    method!("bus.invite", ["bus.communicate"], "{busId:string,pluginId:string}", "Invite a currently registered runtime to an owner-controlled bus for sixty seconds. Return an invitation ID."),
    method!("bus.invitations", ["bus.communicate"], "{}", "List pending {invitationId,fromPluginId} entries for the caller's runtime."),
    method!("bus.snapshot", ["bus.communicate"], "{}", "Read the calling runtime's {publicTopics,channels:[{busId,ownerPluginId,members,topics}]} snapshot. Members are plugin IDs; topics are the caller's subscriptions."),
    method!("bus.decline", ["bus.communicate"], "{invitationId:string}", "Consume a pending invitation for the calling runtime without joining its channel."),
    method!("bus.join", ["bus.communicate"], "{invitationId:string}", "Accept and consume an invitation bound to the caller's runtime. Return the private bus ID."),
    method!("bus.leave", ["bus.communicate"], "{busId:string}", "Leave a private bus and discard its pending messages for the caller. Owner departure closes the bus."),
    method!("bus.close", ["bus.communicate"], "{busId:string}", "Close an owned private bus and discard pending private traffic."),
    method!("bus.subscribe", ["bus.communicate"], "{busId?:string,topic:string}", "Subscribe the calling runtime to an exact topic. The bus defaults to public."),
    method!("bus.unsubscribe", ["bus.communicate"], "{busId?:string,topic:string}", "Stop enqueueing new messages for an exact runtime topic."),
    method!("bus.publish", ["bus.communicate"], "{busId?:string,topic:string,payload?:JSON}", "Enqueue a message to matching subscribers and return {recipients}. Payload limit is 16 KiB; bus.* topics are reserved."),
    method!("bus.receive", ["bus.communicate"], "{}", "Wait up to fifteen seconds for a batch of up to 32 {busId,topic,sender,payload} messages and a lost-count. Only one outstanding read per runtime."),
];
