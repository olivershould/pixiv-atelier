# 本机连接服务协议

这是应用与可选外部执行端之间的接口约定，**不是 Pixiv 官方 API**。应用另有内置 Chrome 后台连接，推荐每账号使用专用浏览器，也兼容已授权的现有浏览器，详见 [Chrome 连接说明](chrome-connection.md)。本文不代表外部连接器已实现；外部执行端需要独立部署与验证。

**本地识图与 Pixiv 投稿连接相互独立。** 安装本地模型后，即使没有配置 `PIXIV_CONNECTOR_URL`、没有登录 Pixiv，也可以分析本机已上传的图片。默认识图由本地 Python / ONNX worker 完成；不会自动回退到连接器或使用演示标签替代失败结果。真正上传、同步账号及确认发布需要内置 Chrome 连接，或实现本文协议的外部连接器。

## 应用侧本地识图接口

`GET /api/tagger/status` 实际检查本地 worker，返回 `available`、`status`、`message`、`model`、`modelVersion`、`catalogEntries` 等。`GET /api/state` 的 `tagger` 字段是最近一次检测结果。模型首次加载在后台进行，`status:"checking"` 不妨碍应用启动、编辑作品或处理预约；手动健康检查可以等待加载完成。

`POST /api/tags/suggest` 接受以下二选一输入：

```json
{"jobId":"已保存作品的 ID","provider":"local"}
```

```json
{"draft":{"accountId":"本地账号 ID","files":[{"id":"已上传图片 ID"}],"title":"尚未保存的标题"},"provider":"local"}
```

完整表单可以放入 `draft`，但分析不会保存它、创建作品、修改原队列状态或自动确认标签。账号与图片必须属于当前空间。推理只接收安全解析后的本机图片路径，并逐图分析；它不占用预约及状态写入的串行队列。

- 真实模式省略 `provider` 时使用 `local`，不需要 Pixiv 连接器。
- 演示模式省略时使用 `demo`，返回明确标记的固定示例；`provider:"demo"` 不能用于真实模式。
- 演示模式也能显式使用 `local` 分析真实上传的图片。应用自带 SVG 封面不能作为真实识图输入，返回 422 并要求上传图片。
- 只有显式选择 `provider:"connector"`，且处于真实模式时，才会调用后文的连接器标签接口。

公开版标签目录是通用静态映射，不包含私人截图或账号数据。映射得到的候选使用 `existing:false`、`verified:false`、`evidence:[]`，只提供搜索或人工选择；没有映射的视觉概念列入 `unmapped`。实际核实与自动选择标签需要当前账号历史、缓存或 Pixiv 查询来源。返回的 `confidence` / `modelScore` 是模型分数，不能替代用户确认。图像分析还可提供分级建议，前端在保护手动修改的前提下应用；AI 创作标记不由模型判断。

响应包含模型及目录版本、逐图 SHA-256、`inputFingerprint`、`requestFingerprint`、捕获时的 `mode`，以及 `modeChanged`、`sourceChanged`、`stale`。前端必须对照发起分析时的表单与图片顺序；若当前输入已改变或 `stale:true`，不得将旧建议应用到新作品。`draft` 尚未保存的改动只能由前端对照；服务器不会获知后来没有提交的输入。

本地运行配置由设置脚本写入私有的 `.data/tagger-config.json`，记录经过自检的 Python、模型与运行库路径；项目内路径相对项目根解析，无配置时可发现 `.runtime/python/python.exe`。手动终端启动可用 `PIXIV_TAGGER_PYTHON` 显式覆盖解释器，Windows 后台启动器会清理该变量。配置不是浏览器提交的命令，也不会通过 shell 执行；worker 使用 Python 隔离模式。模型或运行环境未就绪时，分析返回真实错误，不产生替代标签。

## 可选的 Pixiv 投稿连接器

外部连接器与内置 Chrome 方式互斥。开发者需自行部署符合协议的回环服务，再从终端显式启动应用；Windows 后台启动器会清理连接器变量，不能用它传入下面的开发配置：

```powershell
$env:PIXIV_CONNECTOR_URL = 'http://127.0.0.1:4320'
# 如连接服务需要，在本机配置 PIXIV_CONNECTOR_TOKEN；请勿提交到版本库。
node server/index.mjs
```

只允许 `http/https` 回环地址，不允许 URL 用户信息、查询参数或片段。带令牌时请求附 `Authorization: Bearer …`。前端不会收到令牌。默认本地识图不会向该连接器发送图片；用户显式选择连接器建议或执行真实投稿后，才按相应接口发送所需作品数据。

外部连接器仍按单件预约流程执行，不继承内置 Chrome 的两个独立投稿页或自动关闭页面能力。本文的快照、投稿、标签接口也不自动提供内置统计采集；统计说明见 [数据统计口径](analytics.md)。

## GET /accounts/:accountId/snapshot

提供已核实的账号登录、会员状态，以及**所有来源**的远端预约总数。`accountId` 是本地账号记录 UUID，不是 Pixiv ID；连接服务需要维护映射。

```json
{
  "ok": true,
  "connected": true,
  "premium": true,
  "complete": true,
  "total": 1,
  "reservations": [{
    "remoteId": "实际远端标识",
    "jobId": "本地作品 ID",
    "idempotencyKey": "本次上传标识",
    "status": "reserved",
    "scheduledAt": "2030-01-02T12:00:00.000Z"
  }]
}
```

预约记录状态：`reserved`、`published`、`failed`。`total` 仅统计当前仍占用远端预约名额的作品，包括应用外建立的预约。连接服务需保留已发布记录以支持核对，不能仅返回“现在预约列表里没有这件”就声称发布成功。数据不完整或无法验证应返回 `ok:false`，不要用空列表替代错误。

匹配本地作品的 `reserved` / `published` 记录必须提供从远端回读的 `scheduledAt`，使用包含时区的绝对时间，且与本次请求的目标时刻相同；UTC 与 JST 的等价写法可以匹配。不得直接复制请求参数来填补缺失的远端证据。时间缺失、无时区、无效或不一致时，本地保留远端 ID 与幂等标识，标记 `needs_review`，不会确认成功或再次上传；`reviewReason` 为 `reservation_time_missing` / `reservation_time_mismatch`，并通过 `remoteScheduledAt` 保留实际读回时刻。后续取得正确、完整的同一预约记录后，可通过同步恢复状态。

## POST /accounts/:accountId/reservations

请求 `{job, idempotencyKey}`，`job` 包含标题、说明、已确认标签、完整 `content`、预约绝对时间、时区和图片。

图片格式 `{id,name,mime,size,base64}`；`base64` 为原始图片内容，不包含本机绝对路径。执行端需逐项映射表单，校验远端限制及本次账号身份。所有图片、确认信息和日期必须属于这次作品。

成功响应：

```json
{"reservation":{"remoteId":"实际标识","status":"reserved"}}
```

应用随后再次获取快照，只有找到本次 `idempotencyKey`、实际远端 ID、明确状态和匹配的回读预约时间才确认成功。执行端必须实现幂等：重复相同标识返回已有结果，不能再次发帖。首次上传前需自行重新检查远端容量；本地应用串行化不足以阻止用户同时在网站手动预约。

本地应用在同步完成、每件提交前以及图片准备完成后使用当前时间重新检查预约窗口、过期状态和同步有效期，不沿用一整轮开始时的旧时钟。若尚未发出请求但预约时间已过，则保留为可重新排期的本地待核对作品，不改成立即发布。连接器在实际发送到 Pixiv 前也必须再次检查时间与名额，以覆盖本机检查之后发生的变化。

只有在能证明**没有上传、没有占用远端预约**时可返回：

```json
{"definitive":true,"outcome":"not_uploaded","error":"明确未提交的原因"}
```

其他网络错误／超时／不确定结果都会进入待核实状态，不自动再次上传。远端失败、取消和账号会话异常应可追踪。遇到人机验证或重新登录，需要用户在该执行端自行完成，不绕过验证。

## 连接器 POST /tags/suggest

只有应用侧显式请求 `provider:"connector"` 才会使用。请求 `{accountId,files,content,title,caption}`，图片格式同上。应用逐图请求并合并候选，避免将整批作品转换为巨大的 base64 消息。执行端根据图片分析候选概念，再查询并验证 Pixiv 实际存在的标签。

```json
{
  "candidates": [{
    "tag": "風景",
    "confidence": 0.94,
    "reason": "画面主体是自然景观",
    "existing": true,
    "verified": true,
    "evidence": [{
      "kind": "pixiv_tag_page",
      "tag": "風景",
      "url": "https://www.pixiv.net/tags/%E9%A2%A8%E6%99%AF/artworks",
      "checkedAt": "2030-01-01T14:00:00.000Z"
    }]
  }]
}
```

应用同时要求 `existing:true`、`verified:true` 和结构完整的标签页来源：证据类型、相同标签、真实 Pixiv HTTPS 标签页地址、有效的核实时间。地址中的标签必须与候选一致。布尔标记本身、拼接得到但没有实际核验的地址，都不能作为真实证据；执行端必须保留实际查询依据。应用不会自行拼接 URL 充当来源，缺少证据的候选会被剔除，全部无效时返回 502。

所有标签仍然只是建议，必须由用户选择和确认；不能用文件名或固定模板猜测冒充图像识别。

## 字段约定

`content` 支持 `type`、`aiGenerated`、`rating`、`sexualContent`、`adultAttributes`、`visibility`、`original`、`allowTagEdit`、`allowComments`、`allowCollection`、`tools`、`seriesId`、`imageResponse`、`allowImageResponse`、`contestTag`、`thumbnail`。

- `type`：`illust` / `manga`。
- `rating`：`all` / `r18` / `r18g`。全年龄 `sexualContent` 必须明确为布尔值，其他分级为 `null`。
- `adultAttributes`：`underage` / `furry` / `bl` / `gl` 的数组，默认空。全年龄清空。
- `visibility`：`public` / `logged_in` / `mypixiv` / `private`。
- `thumbnail`：`{page:1,x:0.5,y:0.5}`，页码从 1 开始；草稿可以先保存未完成的页码，进入预约队列时页码必须对应当前作品实际存在的图片。本版是焦点参数，不声称已经实现精确裁切框。
- `poll` 仅为向前兼容空字段，本版不实现问卷。连接服务忽略它。

高级动态选项仍应与实际表单复核；禁止静默丢弃不支持的字段并声称投稿成功。
