//! Plugin-owned, bounded streaming processes. No executable is discovered or run implicitly.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::ChannelMsg;
use serde_json::{json, Value};
use tauri::Manager;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use super::api::{authorize, field, optional, HostContext};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

mod lifecycle;
pub(super) use lifecycle::{cancel_owned_resource, owned_resources};

const MAX_BUFFER: usize = 4 * 1024 * 1024;
const MAX_EVENTS: usize = 4096;
const MAX_TASKS: usize = 128;
const MAX_ACTIVE: usize = 8;

struct Task {
    plugin: String,
    generation: u64,
    status: String,
    exit_code: Option<i32>,
    error: Option<String>,
    seq: u64,
    bytes: usize,
    events: VecDeque<Value>,
    input: mpsc::Sender<Input>,
    cancel: watch::Sender<bool>,
}
enum Input {
    Write(String),
    Eof,
}
struct TaskInput {
    receiver: mpsc::Receiver<Input>,
    cancellation: watch::Receiver<bool>,
}
type Registry = Arc<Mutex<HashMap<String, Task>>>;
fn registry() -> &'static Registry {
    static TASKS: OnceLock<Registry> = OnceLock::new();
    TASKS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Task>> {
    registry().lock().unwrap_or_else(|e| e.into_inner())
}
fn owns(task: &Task, context: &HostContext) -> bool {
    task.plugin == context.id && task.generation == context.generation
}
fn snapshot(id: &str, task: &Task) -> Value {
    json!({"taskId":id,"status":task.status,"exitCode":task.exit_code,"error":task.error,"seq":task.seq})
}
fn output_snapshot(id: &str, task: &Task, after: u64) -> Value {
    let mut bytes = 0usize;
    let events: Vec<Value> = task
        .events
        .iter()
        .filter(|event| event["seq"].as_u64().is_some_and(|seq| seq > after))
        .take_while(|event| {
            bytes += event["data"].as_str().map_or(0, str::len);
            bytes <= 512 * 1024
        })
        .take(128)
        .cloned()
        .collect();
    let next = events
        .last()
        .and_then(|event| event["seq"].as_u64())
        .unwrap_or(after);
    json!({"taskId":id,"events":events,"nextSeq":next,"status":task.status,"exitCode":task.exit_code,"error":task.error,"truncated":task.events.front().and_then(|event| event["seq"].as_u64()).is_some_and(|first| after.saturating_add(1) < first)})
}
fn publish(
    context: &HostContext,
    id: &str,
    stream: &str,
    data: String,
    status: Option<&str>,
    exit_code: Option<i32>,
) {
    let payload = {
        let mut tasks = lock();
        let Some(task) = tasks.get_mut(id) else {
            return;
        };
        if let Some(status) = status {
            task.status = status.into();
            task.exit_code = exit_code;
        }
        task.seq += 1;
        let event = json!({"taskId":id,"seq":task.seq,"stream":stream,"data":data,"status":task.status,"exitCode":task.exit_code});
        task.bytes += data.len();
        task.events.push_back(event.clone());
        while task.bytes > MAX_BUFFER || task.events.len() > MAX_EVENTS {
            if let Some(old) = task.events.pop_front() {
                task.bytes = task
                    .bytes
                    .saturating_sub(old["data"].as_str().map_or(0, str::len));
            }
        }
        event
    };
    let _ = super::events::emit(context, "task", payload);
}

pub fn cancel_plugin(plugin: &str, generation: Option<u64>) {
    cancel_matching(plugin, |value| {
        generation.is_none_or(|generation| value == generation)
    });
}

pub(super) fn cancel_before_generation(plugin: &str, boundary: u64) {
    cancel_matching(plugin, |value| value < boundary);
}

fn cancel_matching(plugin: &str, generation: impl Fn(u64) -> bool) {
    for task in lock()
        .values()
        .filter(|task| task.plugin == plugin && generation(task.generation))
    {
        task.cancel.send_replace(true);
    }
}

pub async fn dispatch(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    if method == "tasks.start" {
        return start(context, params).await;
    }
    if method == "tasks.list" {
        return Ok(Value::Array(
            lock()
                .iter()
                .filter(|(_, task)| owns(task, context))
                .map(|(id, task)| snapshot(id, task))
                .collect(),
        ));
    }
    let id: String = field(&params, "taskId")?;
    let input = {
        let tasks = lock();
        let task = tasks
            .get(&id)
            .filter(|task| owns(task, context))
            .ok_or_else(|| AppError::validation("plugin.tasks.notFound"))?;
        match method {
            "tasks.status" => return Ok(snapshot(&id, task)),
            "tasks.cancel" => {
                task.cancel.send_replace(true);
                return Ok(json!(true));
            }
            "tasks.readOutput" => {
                let after = optional::<u64>(&params, "afterSeq")?.unwrap_or(0);
                return Ok(output_snapshot(&id, task, after));
            }
            _ => task.input.clone(),
        }
    };
    let command = match method {
        "tasks.closeInput" => Input::Eof,
        "tasks.write" => {
            let data: String = field(&params, "data")?;
            if data.len() > 128 * 1024 {
                return Err(AppError::validation("plugin.tasks.inputTooLarge"));
            }
            Input::Write(data)
        }
        _ => return Err(AppError::validation("plugin.api.unknownMethod")),
    };
    input
        .try_send(command)
        .map_err(|_| AppError::validation("plugin.tasks.notWritable"))?;
    Ok(json!(true))
}

fn validate(params: &Value) -> AppResult<(String, Vec<String>, Option<String>, u64)> {
    let executable: String = field(params, "executable")?;
    let args = optional::<Vec<String>>(params, "args")?.unwrap_or_default();
    let cwd: Option<String> = optional(params, "cwd")?;
    let timeout = optional::<u64>(params, "timeoutMs")?.unwrap_or(1_800_000);
    if executable.is_empty()
        || executable.len() > 4096
        || executable.contains('\0')
        || args.len() > 256
        || args
            .iter()
            .any(|arg| arg.len() > 128 * 1024 || arg.contains('\0'))
        || cwd
            .as_ref()
            .is_some_and(|cwd| cwd.is_empty() || cwd.len() > 4096 || cwd.contains('\0'))
        || !(100..=86_400_000).contains(&timeout)
    {
        return Err(AppError::validation("plugin.tasks.invalidStart"));
    }
    Ok((executable, args, cwd, timeout))
}

/// OpenSSH POSIX shells and Windows PowerShell use distinct quoting. Never concatenate raw arguments.
pub(super) fn remote_command(
    executable: &str,
    args: &[String],
    cwd: Option<&str>,
    platform: &str,
) -> AppResult<String> {
    crate::ssh::command::remote(executable, args, cwd, platform)
}

async fn start(context: &HostContext, params: Value) -> AppResult<Value> {
    let (executable, args, cwd, timeout) = validate(&params)?;
    let session: Option<String> = optional(&params, "sessionId")?;
    authorize(
        context,
        &[if session.is_some() {
            "ssh.exec"
        } else {
            "process.exec"
        }],
    )?;
    let (input, receiver) = mpsc::channel(64);
    let (cancel, cancellation) = watch::channel(false);
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut tasks = lock();
        if tasks
            .values()
            .filter(|task| task.plugin == context.id && task.status == "running")
            .count()
            >= MAX_ACTIVE
        {
            return Err(AppError::validation("plugin.tasks.busy"));
        }
        if tasks.len() >= MAX_TASKS {
            let expired = tasks
                .iter()
                .find(|(_, task)| task.status != "running")
                .map(|(id, _)| id.clone());
            if let Some(expired) = expired {
                tasks.remove(&expired);
            } else {
                return Err(AppError::validation("plugin.tasks.busy"));
            }
        }
        tasks.insert(
            id.clone(),
            Task {
                plugin: context.id.clone(),
                generation: context.generation,
                status: "running".into(),
                exit_code: None,
                error: None,
                seq: 0,
                bytes: 0,
                events: VecDeque::new(),
                input,
                cancel,
            },
        );
    }
    if !super::tools::register_resource(context, &id, false) {
        lock().remove(&id);
        return Err(AppError::validation("plugin.tools.cancelled"));
    }
    let context = context.clone();
    let task_id = id.clone();
    let input = TaskInput {
        receiver,
        cancellation,
    };
    tokio::spawn(async move {
        let result = if let Some(session) = session {
            let platform = optional::<String>(&params, "platform")
                .ok()
                .flatten()
                .unwrap_or_else(|| "posix".into());
            match remote_command(&executable, &args, cwd.as_deref(), &platform) {
                Ok(command) => {
                    run_remote(&context, &task_id, &session, command, timeout, input).await
                }
                Err(error) => Err(error),
            }
        } else {
            run_local(&context, &task_id, &executable, args, cwd, timeout, input).await
        };
        if let Err(error) = result {
            if let Some(task) = lock().get_mut(&task_id) {
                task.error = Some(error.to_string());
            }
            publish(
                &context,
                &task_id,
                "status",
                String::new(),
                Some("failed"),
                None,
            );
        }
    });
    Ok(json!({"taskId":id,"status":"running"}))
}

async fn read_chunks(
    reader: impl AsyncRead + Unpin,
    stream: &'static str,
    sender: mpsc::Sender<(&'static str, Vec<u8>)>,
) {
    let mut reader = reader;
    let mut chunk = vec![0; 16 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                if sender.send((stream, chunk[..size].to_vec())).await.is_err() {
                    break;
                }
            }
        }
    }
}

// Keep incomplete UTF-8 between reads, so streaming never corrupts multibyte text.
#[derive(Default)]
struct Decoder(Vec<u8>);
impl Decoder {
    fn push(&mut self, data: &[u8], final_chunk: bool) -> String {
        self.0.extend_from_slice(data);
        let mut end = 0;
        while end < self.0.len() {
            match std::str::from_utf8(&self.0[end..]) {
                Ok(_) => {
                    end = self.0.len();
                    break;
                }
                Err(error) => {
                    end += error.valid_up_to();
                    match error.error_len() {
                        Some(length) => end += length,
                        None if final_chunk => {
                            end = self.0.len();
                            break;
                        }
                        None => break,
                    }
                }
            }
        }
        let value = String::from_utf8_lossy(&self.0[..end]).into_owned();
        self.0.drain(..end);
        value
    }
}

async fn kill_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let executable = std::env::var_os("SystemRoot")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| "C:\\Windows".into())
                .join("System32/taskkill.exe");
            let mut command = Command::new(executable);
            command.creation_flags(0x08000000);
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                command
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .output(),
            )
            .await;
        }
        #[cfg(unix)]
        {
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                Command::new("/bin/kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .output(),
            )
            .await;
        }
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() || cancel.changed().await.is_err() {
            return;
        }
    }
}

async fn until_cancelled<T>(
    future: impl std::future::Future<Output = T>,
    cancel: &mut watch::Receiver<bool>,
) -> Option<T> {
    tokio::select! {
        biased;
        _ = cancelled(cancel) => None,
        result = future => Some(result),
    }
}

async fn forward_input(
    mut writer: impl AsyncWrite + Unpin,
    mut input: mpsc::Receiver<Input>,
) -> std::io::Result<()> {
    while let Some(command) = input.recv().await {
        match command {
            Input::Write(data) => writer.write_all(data.as_bytes()).await?,
            Input::Eof => return writer.shutdown().await,
        }
    }
    Ok(())
}

fn task_error(id: &str, error: impl ToString) {
    if let Some(task) = lock().get_mut(id) {
        task.error = Some(error.to_string());
    }
}

async fn run_local(
    context: &HostContext,
    id: &str,
    executable: &str,
    args: Vec<String>,
    cwd: Option<String>,
    timeout: u64,
    input: TaskInput,
) -> AppResult<()> {
    authorize(context, &["process.exec"])?;
    let TaskInput {
        receiver,
        mut cancellation,
    } = input;
    if *cancellation.borrow() {
        publish(
            context,
            id,
            "status",
            String::new(),
            Some("cancelled"),
            None,
        );
        return Ok(());
    }
    let mut command = Command::new(executable);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    command
        .args(args)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_REPL_EXTERNAL_MODULE")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    crate::network::process_environment(&context.app, &context.id, &mut command)?;
    let mut child = command.spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    let mut writer_cancel = cancellation.clone();
    let mut writer = tokio::spawn(async move {
        until_cancelled(forward_input(stdin, receiver), &mut writer_cancel).await
    });
    let mut input_ended = false;
    let (sender, mut output) = mpsc::channel(32);
    let stdout = tokio::spawn(read_chunks(
        child.stdout.take().expect("piped stdout"),
        "stdout",
        sender.clone(),
    ));
    let stderr = tokio::spawn(read_chunks(
        child.stderr.take().expect("piped stderr"),
        "stderr",
        sender.clone(),
    ));
    drop(sender);
    let deadline = tokio::time::sleep(Duration::from_millis(timeout));
    tokio::pin!(deadline);
    let mut decoders = [Decoder::default(), Decoder::default()];
    let mut interval = tokio::time::interval(Duration::from_millis(200));
    let mut status = None;
    let mut ended = false;
    let mut reason = "completed";
    loop {
        tokio::select! {
            chunk = output.recv(), if !ended => match chunk {
                Some((stream, chunk)) => { let data = decoders[usize::from(stream == "stderr")].push(&chunk, false); if !data.is_empty() { publish(context, id, stream, data, None, None); } }
                None => ended = true,
            },
            _ = cancelled(&mut cancellation) => { reason = "cancelled"; break; },
            result = &mut writer, if !input_ended => {
                input_ended = true;
                match result {
                    Ok(Some(Err(error))) if error.kind() != std::io::ErrorKind::BrokenPipe => {
                        task_error(id, error); reason = "failed"; break;
                    }
                    Err(error) => { task_error(id, error); reason = "failed"; break; }
                    _ => {}
                }
            },
            _ = &mut deadline => { reason = "timedOut"; break; },
            _ = interval.tick() => {
                if authorize(context, &["process.exec"]).is_err() { reason = "cancelled"; break; }
                if status.is_none() {
                    match child.try_wait() {
                        Ok(value) => status = value,
                        Err(error) => { task_error(id, error); reason = "failed"; break; }
                    }
                }
            }
        }
        if status.is_some() && ended {
            break;
        }
    }
    writer.abort();
    if reason != "completed" {
        kill_tree(&mut child).await;
    }
    stdout.abort();
    stderr.abort();
    for (index, decoder) in decoders.iter_mut().enumerate() {
        let data = decoder.push(&[], true);
        if !data.is_empty() {
            publish(
                context,
                id,
                if index == 0 { "stdout" } else { "stderr" },
                data,
                None,
                None,
            );
        }
    }
    publish(
        context,
        id,
        "status",
        String::new(),
        Some(reason),
        status.and_then(|status| status.code()),
    );
    Ok(())
}

async fn run_remote(
    context: &HostContext,
    id: &str,
    session: &str,
    command: String,
    timeout: u64,
    input: TaskInput,
) -> AppResult<()> {
    let TaskInput {
        mut receiver,
        mut cancellation,
    } = input;
    let expires = tokio::time::Instant::now() + Duration::from_millis(timeout);
    let handle = context.app.state::<AppState>().ssh.handle(session)?;
    let opened = until_cancelled(
        tokio::time::timeout_at(
            expires.min(tokio::time::Instant::now() + Duration::from_secs(10)),
            handle.channel_open_session(),
        ),
        &mut cancellation,
    )
    .await;
    let Some(opened) = opened else {
        publish(
            context,
            id,
            "status",
            String::new(),
            Some("cancelled"),
            None,
        );
        return Ok(());
    };
    let channel = opened
        .map_err(|_| AppError::validation("plugin.tasks.channelTimeout"))?
        .map_err(|e| AppError::Ssh(e.to_string()))?;
    let started = until_cancelled(
        async {
            authorize(context, &["ssh.exec"])?;
            tokio::time::timeout_at(expires, channel.exec(true, command))
                .await
                .map_err(|_| AppError::validation("plugin.tasks.channelTimeout"))?
                .map_err(|error| AppError::Ssh(error.to_string()))
        },
        &mut cancellation,
    )
    .await;
    if !matches!(started, Some(Ok(()))) {
        let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
        if let Some(Err(error)) = started {
            return Err(error);
        }
        publish(
            context,
            id,
            "status",
            String::new(),
            Some("cancelled"),
            None,
        );
        return Ok(());
    }
    let (mut channel, channel_writer) = channel.split();
    let channel_writer = Arc::new(channel_writer);
    let input_writer = channel_writer.clone();
    let mut writer_cancel = cancellation.clone();
    let mut writer = tokio::spawn(async move {
        until_cancelled(
            async {
                while let Some(command) = receiver.recv().await {
                    match command {
                        Input::Write(data) => input_writer.data(data.as_bytes()).await?,
                        Input::Eof => return input_writer.eof().await,
                    }
                }
                Ok::<(), russh::Error>(())
            },
            &mut writer_cancel,
        )
        .await
    });
    let mut input_ended = false;
    let mut interval = tokio::time::interval(Duration::from_millis(200));
    let deadline = tokio::time::sleep_until(expires);
    tokio::pin!(deadline);
    let mut exit = None;
    let mut reason = "completed";
    let mut decoders = [Decoder::default(), Decoder::default()];
    loop {
        tokio::select! {
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) => { let text = decoders[0].push(&data, false); if !text.is_empty() { publish(context, id, "stdout", text, None, None); } },
                Some(ChannelMsg::ExtendedData { data, .. }) => { let text = decoders[1].push(&data, false); if !text.is_empty() { publish(context, id, "stderr", text, None, None); } },
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = i32::try_from(exit_status).ok(),
                Some(ChannelMsg::Close) | None => {
                    if exit.is_none() {
                        reason = "failed";
                        task_error(id, "SSH channel closed without an exit status");
                    }
                    break;
                },
                _ => {}
            },
            _ = cancelled(&mut cancellation) => { reason = "cancelled"; break; },
            result = &mut writer, if !input_ended => {
                input_ended = true;
                match result {
                    Ok(Some(Err(error))) => { task_error(id, error); reason = "failed"; break; }
                    Err(error) => { task_error(id, error); reason = "failed"; break; }
                    _ => {}
                }
            },
            _ = interval.tick() => if authorize(context, &["ssh.exec"]).is_err() { reason = "cancelled"; break; },
            _ = &mut deadline => { reason = "timedOut"; break; }
        }
    }
    writer.abort();
    if reason != "completed" {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            channel_writer.signal(russh::Sig::KILL),
        )
        .await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), channel_writer.close()).await;
    for (index, decoder) in decoders.iter_mut().enumerate() {
        let data = decoder.push(&[], true);
        if !data.is_empty() {
            publish(
                context,
                id,
                if index == 0 { "stdout" } else { "stderr" },
                data,
                None,
                None,
            );
        }
    }
    publish(context, id, "status", String::new(), Some(reason), exit);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_keeps_failure_detail_after_the_last_event_is_drained() {
        let (input, _receiver) = mpsc::channel(1);
        let (cancel, _cancellation) = watch::channel(false);
        let task = Task {
            plugin: "owned-plugin".into(),
            generation: 1,
            status: "failed".into(),
            exit_code: None,
            error: Some("SSH channel closed without an exit status".into()),
            seq: 1,
            bytes: 0,
            events: VecDeque::from([json!({"seq":1,"stream":"status","data":""})]),
            input,
            cancel,
        };
        for after in [0, 1] {
            let output = output_snapshot("owned-task", &task, after);
            assert_eq!(output["error"], snapshot("owned-task", &task)["error"]);
            assert_eq!(output["status"], "failed");
            assert!(output["exitCode"].is_null());
            assert_eq!(output["nextSeq"], 1);
            assert_eq!(
                output["events"].as_array().unwrap().len(),
                usize::from(after == 0)
            );
        }
    }
    #[tokio::test]
    async fn blocked_stdin_and_full_queue_do_not_block_cancellation() {
        let (writer, _reader) = tokio::io::duplex(1);
        let (sender, receiver) = mpsc::channel(1);
        let (cancel, mut cancelled) = watch::channel(false);
        sender.send(Input::Write("blocked".into())).await.unwrap();
        let task = tokio::spawn(async move {
            until_cancelled(forward_input(writer, receiver), &mut cancelled).await
        });
        tokio::task::yield_now().await;
        sender.send(Input::Write("queued".into())).await.unwrap();
        assert!(sender.try_send(Input::Eof).is_err());
        cancel.send_replace(true);
        assert!(tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_none());
    }
    #[tokio::test]
    async fn revoked_before_start_never_polls_operation() {
        let (_sender, mut cancel) = watch::channel(true);
        let mut executed = false;
        let result = until_cancelled(
            async {
                executed = true;
            },
            &mut cancel,
        )
        .await;
        assert!(result.is_none());
        assert!(!executed);
    }
    #[test]
    fn utf8_survives_chunk_boundaries() {
        let mut decoder = Decoder::default();
        assert_eq!(decoder.push(&[0xe4, 0xbd], false), "");
        assert_eq!(decoder.push(&[0xa0, b'!'], false), "你!");
        assert_eq!(decoder.push(&[0xff, 0xe4, 0xbd], false), "�");
        assert_eq!(decoder.push(&[0xa0], false), "你");
        assert_eq!(decoder.push(&[0xe4, 0xbd], false), "");
        assert_eq!(decoder.push(&[], true), "�");
    }
    #[test]
    fn utf8_stream_matches_lossy_decode_for_all_two_chunk_splits() {
        for bytes in [
            b"ascii".as_slice(),
            "中文🙂".as_bytes(),
            &[0xff, 0xe4, 0xbd, 0xa0, 0xc0, 0xf0, 0x9f, 0x99, 0x82],
            &[b'a', 0xe4, 0xbd],
        ] {
            for split in 0..=bytes.len() {
                let mut decoder = Decoder::default();
                let mut output = decoder.push(&bytes[..split], false);
                output.push_str(&decoder.push(&bytes[split..], false));
                output.push_str(&decoder.push(&[], true));
                assert_eq!(output, String::from_utf8_lossy(bytes), "split {split}");
            }
        }
    }
    #[test]
    fn posix_arguments_cannot_escape_quotes() {
        assert_eq!(
            remote_command(
                "/path/a b",
                &["a'$(touch /tmp/pwn)".into()],
                Some("/a b"),
                "posix"
            )
            .unwrap(),
            "cd '/a b' && exec '/path/a b' 'a'\"'\"'$(touch /tmp/pwn)'"
        );
    }
    #[test]
    fn windows_uses_encoded_script() {
        let command = remote_command(
            "C:\\Program Files\\cli.exe",
            &["'; exit 1".into()],
            None,
            "windows",
        )
        .unwrap();
        assert!(command
            .starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand "));
        assert!(!command.contains("exit 1"));
    }
    #[test]
    fn validates_limits_and_never_discovers_executable() {
        assert!(validate(&json!({})).is_err());
        assert!(validate(&json!({"executable":"node","timeoutMs":0})).is_err());
        assert!(validate(&json!({"executable":"explicit","args":["a"]})).is_ok());
    }
}
