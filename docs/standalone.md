# 独立运行、启动与停止

画序的服务、识图和浏览器连接都在本机运行，不依赖 ChatGPT、Codex、GPT API、API Key 或 agent-browser。访问 Pixiv 仍需网络与 Google Chrome。

## 源码仓库与已准备好的安装

公开仓库只提供源码，不包含 `.runtime` 二进制、识图模型、账号或登录资料。可以使用自己安装的运行环境，也可以自行为应用准备项目内运行环境。

| 用途 | 所需内容 |
| --- | --- |
| 草稿、队列、统计服务 | Node.js 22.13 或更新版本 |
| 内置 Pixiv 接入 | Windows 上可用的 Google Chrome，及各账号登录 |
| 本地识图（可选） | Python 3.10+，建议 CPython 3.12 x64；识图依赖和模型 |
| 双击启动 | PATH 中的独立系统 Node，或项目内 `.runtime/node/node.exe` 及发行版所需文件与许可证 |
| 项目内识图环境 | `.runtime/python/python.exe` 及完整标准库、DLL、许可证；`.runtime/tagger/` 和已校验模型 |

请从可信的官方发行渠道准备运行环境，不要只复制一个可执行文件而遗漏标准库或 DLL。识图依赖含 Python 版本和平台相关的二进制，换 Python 主次版本或架构时不能直接假定旧依赖可复用，应重新安装并检查健康状态。

## 启动

系统已安装 Node.js 22.13+ 且 PATH 可找到时，可双击 `Start.cmd` 或 `Start.vbs`。不在 PATH 中时，进入项目目录，在 PowerShell 显式指定解释器：

```powershell
.\Start.ps1 -NodeExecutable 'C:\Program Files\nodejs\node.exe'
```

路径需替换为实际独立安装的 `node.exe`，且必须为绝对路径。启动器依次选择项目内 `.runtime/node/node.exe`、显式参数、PATH 中的独立系统 Node，最后检查 Program Files 下的标准 Node 安装路径；不使用 Codex 运行时或 WindowsApps 跳转程序。已选择的项目运行时或显式参数无效时会报错，不静默改用其他解释器。`-NoBrowser` 可只启动服务而不打开工作台。

准备好项目内 Node 后，可以双击 `Start.vbs`、`Start.cmd`，或运行 `Start.ps1`。启动器在后台运行服务并打开 [本地工作台](http://127.0.0.1:4318)。重复启动会核对并复用本安装的服务，不另外创建一个队列进程。

开发者也可用当前终端的独立 Node：

```sh
node server/index.mjs
```

这种启动方式由终端管理，不属于 Windows 启动器的进程记录。启动器管理的服务默认清理外部 Node/Python 与连接器环境变量；若需环境变量形式的开发配置，应使用手动终端入口。

## 停止与运行条件

由启动器运行的服务使用 `Stop.vbs`、`Stop.cmd` 或 `Stop.ps1` 停止。它会校验服务归属，并请求安全退出；投稿、同步或采集未结束时会拒绝停止，等待结束后再试，不会强制杀死同名进程。

手动终端启动的服务需从原终端停止；不要把启动器的“未找到管理中的服务”理解为所有画序进程均已停止。备份或迁移前应确认服务和该安装的专用 Chrome 均已退出。

关闭网页、聊天软件或代码编辑器不会停止独立后台服务。电脑休眠、关机或退出 Windows 后，本地采集、核实和补位均无法继续；恢复后重新启动应用。当前不会自动添加 Windows 开机启动任务。已在 Pixiv 确认的预约由 Pixiv 执行。

## 本地识图路径

`Setup-Tagger.ps1` 优先使用显式指定的 Python、项目内 Python 或独立安装；不依赖聊天软件的 Python。可传入相对项目根的路径：

```powershell
.\Setup-Tagger.ps1 -PythonPath '.runtime\python\python.exe'
```

这个例子要求目录中已经有完整、可用的独立 Python。脚本会校验并复用现有模型；缺少依赖或模型时才执行相应设置步骤，不是 Python 本身的下载器。仅项目自有解释器缺少 pip 时可通过其 `ensurepip` 引导 pip，外部解释器需自行准备。

识图配置的 `pythonPath`、`runtimeDir`、`modelDir` 支持相对项目根的路径，不随启动终端所在目录改变。后台 worker 使用隔离模式和明确的项目依赖目录。模型与配置位于私有 `.data`，不会随 Git 克隆附带。

## 迁移已有完整安装

`Install-Standalone.ps1` 用于把**已经具备运行环境、依赖与模型的本地安装**迁移到新目录。它不下载 Node、Python、模型或 Chrome，不能直接用于刚克隆且尚未设置的仓库。

准备好 `.runtime/node`、`.runtime/python`、`.runtime/tagger`、模型和识图配置后，停止源服务与专用 Chrome，再运行：

```powershell
.\Install-Standalone.ps1 -Destination (Join-Path $env:LOCALAPPDATA 'PixivAtelier') -CreateDesktopShortcut
```

目标目录必须不存在，并与源目录分离。脚本保留原安装，复制所需运行文件及私人数据，重写项目内识图路径和专用 Chrome 进程记录，并可创建启动、停止快捷方式。它不会把两个安装合并，也不会对原安装做自动清理。

不要同时运行新旧安装处理同一批作品。迁移后核对账号、队列、模型和统计数据，再统一使用新安装。跨电脑或 Windows 用户迁移时，Chrome 登录加密资料可能不可用，需要重新登录。

## 备份

先安全停止服务和专用 Chrome，再备份完整安装目录。若只备份数据，必须保留整个 `.data`，包括图片、账号、登录资料、提交记录、角色记忆、模型及统计数据库；还需保留可重新准备相同运行环境的版本信息。

界面“导出记录”不是完整备份。不要将包含登录状态或真实作品的安装目录作为公开发行包上传。
