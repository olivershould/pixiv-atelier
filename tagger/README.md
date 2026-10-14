# 本地图片识别

使用原版 `SmilingWolf/wd-swinv2-tagger-v3`，在 Windows x64 的 CPU 上通过 ONNX Runtime 分析真实图片像素。图片不发送到云端；worker 不访问 Pixiv、不读标题或文件名含义、不自行生成 Pixiv 标签存在性证明，也不修改投稿表单。

## 安装

需要 Python 3.10 或更新版本及 pip；建议 Python 3.12 x64。使用运行应用时可长期访问的 Python。Windows 需要 ONNX Runtime 适用的 Microsoft Visual C++ 运行库。

Windows 可双击项目根目录的 `Setup-Tagger.cmd`。启动器会寻找已有 Python，并在本项目内安装；完成后进入应用「设置 → 检查本地识图」。已安装时会校验并复用模型。

也可在项目根目录执行：

```powershell
python tagger/setup.py --install-deps --download-model --verify
```

若使用完整 Python 路径：

```powershell
& 'C:\path\to\python.exe' tagger/setup.py --install-deps --download-model --verify
```

- 不带参数时只显示帮助，不下载或安装。
- `--install-deps`：通过当前 `sys.executable -m pip`、官方 PyPI、固定版本、仅 wheel 和 `--target` 安装到本项目 `.runtime/tagger`。不会修改全局 Python 包。安装先写入独立暂存目录，导入检查通过后才替换；旧运行目录保留为 `.runtime/tagger.previous-*`。
- `--download-model`：仅下载固定 revision 的两个文件到 `.data/models/wd-swinv2-v3`；无需克隆仓库或下载其他权重。
- `--verify`：离线校验两个模型文件的完整 SHA-256、依赖版本，并真正初始化 CPU 推理会话。成功后原子写入 `.data/tagger-config.json`，供本地服务发现 Python 和资源路径。
- 两个安装阶段可单独执行；缺少另一阶段时不会声称模型已就绪。整个设置或校验失败返回非零退出码。
- 下载使用正常 TLS 验证。中断保留 `.part`，下次请求 Range 续传；服务器不支持续传时从头覆盖 `.part`。只有字节数和 SHA-256 全部匹配，才原子替换正式文件。无效完整临时文件保留为 `.invalid-*`，不加载、不误报成功。

安装前请关闭正在使用此模型的本地服务，避免 Windows 文件占用导致替换失败。安装与下载会访问 PyPI、Hugging Face 及其 HTTPS 文件服务；安装完成后识别无需联网。版本固定记录在 `model-manifest.json`；未锁定跨平台 wheel 的字节哈希，因此可复现的是依赖版本集合，不承诺不同 Python／平台使用同一个 wheel。

## 固定模型与来源

模型许可证由作者仓库标为 Apache-2.0。此处说明的是所下载模型的许可，不替代本项目或其他依赖的许可。

Revision：`627aef95638667ddcaa3ac8ae625e88ea5b02f51`。

| 文件 | 精确字节数 | SHA-256 |
| --- | ---: | --- |
| model.onnx | 467460978 | `e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1` |
| selected_tags.csv | 308468 | `298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217` |

ONNX 的 SHA-256 来自 [Hugging Face 固定版本 API](https://huggingface.co/api/models/SmilingWolf/wd-swinv2-tagger-v3/revision/627aef95638667ddcaa3ac8ae625e88ea5b02f51?blobs=true) 的 LFS 元数据。CSV 的 SHA-256 是从同一 revision 的官方 HTTPS 内容计算得到；API 提供其 308468 字节大小与 Git blob ID `a2a653a5c89c8e387765eb1de9cfd2aedc92ee8d`，没有提供 CSV 的 SHA-256。两者不可混淆。

参考 [作者模型仓库](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/tree/627aef95638667ddcaa3ac8ae625e88ea5b02f51)、[作者 ONNX 示例](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)、[ONNX Runtime 官方文档](https://onnxruntime.ai/docs/get-started/with-python.html)。

依赖固定为 ONNX Runtime 1.22.1、NumPy 2.2.6、Pillow 11.2.1，以及 manifest 列出的固定传递依赖。worker 检查这些依赖来自项目 target 目录，不悄悄回退到全局安装。

## Worker 协议

启动 `python -u tagger/worker.py`；stdin/stdout 使用 UTF-8 JSON Lines，一行一个请求／响应。进程持久运行；模型在首次 health 或 analyze 时加载和校验，随后复用。stdout 仅输出协议 JSON。

```json
{"op":"health","id":"health-1"}
{"op":"analyze","id":"request-1","files":[{"id":"file-1","path":"D:\\project\\.data\\uploads\\image.png","sha256":"64位实际SHA256"}]}
```

`op` 可省略，默认 analyze。健康检查成功返回 `ok:true, ready:true`、模型 revision、标签数、CPU provider 与 `modelFiles`；依赖缺失、损坏文件或初始化失败返回 `ok:false`，绝不返回假就绪。

识别成功返回：

```text
{
  id, ok: true, model, modelVersion,
  modelFiles: [{name, sha256, size, sourceUrl}], manifestSha256, sources,
  analyzedFiles: [{id, sha256, width, height}],
  predictions: [{fileId, name, category, score}],
  ratings: [{fileId, name, category: 9, score}],
  durationMs
}
```

类别为数字：0 通用、4 角色、9 评级。通用分数严格大于 0.35、角色严格大于 0.85 才进入 predictions；评级单独返回，由 server/recognition.mjs 按用户启用的自动识图规则生成分级/性描写建议；多图取最严格结果，评级缺失时留空，R-18G 仅在明确的图像暴力概念满足阈值时建议。不推断成年/未成年属性。分数是模型输出，不是经过校准的正确率。保留 CSV 原始英文标签和下划线，交由应用作为 Pixiv 全站搜索关键词；只有实际 Pixiv 查询、已核实的当前账号历史或有效缓存来源支持的标签才能标为已核实；静态映射和手动加入常用池本身不构成证据。自动建议采用准确别名匹配，前缀结果留给手动搜索选择。

每个请求支持 1 至 200 张图片并逐张全部处理；不会只读第一张。任一图片失败则整个请求返回错误，不用部分结果冒充全部完成。图片路径必须在获准上传目录内且 SHA-256 与实际字节一致。支持 JPEG、PNG、静态 GIF；不接受动画。每张 worker 输入最多 32 MiB；为限制 CPU 内存，补方后的像素数不得超过 6400 万，超过时明确提示先缩小图片，不偷偷跳过。

像素预处理遵循作者流程：透明区域白底合成、居中白底补方、按模型输入尺寸 BICUBIC 缩放、float32 BGR NHWC。**不除以 255**。不根据路径、文件名、标题或说明产生标签。

可通过进程环境指定绝对路径：

| 环境变量 | 默认路径 | 用途 |
| --- | --- | --- |
| TAGGER_RUNTIME | 项目 `.runtime/tagger` | 固定依赖 target 目录 |
| TAGGER_MODEL_DIR | 项目 `.data/models/wd-swinv2-v3` | 只允许读取 manifest 中两个固定文件，并验证完整哈希 |
| TAGGER_UPLOAD_DIR | 项目 `.data/uploads` | 所有请求图片的获准父目录；server 使用自定义 dataDir 时必须传入其 uploadDir |

本实现不会自动下载模型；下载只能经由显式运行 setup。`python tagger/worker.py --health` 可进行单次离线健康检查。首次校验需要读取完整 467 MB 模型，耗时不等于稳态推理耗时。实际 CPU 耗时、内存和识别质量需要用本机真实作品测试。

## 角色标题与覆盖范围

单张图片可靠识别一个角色且没有多人信号时，应用将角色分类名整理为首字母大写的英文标题；多图、多角色、模糊分类时留空。文件名和已有手填标题不作为识图依据。当前模型角色覆盖有限；应用的角色目录、历史模板和视觉模型属于不同来源，目录中出现的角色不代表模型可以认出。不能将未识别说成已确认，也不会改变用户已预约作品的标题。

公开版附带的静态标签映射不包含私人图像或截图证据，也不证明 Pixiv 标签存在。对应候选以未核实状态显示，仅用于搜索或人工选择；当前账号的已核实历史、缓存或实时查询才能支持自动选标签。见 [标签映射说明](../docs/tagger-catalog.md)。
