use super::{denied, invalid, limit, Peer};
use crate::error::AppResult;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Notify, Semaphore};

const PUBLIC: &str = "public";
const DISCOVERY: &str = "bus.discovery";
const INVITATION: &str = "bus.invitation";
const CLOSED: &str = "bus.closed";
const QUEUE: usize = 128;

pub(super) struct Signal {
    pub(super) ready: Notify,
    pub(super) receiver: Semaphore,
}

impl Default for Signal {
    fn default() -> Self {
        Self {
            ready: Notify::new(),
            receiver: Semaphore::new(1),
        }
    }
}

#[derive(Default)]
struct Inbox {
    signal: Arc<Signal>,
    topics: HashSet<(String, String)>,
    capabilities: HashMap<String, u32>,
    messages: VecDeque<Arc<Message>>,
    lost: u32,
    sent: Option<(Instant, u32)>,
}

struct Message {
    sender: Option<Peer>,
    bus_id: String,
    body: Value,
}

struct Channel {
    owner: Peer,
    members: HashSet<Peer>,
}

struct Invitation {
    bus_id: String,
    peer: Peer,
    deadline: Instant,
}

#[derive(Default)]
pub(super) struct Book {
    peers: HashMap<Peer, Inbox>,
    channels: HashMap<String, Channel>,
    invitations: HashMap<String, Invitation>,
}

impl Book {
    fn charge(inbox: &mut Inbox, burst: u32) -> AppResult<()> {
        let now = Instant::now();
        let sent = inbox.sent.get_or_insert((now, 0));
        if now.duration_since(sent.0) >= Duration::from_secs(1) {
            *sent = (now, 0);
        }
        if sent.1 >= burst {
            return Err(limit());
        }
        sent.1 += 1;
        Ok(())
    }

    fn inbox(&mut self, peer: &Peer) -> AppResult<&mut Inbox> {
        if self.peers.len() >= 128 && !self.peers.contains_key(peer) {
            return Err(limit());
        }
        Ok(self.peers.entry(peer.clone()).or_default())
    }

    pub(super) fn signal(&mut self, peer: &Peer) -> AppResult<Arc<Signal>> {
        Ok(self.inbox(peer)?.signal.clone())
    }

    pub(super) fn drain(&mut self, peer: &Peer) -> AppResult<Value> {
        let inbox = self.peers.get_mut(peer).ok_or_else(denied)?;
        let count = inbox.messages.len().min(32);
        Ok(json!({
            "messages": inbox.messages.drain(..count).map(|m| m.body.clone()).collect::<Vec<_>>(),
            "lost": std::mem::take(&mut inbox.lost),
        }))
    }

    fn push(inbox: &mut Inbox, message: Arc<Message>) {
        if inbox.messages.len() == QUEUE {
            inbox.messages.pop_front();
            inbox.lost = inbox.lost.saturating_add(1);
        }
        inbox.messages.push_back(message);
        inbox.signal.ready.notify_one();
    }

    fn broadcast(
        &mut self,
        message: Message,
        topic: String,
        members: Option<&HashSet<Peer>>,
    ) -> usize {
        let key = (message.bus_id.clone(), topic);
        let message = Arc::new(message);
        let mut count = 0;
        let mut deliver = |inbox: &mut Inbox| {
            if inbox.topics.contains(&key) {
                Self::push(inbox, message.clone());
                count += 1;
            }
        };
        if let Some(members) = members {
            for peer in members {
                if let Some(inbox) = self.peers.get_mut(peer) {
                    deliver(inbox);
                }
            }
        } else {
            self.peers.values_mut().for_each(deliver);
        }
        count
    }

    fn control(topic: &str, payload: Value) -> Message {
        Message {
            sender: None,
            bus_id: PUBLIC.into(),
            body: json!({"busId":PUBLIC,"topic":topic,"sender":null,"payload":payload}),
        }
    }

    pub(super) fn advertise(
        &mut self,
        peer: &Peer,
        capability: String,
        version: Option<u32>,
    ) -> AppResult<()> {
        let inbox = self.inbox(peer)?;
        Self::charge(inbox, 64)?;
        let before = if let Some(version) = version {
            if version == 0 {
                return Err(invalid());
            }
            if inbox.capabilities.len() >= 8 && !inbox.capabilities.contains_key(&capability) {
                return Err(limit());
            }
            inbox.capabilities.insert(capability.clone(), version)
        } else {
            inbox.capabilities.remove(&capability)
        };
        if before != version {
            self.discovery_changed(peer, &capability, version);
        }
        Ok(())
    }

    fn discovery_changed(&mut self, peer: &Peer, capability: &str, version: Option<u32>) {
        self.broadcast(
            Self::control(
                DISCOVERY,
                json!({"capability":capability,"pluginId":peer.id,"version":version}),
            ),
            DISCOVERY.into(),
            None,
        );
    }

    pub(super) fn discover(&mut self, peer: &Peer, capability: &str) -> AppResult<Value> {
        self.inbox(peer)?;
        let mut items: Vec<_> = self
            .peers
            .iter()
            .filter_map(|(peer, inbox)| inbox.capabilities.get(capability).map(|v| (&peer.id, v)))
            .collect();
        items.sort_unstable_by(|a, b| a.0.cmp(b.0));
        Ok(Value::Array(
            items
                .into_iter()
                .map(|(id, version)| json!({"pluginId":id,"version":version}))
                .collect(),
        ))
    }

    pub(super) fn create(&mut self, owner: &Peer) -> AppResult<String> {
        self.inbox(owner)?;
        if self.channels.len() >= 64
            || self.channels.values().filter(|c| &c.owner == owner).count() >= 4
        {
            return Err(limit());
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.channels.insert(
            id.clone(),
            Channel {
                owner: owner.clone(),
                members: HashSet::from([owner.clone()]),
            },
        );
        Ok(id)
    }

    fn prune_invitations(&mut self) {
        let now = Instant::now();
        self.invitations
            .retain(|_, invitation| invitation.deadline > now);
    }

    pub(super) fn invite(
        &mut self,
        owner: &Peer,
        bus_id: &str,
        plugin_id: &str,
    ) -> AppResult<String> {
        self.prune_invitations();
        let channel = self
            .channels
            .get(bus_id)
            .filter(|c| &c.owner == owner)
            .ok_or_else(denied)?;
        let peer = self
            .peers
            .keys()
            .filter(|p| p.id == plugin_id)
            .max_by_key(|p| p.generation)
            .filter(|p| !channel.members.contains(*p))
            .cloned()
            .ok_or_else(denied)?;
        if let Some((id, _)) = self
            .invitations
            .iter()
            .find(|(_, invitation)| invitation.peer == peer && invitation.bus_id == bus_id)
        {
            return Ok(id.clone());
        }
        if self.invitations.len() >= 256
            || self
                .invitations
                .values()
                .filter(|i| i.peer == peer || i.bus_id == bus_id)
                .count()
                >= 16
        {
            return Err(limit());
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.invitations.insert(
            id.clone(),
            Invitation {
                bus_id: bus_id.into(),
                peer: peer.clone(),
                deadline: Instant::now() + Duration::from_secs(60),
            },
        );
        let message = Self::control(
            INVITATION,
            json!({"invitationId":id,"fromPluginId":owner.id}),
        );
        let inbox = self.peers.get_mut(&peer).ok_or_else(denied)?;
        Self::push(inbox, Arc::new(message));
        Ok(id)
    }

    pub(super) fn invitations(&mut self, peer: &Peer) -> AppResult<Value> {
        self.inbox(peer)?;
        self.prune_invitations();
        Ok(Value::Array(
            self.invitations
                .iter()
                .filter(|(_, i)| &i.peer == peer)
                .filter_map(|(id, i)| {
                    self.channels
                        .get(&i.bus_id)
                        .map(|channel| json!({"invitationId":id,"fromPluginId":channel.owner.id}))
                })
                .collect(),
        ))
    }

    pub(super) fn join(&mut self, peer: &Peer, invitation_id: &str) -> AppResult<String> {
        self.prune_invitations();
        let invitation = self
            .invitations
            .get(invitation_id)
            .filter(|i| &i.peer == peer)
            .ok_or_else(denied)?;
        let channel = self
            .channels
            .get_mut(&invitation.bus_id)
            .ok_or_else(denied)?;
        if channel.members.len() >= 16 {
            return Err(limit());
        }
        channel.members.insert(peer.clone());
        let id = invitation.bus_id.clone();
        self.invitations.remove(invitation_id);
        Ok(id)
    }

    fn remove_private(inbox: &mut Inbox, id: &str) {
        inbox.topics.retain(|(bus, _)| bus != id);
        inbox.messages.retain(|m| m.bus_id != id);
    }

    fn close(&mut self, id: &str) {
        if let Some(channel) = self.channels.remove(id) {
            self.invitations.retain(|_, i| i.bus_id != id);
            for member in channel.members {
                if let Some(inbox) = self.peers.get_mut(&member) {
                    Self::remove_private(inbox, id);
                    Self::push(inbox, Arc::new(Self::control(CLOSED, json!({"busId":id}))));
                }
            }
        }
    }

    pub(super) fn leave(&mut self, peer: &Peer, id: &str, owner_only: bool) -> AppResult<()> {
        let channel = self
            .channels
            .get_mut(id)
            .filter(|c| c.members.contains(peer))
            .ok_or_else(denied)?;
        if &channel.owner == peer {
            self.close(id);
        } else if owner_only {
            return Err(denied());
        } else {
            channel.members.remove(peer);
            if let Some(inbox) = self.peers.get_mut(peer) {
                Self::remove_private(inbox, id);
            }
        }
        Ok(())
    }

    pub(super) fn subscribe(
        &mut self,
        peer: &Peer,
        id: Option<&str>,
        topic: String,
        enable: bool,
    ) -> AppResult<()> {
        let id = id.unwrap_or(PUBLIC);
        if id != PUBLIC
            && !self
                .channels
                .get(id)
                .is_some_and(|c| c.members.contains(peer))
        {
            return Err(denied());
        }
        let inbox = self.inbox(peer)?;
        let key = (id.into(), topic);
        if enable {
            if inbox.topics.len() >= 32 && !inbox.topics.contains(&key) {
                return Err(limit());
            }
            inbox.topics.insert(key);
        } else {
            inbox.topics.remove(&key);
        }
        Ok(())
    }

    pub(super) fn publish(
        &mut self,
        peer: &Peer,
        id: Option<&str>,
        topic: String,
        payload: Value,
    ) -> AppResult<usize> {
        let id = id.unwrap_or(PUBLIC);
        let members = if id == PUBLIC {
            None
        } else {
            Some(
                self.channels
                    .get(id)
                    .filter(|c| c.members.contains(peer))
                    .ok_or_else(denied)?
                    .members
                    .clone(),
            )
        };
        let inbox = self.inbox(peer)?;
        Self::charge(inbox, if id == PUBLIC { 64 } else { 256 })?;
        let body = json!({"busId":id,"topic":topic,"sender":{"pluginId":peer.id,"generation":peer.generation},"payload":payload});
        Ok(self.broadcast(
            Message {
                sender: Some(peer.clone()),
                bus_id: id.into(),
                body,
            },
            topic,
            members.as_ref(),
        ))
    }

    pub(super) fn retire_before(&mut self, id: &str, boundary: u64) {
        let retired = |p: &Peer| p.id == id && p.generation < boundary;
        let peers: Vec<_> = self.peers.keys().filter(|p| retired(p)).cloned().collect();
        for peer in peers {
            if let Some(inbox) = self.peers.remove(&peer) {
                for capability in inbox.capabilities.keys() {
                    self.discovery_changed(&peer, capability, None);
                }
                inbox.signal.ready.notify_one();
            }
        }
        let closed: Vec<_> = self
            .channels
            .iter()
            .filter(|(_, c)| retired(&c.owner))
            .map(|(id, _)| id.clone())
            .collect();
        for id in closed {
            self.close(&id);
        }
        self.channels
            .values_mut()
            .for_each(|c| c.members.retain(|p| !retired(p)));
        self.invitations.retain(|_, i| !retired(&i.peer));
        for inbox in self.peers.values_mut() {
            inbox
                .messages
                .retain(|m| m.sender.as_ref().is_none_or(|p| !retired(p)));
        }
    }
}

#[cfg(test)]
mod tests;
