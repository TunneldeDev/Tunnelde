# 主机菜单命令

[English](plugin-host-menu.en-us.md) · [主机装饰](plugin-host-list.zh-cn.md) · [UI SDK](plugin-ui.zh-cn.md)

实验性扩展点 `hostList.menu` 为已保存主机的右键菜单及更多菜单添加命令。
每项显示插件名称，保留内置操作；不同插件按插件 ID 排序，同一插件按清单顺序排列。

声明 `hosts.read` 权限，并为清单命令添加 `hostMenu: true`：

```json
{
  "permissions": ["hosts.read"],
  "commands": [{ "id": "inspect", "title": "检查主机", "hostMenu": true }]
}
```

Node、WASM 和可信前端命令均可贡献菜单；主题和声明式插件不能执行命令。
前端插件还需要常规 `frontend` 声明及明确的 `ui.trusted` 权限。
一条命令仅接受一种资源上下文，不能同时声明 `hostMenu` 与 `editor` 或 `fileMenu`。
每插件最多 16 条主机菜单命令，界面总计最多显示 128 条；标题最多 120 个字符，不能包含控制字符。

能力目录返回 `registration.manifest: "commands[].hostMenu"` 和
`ownership: "manifest"`。仅显示已安装插件的菜单元数据不会启动插件或检测 Node。
选择操作后才使用常规权限及运行时确认；取消确认不会执行命令。
已停止插件可在选择操作时启动，卸载插件后移除其菜单项。

命令收到 `HostMenuCommandInput`，由宿主生成到市场 SDK：

```json
{
  "host": {
    "id": "saved-host-id", "name": "服务器", "address": "example.org",
    "port": 22, "username": "operator", "groupId": null, "tags": ["prod"]
  }
}
```

这是用户明确选中主机的快照，不包含凭据、私钥路径、备注和内部状态仓库。
授权期间主机被删除或上述字段被修改时，调用失败并提示重新打开菜单；
授权后会再次核对主机和插件指纹。上下文仅供参考，不代表授权连接 SSH 或调用其他 API；
后续每次 RPC 仍会检查自身权限及运行代次。

命令面板和快捷键采用调用时活动标签页所关联的已保存主机。
没有关联主机时，提示用户先打开主机详情、终端或远端文件标签页。
命令排队期间切换焦点不会改变操作目标。
文本结果与文件菜单共用有大小限制的输出页；插件已停止、被替换或撤权时丢弃结果。

既有 RPC 契约保持兼容。本次仅增加菜单贡献，主机来源、扩展列、替代视图及完整领域迁移仍待实现。
