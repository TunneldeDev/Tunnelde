# 运行资源生命周期

`resources.snapshot`、`resources.identify` 与 `resources.release` 为**实验接口**，只观测当前已批准插件运行拥有的资源。各领域注册表仍是唯一真实状态来源，不另建重复资源表，也不授予跨插件权限。

| 方法                 | 请求                                   | 返回                                   |
| -------------------- | -------------------------------------- | -------------------------------------- |
| `resources.snapshot` | `{offset?: number, revision?: string}` | `{revision, items, total, nextOffset}` |
| `resources.identify` | `{kind, id}`                           | `{handle, kind, state}`                |
| `resources.release`  | `{handle: string}`                     | `{handle, outcome}`                    |

每项只包含 `handle`、`kind`、`state`。种类为 `connection`、`forward`、`mount`、`task`、`transfer`；状态为 `owned`、`releaseRequested`、`cleanupRequired`。不返回路径、命令、凭据或全局内部 store。句柄绑定插件标识、包指纹、运行代次、种类及领域实例，仅作标识，不是权限凭据。

只列出领域已提交的活跃资源；连接还必须已被接受。未接受连接结果、用户自行建立或明确交接的连接、其他运行、已完成任务及传输历史均不纳入。暂停的传输仍为自有资源，明确取消会覆盖暂停。复用传输 ID 会生成新的实例，旧句柄不能取消新任务。

每页最多 128 项、64 KiB，整体观测最多 4,096 项。后续分页必须携带 `nextOffset` 和原始 `revision`。收到 `plugin.resources.changed` 时丢弃已累积的页，从零重新读取。修订只覆盖句柄和生命周期状态，不覆盖任务输出或传输进度。这是跨领域有界观测，不是全局原子事务、保留快照或事件订阅。

释放在最终动作时重验当前审批和准确领域所有权。旧句柄不能停止替代监听器、新传输、已交接连接或其他运行的资源。工具客户端作用域内的连接还会重验客户端。`released` 表示相应连接底层传输及终端 worker、转发监听器清理或正常卸载及进程清理已完成；依赖资源保留各自生命周期，可能仍在清理。`cancellationRequested` 表示进程任务或传输已收到协作取消请求，实际 worker 退出前仍保留资源并占用领域配额。不强制卸载，不删除历史或恢复文件，也不承诺回滚远端命令。

观测截止为 5 秒；每插件最多 4 项、全局最多 16 项并行观测或释放。提交释放后，即使调用者消失，清理仍继续，操作容量不会提前释放。领域错误保留原始类别，另有 `plugin.resources` 下的 `invalidRequest`、`changed`、`unavailable`、`observationLimit`、`busy`、`workerFailed`、`cleanupIncomplete`。旧宿主应先通过 `api.describe` 探测支持。

SDK 的 `sdk/runtime/resources/client.mjs` 提供严格签名，不允许动态方法回退；仅包装现有授权传输，不启动 Node。可信 UI 插件可以使用 `context.api.call` 调用相同接口，其本地 `UiResourceScope` 是另一种生命周期。持久 runner、恢复记录、UI scope 及通用依赖激活不在本目录内。

实现按领域和职责分类：`plugins/runtime/ownership/` 管预留所有权；`runtime/lifecycle/contracts/` 管传输 DTO；`adapters/` 分领域桥接；`projection.rs`、`admission.rs`、`rpc.rs` 分别负责分页、并发预算和传输协调。各领域的生命周期辅助代码保留在真实注册表旁。公开 TypeScript 契约放在 `contracts/runtime/lifecycle/`，SDK 数据类型、方法目录、客户端契约及实现分开，并在同步中检查。原协议版本及 stable API 不变。

## 显式识别资源

`resources.identify({kind, id})` 返回当前运行拥有的一项已提交资源，结构仍为
`{handle, kind, state}`。`id` 使用现有领域 ID：`connection` 使用 `sessionId`，
`forward` 使用转发规则 ID，`mount` 使用 `mountId`，`task` 使用 `taskId`，
`transfer` 使用传输 ID。不要比较并发创建前后的快照来猜测所有权。
参数拒绝未知字段；`id` 必须非空、不超过 512 个 UTF-8 字节，且不含控制字符。

不存在、其他插件、旧运行、尚未接受结果及已交接的资源统一返回
`plugin.resources.unavailable`。识别不会授予权限或登记资源。它仅查询指定领域，
共用现有观测预算；无关挂载操作不会阻塞连接查询。返回值对应观测当时的实例，
不保证是更早某次创建请求的产物。保存准确的句柄：随后替换实例或交接所有权后，
旧句柄不能释放新实例或新所有者的资源。快照原有返回结构不变。

通过 `api.describe` 探测接口；新扩展目录还提供可选的
`runtime.resources.identify`，旧宿主可能不提供。严格 SDK 客户端提供
`createRuntimeResourcesClient(host).identify({kind, id})`。

## 与视图生命周期组合

只为明确选择、应当随该视图关闭的独占资源登记清理。例如，已保存的 `sessionId`
属于该视图时：

```jsx
function ConnectionView({ resources, sessionId }) {
  const { useEffect } = context.sdk.react;
  useEffect(() => {
    const lifetime = resources?.child?.();
    if (!lifetime) return;
    void lifetime
      .acquire(
        () => context.api.call("resources.identify", { kind: "connection", id: sessionId }),
        async (resource) => {
          await context.api.call("resources.release", { handle: resource.handle });
        },
      )
      .catch((error) => {
        if (!lifetime.signal.aborted) console.error(error);
      });
    return () => lifetime.dispose();
  }, [resources, sessionId]);
  return null;
}
```

子作用域处理 effect 重放和依赖变化。隐藏但保留的视图仍有效；关闭后启动已登记的
清理，识别结果晚到时也会清理。释放原生资源时仍重验准确所有权；清理错误应保留
诊断，不能显示为释放成功。不要把无关资源或持久 runner 登记为视图清理对象。
关闭视图不会隐式停止 runner 或删除恢复记录。模块退休时，`context.api` 可能已经
拒绝调用，原有宿主运行退休机制仍负责原生资源清理。UI scope 不绕过权限，也不是
模块退休后仍能调用的传输通道。
