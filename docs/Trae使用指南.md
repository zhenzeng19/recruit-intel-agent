# Trae 使用指南

本项目已在 `.vscode/` 下预置好调试与任务配置（Trae 与 VS Code 共用这套体系），
**打开文件夹后 F5 就能调试，Ctrl+Shift+B 就能打包**，无需手动配置。

---

## 一、用 Trae 打开项目

Trae → 打开文件夹 → 选择：

```
<项目所在目录>/招聘agent
```

> 注意：要打开 `招聘agent` 这个**仓库根目录**（里面能看到 `package.json` 和 `apps/`），
> 不要只打开 `apps/web` 之类的子目录，否则调试配置和任务都读不到。

打开后如果 Trae 右下角弹出「是否安装推荐扩展」，点安装即可（可选，不影响调试）。

---

## 二、首次准备（只需做一次）

在 Trae 的终端（`` Ctrl+` ``）里执行：

```bash
# 1. 安装依赖（必须带 --ignore-scripts，原因见文末 FAQ-1）
npm install --ignore-scripts

# 2. 准备环境变量
cp .env.example .env
```

如果 `npm install` 报 `Cannot find module @rollup/rollup-win32-x64-msvc` 之类的
optional 依赖缺失错误，在终端执行（Trae 里可以直接跑）：

```bash
mv node_modules .nm_old && rm -f package-lock.json && npm install --ignore-scripts
```

装完可以把 `.nm_old` 删掉。

---

## 三、三种调试场景（按 F5 启动）

按 `Ctrl+Shift+D` 打开左侧「运行和调试」面板，顶部下拉框选择配置，然后按 `F5`。

### ① 调试后端 server（最常用）

选择 **「① 调试后端 server（源码断点）」** → F5。

- 直接在 `apps/server/src/index.ts` 里下断点，命中的是**源码行**，不是编译产物
- 原理：Node 22 原生支持运行 `.ts`（类型剥离），不需要 tsx / ts-node
- 服务地址：`http://localhost:8787`
- 想改代码自动重启，就用 **「①' 调试后端 server（改代码自动重启）」**

验证：终端里出现 `招聘情报后端已启动：http://localhost:8787`。

### ② 调试前端看板 web

选择 **「② 调试前端看板 web（自动开浏览器）」** → F5。

它会自动：
1. 先跑任务「启动前端 dev」（拉起 Vite，`:5173`）
2. 再打开一个受 Trae 控制的 Chrome 窗口

- 在 `apps/web/src/*.tsx` 里下断点即可调试
- 页面里请求 `/api/*` 会被 Vite 自动转发到后端 `:8787`，所以**记得先把后端跑起来**
  （可以再按一次 F5 选配置 ①，Trae 支持同时开多个调试会话）

### ③ 调试浏览器扩展（MV3）

选择 **「③ 调试浏览器扩展（自动开带扩展的 Chrome）」** → F5。

它会自动：
1. 先跑任务「构建扩展」
2. 打开一个**独立配置**的 Chrome，并加载 `招聘agent-build/extension`

调试扩展的要点：

- **service worker（background.js）**：在打开的 Chrome 里按 F12 → **Sources** →
  左侧 `Service Worker` 分组 → 找到 `background.js` 下断点
- **content script（content.js）**：在 BOSS直聘 页面上按 F12 → Sources → `Content scripts`
- 这个调试用 Chrome 用的是**独立用户目录** `.chrome-debug-profile/`，
  第一次打开需要**手动登录一次 BOSS直聘**，之后登录态会保留

> 想用自己常用的 Edge / Chrome（已登录）调试，就别用这个配置——
> 直接 `npm run build` 后手动到 `edge://extensions`（Chrome 用 `chrome://extensions`）→
> 开发人员模式 → 加载解压缩的扩展 → 选 `招聘agent-build/extension`。
>
> 完整步骤（含验证、更新、FAQ）见 **[Edge安装扩展指南.md](./Edge安装扩展指南.md)**。

**扩展相关的命令行自检**：

```bash
npm run verify:ext   # 校验产物完整性，manifest 引用的文件是否都在
npm run test:ext     # 集成测试：自带隔离后端与临时数据目录，跑完自动清理
npm run icons        # 重新生成图标（改了图形才需要）
```

### ④ 挂载到已运行的进程

如果后端已经在终端里跑着，想事后挂调试器：

```bash
node --inspect --experimental-strip-types apps/server/src/index.ts
```

然后按 F5 选 **「④ 把后端调试器挂到已运行的进程」**。

---

## 四、打包（一键构建）

按 **`Ctrl+Shift+B`**，或菜单「终端 → 运行生成任务」，选 **「构建全部」**。

等同于终端里跑：

```bash
npm run build
```

产物会集中输出到**仓库同级**的 `招聘agent-build/`：

```
<项目所在目录>/招聘agent-build/
├── web/          ← 前端静态产物（丢到任意静态服务器即可）
├── server/       ← 后端单文件 index.js（自包含，无需再 npm install）
└── extension/    ← 扩展（Chrome「加载已解压的扩展程序」选这个目录）
```

构建脚本跑完会自动打印产物树和每个文件的大小，方便确认。

### 单独构建某一端

`Ctrl+Shift+P` → 输入 `Run Task` → 选：

| 任务 | 作用 |
|---|---|
| 构建全部 | web + server + extension（默认，Ctrl+Shift+B） |
| 构建扩展 | 只编译浏览器扩展 |
| 构建后端 | 只编译后端 |
| 构建前端 | 只编译前端看板 |
| 生成扩展图标 | 生成 16/32/48/128 图标（改了图形才需要） |
| 校验扩展产物 | 检查 manifest 引用文件 / 权限 / popup 是否齐全 |
| 扩展集成测试 | 驱动真实产物 + 隔离后端，验证采集 / 去重 / 断网不丢 |
| 清理产物 | 清空 `招聘agent-build/` |
| 安装依赖 | `npm install --ignore-scripts` |
| 启动产物（生产模式） | 跑编译后的产物，打开 `http://localhost:8787/` |
| 启动前端 dev | 拉起 Vite（`:5173`） |
| 启动后端 dev | 拉起后端（`:8787`） |

> 产物跑起来之后怎么用、怎么部署到服务器，见 [产物使用说明.md](./产物使用说明.md)。

---

## 五、产物路径怎么改

只用改一个地方——`.env`：

```ini
# 默认：输出到仓库同级的 招聘agent-build/
BUILD_OUT_DIR=../招聘agent-build

# 想改成仓库内的 build/ 就写：
BUILD_OUT_DIR=build
```

改完重新 `Ctrl+Shift+B` 即可。`npm run clean` 会清掉当前配置指向的产物目录。

---

## 六、常见问题

### FAQ-1：为什么 `npm install` 必须加 `--ignore-scripts`？

本机上 esbuild 的安装后脚本会触发 Windows `EBUSY`（进程占用），导致**整个安装回滚**，
接着还会引发 npm 的 optional 依赖老 bug（[npm/cli#4828](https://github.com/npm/cli/issues/4828)），
让 `@rollup/rollup-win32-x64-msvc` 这类平台包丢失，前端构建就会报 `Cannot find module`。

加 `--ignore-scripts` 跳过安装脚本即可，esbuild 的平台二进制由 `@esbuild/win32-x64` 提供，
**功能完全不受影响**。

### FAQ-2：F5 提示「找不到程序」/ 配置不可用

确认打开的是仓库**根目录**，且 `.vscode/launch.json` 存在。
Trae 如果提示 `type: chrome` 的调试器不可用，说明内置 JS 调试器未启用，
在扩展面板搜 `JavaScript Debugger` 确认已启用。

### FAQ-3：端口被占用（8787 / 5173）

```bash
# 查是谁占了 8787
netstat -ano | findstr :8787
# 按 PID 结束（谨慎，确认是自己的 node 进程）
taskkill /PID <PID> /F
```

或者临时改端口：后端 `SERVER_PORT=9000 npm run dev:server`，
前端 `WEB_PORT=5200 npm run dev:web`（前端代理会读 `SERVER_PORT`，记得同步）。

### FAQ-4：改了 `.env` 但没生效

Vite 只在**启动时**读 `.env`，改完要重启 dev 服务（前端在终端按 `Ctrl+C` 再起）。
后端同理。

### FAQ-5：断点没命中 / 停在编译后的代码

- 调试后端请用配置 **①**（跑源码），不要直接对 `招聘agent-build/server/index.js` 下断点
- 调试前端确认 dev 服务已启动（走的是源码 + sourcemap），不要用构建后的 `web/`

---

## 七、一句话速查

| 我想… | 怎么做 |
|---|---|
| 调后端 | `Ctrl+Shift+D` → 选配置① → `F5` |
| 调前端 | 先起后端（配置①），再选配置② → `F5` |
| 调扩展 | 选配置③ → `F5`（首次需登录 BOSS直聘） |
| 打包 | `Ctrl+Shift+B` |
| 单独构建某端 | `Ctrl+Shift+P` → `Run Task` |
| 装依赖 | `npm install --ignore-scripts` |
