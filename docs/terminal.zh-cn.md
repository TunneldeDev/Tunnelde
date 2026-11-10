# 终端键盘与剪贴板

终端使用 xterm 处理光标模式、转义序列、渲染、鼠标上报和括号粘贴。
SSH 发送 xterm 的输入流，不会将普通方向键或控制键重新拼装成文本或 shell 命令。
粘贴经过 xterm，以便应用收到其协商的粘贴模式。

## 键盘协议协商

应用可以查询并启用 Kitty 键盘协议，终端核心随之编码 Shift+Enter 等组合键，以及应用要求的
按下、连按和松开事件，SSH 原样传送这些字节。应用恢复协议栈或离开备用屏幕后，恢复之前的
键盘模式。前端后台重建时，检查点同时保存两个屏幕的协议栈。

普通 shell 在启用增强协议前继续使用传统输入：Shift+Enter 仍发送回车；兼容应用协商协议后，
它才成为可区分的组合键。中间的终端复用器也需要支持并转发协商，Tunnelde 不会全局强制发送
某个应用专用的按键序列。

终端核心与扩展固定使用匹配的 xterm 6.1 预发布包，以取得原生 Kitty 支持。版本专用的检查点
适配器通过实际发行包的解析器测试。宿主快捷键按用户配置的透传策略执行，未处理输入继续交给
xterm。宿主消费的按键也会抑制对应的松开事件，避免远端收到没有按下事件的松开序列。

实现参考：[xterm 键盘服务](https://github.com/xtermjs/xterm.js/blob/master/src/browser/services/KeyboardService.ts)、
[VS Code 终端集成](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts)、
[Zed 按键映射](https://github.com/zed-industries/zed/blob/main/crates/terminal/src/mappings/keys.rs)
及 [Kitty 协议](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)。

## 桌面编辑与剪贴板

macOS 的默认编辑手势会转换为终端输入：

| 手势                | 终端序列            | 常见 shell 行为     |
| ------------------- | ------------------- | ------------------- |
| Command + 左 / 右   | Ctrl+A / Ctrl+E     | 移至行首 / 行尾     |
| Option + 左 / 右    | Escape+b / Escape+f | 上一个 / 下一个单词 |
| Command + Backspace | Ctrl+U              | 向行首删除          |
| Command + Delete    | Ctrl+K              | 向行尾删除          |

最终行为由远端 shell 或应用解释。这些默认值遵循桌面编辑器的终端编辑习惯。
在快捷键设置中搜索“终端”类别，可以逐项修改或禁用；其他平台不会新增这些默认绑定。
增强键盘模式下，原生协议编码优先于这些传统默认映射；用户显式配置绑定或高级规则时，仍可选择执行编辑命令。
输入法组合输入、AltGr、普通光标键以及未处理的修饰键继续交给 xterm。
Command+C/V 仍用于复制粘贴，Command+A 选择终端缓冲区；Control+C 仍可中断进程。

“终端 → 复制与粘贴”中有两个独立设置：

- **选中文字后自动复制**：复制 xterm 自己的选区。接管鼠标的终端程序可能自己管理选区，
  此时可按住 Shift 拖动，使用普通终端选区。
- **允许终端程序复制文本**：默认开启。在活动终端近期有鼠标选择或复制操作后，接受有大小限制的
  UTF-8 OSC 52 写入，包括鼠标释放前发出的请求。因此，普通选中自动复制关闭时，终端程序仍可
  执行自身的复制操作。关闭此设置则拒绝程序写入剪贴板。后台或非活动终端、无相关用户操作的请求、
  剪贴板查询均被拒绝，不提供读取剪贴板的能力。

终端程序需要自身发出剪贴板协议，才能通过 OSC 52 复制其选区。
终端复用器或中间 SSH 层可能需要自己的剪贴板配置；应用中的开关无法为远端程序补出未支持的协议。
