use wasmi::{Caller, Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};

use crate::error::{AppError, AppResult};

/// Offset where the host writes the request JSON.
const REQUEST_OFFSET: usize = 1024;
/// Offset of the response buffer the guest writes into.
const RESPONSE_OFFSET: usize = 65536;
/// Capacity the host promises to the guest for its response.
const RESPONSE_CAPACITY: usize = 262144;
/// Hard cap for a single response, independent of the guest's declared size.
const MAX_RESPONSE: usize = 1024 * 1024;
/// Guest logs longer than this are truncated.
const MAX_LOG_BYTES: usize = 8 * 1024;

/// A compiled WebAssembly plugin. Each call instantiates the module afresh so
/// state never leaks between invocations.
pub struct WasmPlugin {
    engine: Engine,
    module: Module,
}

struct GuestState {
    limits: StoreLimits,
    authority: Option<(
        std::sync::Arc<super::security::PluginSecurity>,
        super::security::Lease,
    )>,
}

impl WasmPlugin {
    pub fn load(bytes: &[u8]) -> AppResult<Self> {
        let mut config = Config::default();
        config.consume_fuel(true);
        let engine = Engine::new(&config);
        let module = Module::new(&engine, bytes)
            .map_err(|error| AppError::validation(format!("plugin.wasm.invalid: {error}")))?;
        Ok(Self { engine, module })
    }

    #[cfg(test)]
    pub fn call(&self, request: &str) -> AppResult<String> {
        self.call_with_security(request, None)
    }

    pub fn call_with_security(
        &self,
        request: &str,
        authority: Option<(
            std::sync::Arc<super::security::PluginSecurity>,
            super::security::Lease,
        )>,
    ) -> AppResult<String> {
        let limits = StoreLimitsBuilder::new()
            .memory_size(64 * 1024 * 1024)
            .instances(1)
            .memories(1)
            .tables(2)
            .table_elements(65536)
            .build();
        let mut store = Store::new(&self.engine, GuestState { limits, authority });
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(10_000_000)
            .map_err(|error| AppError::validation(format!("plugin.wasm.trap: {error}")))?;
        let mut linker = Linker::new(&self.engine);
        linker
            .func_wrap(
                "env",
                "log",
                |mut caller: Caller<'_, GuestState>, level: i32, ptr: i32, len: i32| {
                    let allowed =
                        caller
                            .data()
                            .authority
                            .as_ref()
                            .is_some_and(|(security, lease)| {
                                security
                                    .authorize(
                                        &lease.id,
                                        &lease.fingerprint,
                                        &lease.permissions,
                                        Some("log"),
                                        Some(lease.generation),
                                    )
                                    .is_ok()
                            });
                    if !allowed {
                        return;
                    }
                    log_from_guest(&mut caller, level, ptr, len);
                },
            )
            .map_err(|error| AppError::validation(format!("plugin.wasm.link: {error}")))?;

        let instance = linker
            .instantiate(&mut store, &self.module)
            .map_err(|error| AppError::validation(format!("plugin.wasm.instantiate: {error}")))?
            .start(&mut store)
            .map_err(|error| AppError::validation(format!("plugin.wasm.instantiate: {error}")))?;

        let memory = instance
            .get_memory(&store, "memory")
            .ok_or_else(|| AppError::validation("plugin.wasm.noMemory"))?;
        if memory.data_size(&store) < RESPONSE_OFFSET + RESPONSE_CAPACITY {
            return Err(AppError::validation("plugin.wasm.memory"));
        }

        let entry = instance
            .get_typed_func::<(i32, i32, i32, i32), i32>(&store, "tunnelde_call")
            .map_err(|_| AppError::validation("plugin.wasm.noEntry"))?;

        let input = request.as_bytes();
        memory
            .write(&mut store, REQUEST_OFFSET, input)
            .map_err(|error| AppError::validation(format!("plugin.wasm.memory: {error}")))?;

        let written = entry
            .call(
                &mut store,
                (
                    REQUEST_OFFSET as i32,
                    input.len() as i32,
                    RESPONSE_OFFSET as i32,
                    RESPONSE_CAPACITY as i32,
                ),
            )
            .map_err(|error| AppError::validation(format!("plugin.wasm.trap: {error}")))?;
        if written < 0 {
            return Err(AppError::validation(
                "plugin.wasm.trap: negative response length",
            ));
        }

        let length = (written as usize).min(RESPONSE_CAPACITY).min(MAX_RESPONSE);
        let mut response = vec![0_u8; length];
        memory
            .read(&store, RESPONSE_OFFSET, &mut response)
            .map_err(|error| AppError::validation(format!("plugin.wasm.memory: {error}")))?;
        String::from_utf8(response)
            .map_err(|error| AppError::validation(format!("plugin.wasm.response: {error}")))
    }
}

/// Forwards a guest log line to `tracing`, tolerating any malformed arguments.
fn log_from_guest(caller: &mut Caller<'_, GuestState>, level: i32, ptr: i32, len: i32) {
    let Some(memory) = caller
        .get_export("memory")
        .and_then(|export| export.into_memory())
    else {
        return;
    };
    if ptr < 0 || len <= 0 {
        return;
    }
    let length = (len as usize).min(MAX_LOG_BYTES);
    let mut buffer = vec![0_u8; length];
    if memory.read(&*caller, ptr as usize, &mut buffer).is_err() {
        return;
    }
    let message = String::from_utf8_lossy(&buffer);
    if level >= 2 {
        tracing::warn!(message = %message, "plugin log");
    } else {
        tracing::info!(message = %message, "plugin log");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ECHO: &str = r#"
        (module
            (memory (export "memory") 5)
            (func (export "tunnelde_call") (param $in i32) (param $len i32)
                (param $out i32) (param $cap i32) (result i32)
                (local $i i32)
                (block $done
                    (loop $copy
                        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
                        (i32.store8
                            (i32.add (local.get $out) (local.get $i))
                            (i32.load8_u (i32.add (local.get $in) (local.get $i))))
                        (local.set $i (i32.add (local.get $i) (i32.const 1)))
                        (br $copy)))
                (local.get $len))
        )
    "#;

    #[test]
    fn echoes_the_request_back() {
        let plugin = WasmPlugin::load(ECHO.as_bytes()).expect("compile echo module");
        assert_eq!(
            plugin.call(r#"{"ok":true}"#).expect("call echo module"),
            r#"{"ok":true}"#
        );
    }

    #[test]
    fn rejects_a_module_without_the_entry_export() {
        let wat = r#"(module (memory (export "memory") 5))"#;
        let plugin = WasmPlugin::load(wat.as_bytes()).expect("compile empty module");
        let error = plugin.call("{}").expect_err("missing entry export");
        assert!(error.to_string().contains("plugin.wasm.noEntry"));
    }

    #[test]
    fn terminates_infinite_guest_code_and_rejects_excessive_memory() {
        let infinite = r#"(module (memory (export "memory") 5)
            (func (export "tunnelde_call") (param i32 i32 i32 i32) (result i32)
                (loop $forever (br $forever)) (i32.const 0)))"#;
        let plugin = WasmPlugin::load(infinite.as_bytes()).unwrap();
        let started = std::time::Instant::now();
        let error = plugin.call("{}").unwrap_err();
        assert!(error.to_string().contains("fuel"), "{error}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let excessive = r#"(module (memory (export "memory") 1025)
            (func (export "tunnelde_call") (param i32 i32 i32 i32) (result i32) (i32.const 0)))"#;
        let plugin = WasmPlugin::load(excessive.as_bytes()).unwrap();
        assert!(plugin.call("{}").is_err());
    }
}
