use super::*;
use crate::db::Database;
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

struct Runtime {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Runtime {
    fn start(node: &str, sdk: &str) -> Self {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/plugin-compat/bus/probe.mjs");
        let mut child = Command::new(node)
            .arg(fixture)
            .arg(sdk)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            _child: child,
        }
    }

    async fn send(&mut self, frame: Value) {
        self.input
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn read(&mut self) -> Value {
        let mut line = String::new();
        assert_ne!(self.output.read_line(&mut line).await.unwrap(), 0);
        serde_json::from_str(&line).unwrap()
    }

    async fn request(
        &mut self,
        bus: &Bus,
        security: &PluginSecurity,
        lease: &Lease,
        method: &str,
        params: Value,
    ) -> Value {
        self.send(json!({"jsonrpc":"2.0","id":999,"method":"command.run","params":{"command":"test","input":{"method":method,"params":params}}})).await;
        let request = self.read().await;
        assert_eq!(request["method"], method);
        assert_eq!(request["params"], params);
        let result = call(bus, security, lease, method, request["params"].clone()).await;
        let result = match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":request["id"],"result":value}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":error.to_string()}})
            }
        };
        self.send(result).await;
        let reply = self.read().await;
        assert_eq!(reply["id"], 999);
        reply["result"].clone()
    }
}

#[tokio::test]
#[ignore = "requires explicit TUNNELDE_TEST_NODE and TUNNELDE_TEST_CANCEL_SDK"]
async fn native_bus_exchanges_messages_between_live_sdk_processes() {
    let node = std::env::var("TUNNELDE_TEST_NODE").expect("explicit test Node");
    let sdk = std::env::var("TUNNELDE_TEST_CANCEL_SDK").expect("pinned SDK entry");
    tokio::time::timeout(Duration::from_secs(8), async {
        let bus = Bus::default();
        let security = PluginSecurity::default();
        let db = Database::in_memory().unwrap();
        let grant = |id: &str| {
            let declared = vec!["bus.communicate".to_owned()];
            let digest = "a".repeat(64);
            security.set_permissions(&db, id, digest.clone(), &declared, Some(declared.clone())).unwrap();
            security.lease(id, digest, declared).unwrap()
        };
        let a = grant("node-a");
        let b = grant("node-b");
        let mut left = Runtime::start(&node, &sdk);
        let mut right = Runtime::start(&node, &sdk);
        left.request(&bus, &security, &a, "bus.advertise", json!({"capability":"mounts","version":1})).await;
        assert_eq!(right.request(&bus, &security, &b, "bus.discover", json!({"capability":"mounts"})).await,
            json!([{"pluginId":"node-a","version":1}]));
        let channel = left.request(&bus, &security, &a, "bus.create", json!({})).await;
        let denied = right.request(&bus, &security, &b, "bus.subscribe", json!({"busId":channel,"topic":"progress"})).await;
        assert_eq!(denied["error"], "plugin.bus.unavailable");
        let forged = left.request(&bus, &security, &a, "bus.publish", json!({"busId":channel,"topic":"bus.membersChanged"})).await;
        assert_eq!(forged["error"], "plugin.bus.invalid");
        let invite = left.request(&bus, &security, &a, "bus.invite", json!({"busId":channel,"pluginId":"node-b"})).await;
        assert_eq!(right.request(&bus, &security, &b, "bus.snapshot", json!({})).await["channels"], json!([]));
        assert!(right.request(&bus, &security, &b, "bus.decline", json!({"invitationId":invite})).await.is_null());
        // The control message is a hint; a declined invitation is no longer actionable.
        assert_eq!(right.request(&bus, &security, &b, "bus.receive", json!({})).await["messages"][0]["topic"], "bus.invitation");
        let invite = left.request(&bus, &security, &a, "bus.invite", json!({"busId":channel,"pluginId":"node-b"})).await;
        left.request(&bus, &security, &a, "bus.subscribe", json!({"busId":channel,"topic":"bus.membersChanged"})).await;
        assert_eq!(right.request(&bus, &security, &b, "bus.join", json!({"invitationId":invite})).await, channel);
        assert_eq!(left.request(&bus, &security, &a, "bus.receive", json!({})).await["messages"][0]["topic"], "bus.membersChanged");
        assert_eq!(right.request(&bus, &security, &b, "bus.snapshot", json!({})).await["channels"][0]["members"], json!(["node-a","node-b"]));
        right.request(&bus, &security, &b, "bus.subscribe", json!({"busId":channel,"topic":"progress"})).await;
        assert_eq!(left.request(&bus, &security, &a, "bus.publish", json!({"busId":channel,"topic":"progress","payload":{"done":3}})).await, json!({"recipients":1}));
        let batch = right.request(&bus, &security, &b, "bus.receive", json!({})).await;
        assert_eq!(batch["lost"], 0);
        assert_eq!(batch["messages"][0]["topic"], "bus.invitation");
        assert_eq!(batch["messages"][1], json!({"busId":channel,"topic":"progress","sender":{"pluginId":"node-a","generation":a.generation},"payload":{"done":3}}));

        security.invalidate_runtime(&a.id);
        bus.retire_before(&a.id, a.generation + 1);
        let batch = right.request(&bus, &security, &b, "bus.receive", json!({})).await;
        assert_eq!(batch["messages"][0]["topic"], "bus.closed");
        assert_eq!(right.request(&bus, &security, &b, "bus.snapshot", json!({})).await["channels"], json!([]));
        let stale = left.request(&bus, &security, &a, "bus.advertise", json!({"capability":"mounts","version":1})).await;
        assert_eq!(stale["error"], "pluginSecurity.changed");
    }).await.unwrap();
}
