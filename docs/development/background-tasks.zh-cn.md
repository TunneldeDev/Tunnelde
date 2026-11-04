# 后台任务

[English](background-tasks.en-us.md)

任务服务将执行、进度上报和界面展示分开。功能模块可以接入公共的可拖动任务窗口，
无需依赖文件管理模块。状态栏入口和 F1 的“后台任务”命令打开同一个窗口；任务不会
自动展开窗口。每组按二十项逐步加载，已结束分组默认收起。设置 `visible: false`
即可让任务不出现在此列表中。

## 包装异步操作

```ts
import { runBackgroundTask, withBackgroundTask } from "@/lib/tasks/background";

const result = await runBackgroundTask({ title: "建立索引" }, async ({ signal, report }) => {
  for (let index = 0; index < documents.length; index++) {
    signal.throwIfAborted();
    await indexDocument(documents[index], signal);
    report({ progress: { completed: index + 1, total: documents.length, unit: "items" } });
  }
  return documents.length;
});

const refresh = withBackgroundTask(
  (folder: string) => ({ title: `刷新 ${folder}`, visible: false, cancellable: false }),
  async ({ signal }, folder) => refreshFolder(folder, signal),
);
```

包装保留原操作的返回值和异常。可以上报说明及字节数、项目数或百分比进度；省略总量
表示进度暂不确定。取消采用协作方式：点击取消只中止信号，任务在实际操作结束前仍是
运行状态。操作应检查信号，并在 `finally` 中释放资源。取消请求太晚而实际操作成功，
会记录为已完成；其他错误仍记录为失败。支持父级 AbortSignal；
`cancellable: false` 隐藏取消操作。

包装不会自动将 CPU 工作移至工作线程，也不会创建原生进程。前端任务运行时会推迟
托盘 WebView 释放，隐藏任务同样如此。最近一百项已结束的包装任务会随窗口检查点保存
到原生内存，恢复 WebView 后仍可查看；退出程序后不保留。隐藏任务结束后自动移除。

## 接入已有任务服务

已有执行和持久化机制的功能使用 `registerBackgroundTaskSource` 提供快照及订阅：

```ts
const dispose = registerBackgroundTaskSource(
  {
    id: "indexer",
    snapshot: () =>
      jobs.map((job) => ({
        id: job.id,
        title: job.title,
        status: job.status,
        execution: "native",
        updatedAt: job.updatedAt,
        visible: job.showInTaskWindow,
        progress: { completed: job.processed, total: job.total, unit: "items" },
        actions: [{ id: "cancel", label: "取消索引", run: () => cancelJob(job.id) }],
      })),
    subscribe: (changed) => jobEvents.subscribe(changed),
  },
  lifetime.signal,
);
```

任务源 ID 必须唯一，不同源中的任务 ID 可以相同。清理函数或 AbortSignal 会移除订阅
和列表条目，不会擅自取消实际任务。注册应随应用生命周期释放；WebView 重建后重新
订阅并读取权威快照。注册先订阅再读取最终快照，避免漏掉期间事件。旧清理函数不会
移除后来重新注册的源。

状态为 `running`、`paused`、`attention`、`done`、`cancelled`；失败或需要恢复的任务
使用 `attention`。操作包含 ID、可访问名称、可用状态和处理函数，只提供确实支持的
操作。已结束任务的 `clear` 操作参与批量清除。源管理的任务不会被公共服务自动丢弃。

只有实际操作在 WebView 销毁后仍可继续，且任务源能够恢复状态，才应使用
`execution: "native"`。如果仍需 JavaScript 后续处理才能完成，即使调用了原生 IPC，
也应使用 `webview`。

默认行支持说明、进度、错误及操作。需要复杂交互时，可以通过
`src/features/tasks/presentation.ts` 中的 `registerTaskPresentation` 注册专属展示，
并与任务源一起释放。传输适配器负责重连、恢复、限速与临时文件清理；公共窗口负责
分组、分页、焦点及窗口位置大小。

这是工作台内部的集成接口，不会增加插件权限或改变插件协议版本。外部插件 API 的
稳定性约定另行维护。
