// ============================================================
// 生成「便携包」—— 目标电脑除浏览器外什么都没有时用它
// ------------------------------------------------------------
// 为什么需要这个脚本：后端是 Node 程序，目标机没有 Node 就跑不起来。
// 便携包把 **Node 运行时一起打包**，于是目标机零安装、零联网、
// 不需要管理员权限，解压双击即可。
//
// 用法：
//   npm run portable              # 组装便携包 + 打 zip
//   npm run portable -- --no-zip  # 只组装，不打 zip
//
// 产物（都在仓库同级，与源码/数据物理隔离）：
//   招聘agent-portable/                     解压即可直接用的形态
//   招聘agent-便携版-v<版本>.zip            拷 U 盘 / 网盘用
//
// ★ 编码是有讲究的，别随手改（踩过坑，见 .workbuddy/memory/PROJECT-MEMORY.md §11.5）★
//   .bat  必须是**纯 ASCII**：cmd 按字节偏移 + 当前控制台代码页逐行读批处理文件，
//         文件里有非 ASCII 字节时行边界会错乱（整段命令被跳过 / 跳到错误标签），
//         而且完全不报错。中文说明一律放到 .txt（UTF-8+BOM）和 .vbs（UTF-16LE+BOM），
//         这两种文件的编码由各自宿主解析，不受控制台代码页影响。
//   纯 ASCII 之后再加 chcp 65001 是安全的（所有字节 <128），正好让 Node 输出的
//   UTF-8 中文日志不花屏。
// ============================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadEnv, repoRoot, resolveOutDir } from './load-env.mjs'

loadEnv()

const args = process.argv.slice(2)
const WANT_ZIP = !args.includes('--no-zip')

const buildDir = resolveOutDir()
const portableDir = path.resolve(repoRoot, '..', process.env.PORTABLE_OUT_DIR || '招聘agent-portable')

const EXT_VERSION = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'apps/extension/manifest.json'), 'utf8')
).version

// ------------------------------------------------------------ 前置检查

const serverEntry = path.join(buildDir, 'server', 'index.js')
const webIndex = path.join(buildDir, 'web', 'index.html')
const extManifest = path.join(buildDir, 'extension', 'manifest.json')

for (const [label, p] of [
  ['后端产物', serverEntry],
  ['前端产物', webIndex],
  ['扩展产物', extManifest],
]) {
  if (!fs.existsSync(p)) {
    console.error(`\n✗ 找不到${label}：${p}\n  请先执行： npm run build\n`)
    process.exit(1)
  }
}

const builtExtVersion = JSON.parse(fs.readFileSync(extManifest, 'utf8')).version
if (builtExtVersion !== EXT_VERSION) {
  console.error(
    `\n✗ 产物里的扩展版本（${builtExtVersion}）与源码（${EXT_VERSION}）不一致。\n` +
      `  产物是旧的，请重新 npm run build 再打包。\n`
  )
  process.exit(1)
}

// Node 运行时：直接复用当前这台机器上的 node.exe
const nodeExeSrc = process.execPath
if (!/\.exe$/i.test(nodeExeSrc)) {
  console.error(`\n✗ 当前 node 不是 Windows 可执行文件（${nodeExeSrc}），无法打包给 Windows 用。\n`)
  process.exit(1)
}

// ------------------------------------------------------------ 编码小工具

/** 纯 ASCII —— .bat / .env 必须用这个 */
const writeAscii = (file, text) => fs.writeFileSync(file, Buffer.from(text, 'ascii'))
/** UTF-8 带 BOM —— .txt（记事本双击要正确显示中文） */
const writeUtf8Bom = (file, text) => fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))
/** UTF-16LE 带 BOM —— .vbs（WSH 对中文支持最稳） */
const writeUtf16 = (file, text) => fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))

const copyDir = (from, to, skipExt = []) => {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name)
    const dst = path.join(to, e.name)
    if (e.isDirectory()) copyDir(src, dst, skipExt)
    else if (!skipExt.includes(path.extname(e.name))) fs.copyFileSync(src, dst)
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

// ------------------------------------------------------------ 组装

console.log('=== 生成便携包 ===')
console.log(`产物来源：${buildDir}`)
console.log(`输出去向：${portableDir}\n`)

if (fs.existsSync(portableDir)) fs.rmSync(portableDir, { recursive: true, force: true })
fs.mkdirSync(portableDir, { recursive: true })

// 1) 捆绑 Node 运行时（Windows 官方发行是单文件，不需要额外 DLL）
fs.mkdirSync(path.join(portableDir, 'node'), { recursive: true })
fs.copyFileSync(nodeExeSrc, path.join(portableDir, 'node', 'node.exe'))
console.log(`  node\\node.exe        ${mb(fs.statSync(path.join(portableDir, 'node', 'node.exe')).size)}  (${process.version})`)

// 2) 后端（丢掉 .map）
fs.mkdirSync(path.join(portableDir, 'server'), { recursive: true })
fs.copyFileSync(serverEntry, path.join(portableDir, 'server', 'index.js'))
console.log(`  server\\index.js     ${mb(fs.statSync(path.join(portableDir, 'server', 'index.js')).size)}`)

// 3) 前端（丢掉 .map）
copyDir(path.join(buildDir, 'web'), path.join(portableDir, 'web'), ['.map'])
console.log('  web\\                看板静态产物')

// 4) 扩展（保留 .map，方便在目标机上排查）
copyDir(path.join(buildDir, 'extension'), path.join(portableDir, 'extension'))
console.log(`  extension\\          扩展产物 v${builtExtVersion}`)

// 5) 数据目录留空 —— 首启自动灌示例数据。
//    刻意不带真实简历：这个包要过 U 盘、可能经别人手。
fs.mkdirSync(path.join(portableDir, 'data'), { recursive: true })
fs.writeFileSync(path.join(portableDir, 'data', '.keep'), '')
console.log('  data\\               空（首次启动自动灌入示例数据，不含任何真实简历）')

// 6) .env（纯 ASCII）。放在包根，服务端的 findEnvFile 从 server\ 向上找就会命中；
//    DATA_DIR 是相对路径、基准是 .env 所在目录，所以数据落在包内。
writeAscii(
  path.join(portableDir, '.env'),
  `# Portable package config. Restart the board after editing.
# (Chinese notes: see the .txt file in this folder.)

# Data folder, relative to THIS file (= the package root).
DATA_DIR=data

# Board port.
# NOTE: the extension's backend URL is baked in at BUILD time as
# http://localhost:8787 . If you change the port here, the extension will no
# longer find the backend unless you rebuild the extension from source.
SERVER_PORT=${process.env.SERVER_PORT || '8787'}

# Seed 22 fictional sample resumes when the data folder is empty (0 = off).
SEED_ON_EMPTY=1
`
)

// 7) 启动器 —— .bat 纯 ASCII，中文只出现在 .vbs / .txt 里
//
// 为什么单独有这么一个「后台」.bat：
//   .vbs 需要**隐藏运行**服务，并且把输出落进日志文件。
//   一开始我把重定向直接写在 .vbs 里，那需要四层嵌套引号
//   （`cmd /c "node.exe "server.js" > "log" 2>&1"`），极易写错 ——
//   而写错的后果是**默认启动器完全失效**，比没日志严重得多。
//   所以把重定向这一步交给 .bat（它天生就懂 `>`），.vbs 只负责隐藏调用它，
//   引号只剩一层。ASCII-only 的规则同其它 .bat。
writeAscii(
  path.join(portableDir, '启动看板-后台.bat'),
  `@echo off
rem Hidden/background launcher: runs the board and redirects its output into a
rem log file, so a silent startup failure still leaves evidence behind.
rem
rem Pure-ASCII on purpose: cmd parses .bat files byte-wise using the active
rem console code page, so non-ASCII bytes in here can desync line parsing.
rem That is also why the log file name arrives as %1 -- the .vbs passes it in
rem (a .vbs is UTF-16 and can safely hold a Chinese name). Run this file
rem directly and it falls back to an ASCII name.
rem
rem No "chcp" here: output is redirected to a file, and redirection is byte
rem level -- the code page only affects how a console renders bytes.
cd /d "%~dp0"
set "LOG=%~1"
if "%LOG%"=="" set "LOG=startup-log.txt"
"node\\node.exe" "server\\index.js" > "%LOG%" 2>&1
`
)

writeAscii(
  path.join(portableDir, '启动看板-带日志.bat'),
  `@echo off
rem Pure-ASCII launcher on purpose: cmd parses .bat files byte-wise using the
rem active console code page, so non-ASCII text here can desync line parsing.
rem chcp 65001 is safe now (all bytes < 128) and makes the UTF-8 log readable.
chcp 65001 >nul
cd /d "%~dp0"
title Resume Catcher - board (log mode)

if not exist "node\\node.exe"   goto missing
if not exist "server\\index.js" goto missing

echo ============================================================
echo   Resume Catcher - starting the board (LOG MODE)
echo ============================================================
echo.
echo   Board URL : http://localhost:${process.env.SERVER_PORT || '8787'}/
echo   Data dir  : %~dp0data
echo   To stop   : close this window, or run the "stop" .bat
echo.
echo   The browser opens in about 3 seconds.
echo   Chinese notes: see the .txt file in this folder.
echo ============================================================
echo.
echo --- server log ---------------------------------------------
echo.

start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:${process.env.SERVER_PORT || '8787'}/"

"node\\node.exe" "server\\index.js"

echo.
echo --- server exited ------------------------------------------
echo.
echo If you saw Error / EADDRINUSE above, copy that text for help.
echo.
pause
exit /b 0

:missing
echo.
echo [ERROR] Incomplete package:
echo         node\\node.exe or server\\index.js was not found.
echo         Please extract a complete copy of this package.
echo.
pause
exit /b 1
`
)

writeAscii(
  path.join(portableDir, '停止看板.bat'),
  `@echo off
title Resume Catcher - stop board

echo ============================================================
echo   Stopping the board service (port ${process.env.SERVER_PORT || '8787'})
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort ${process.env.SERVER_PORT || '8787'} -State Listen -ErrorAction SilentlyContinue; if($c){$c|Select-Object -ExpandProperty OwningProcess -Unique|ForEach-Object{Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; Write-Host ('  stopped PID '+$_)}}else{Write-Host '  no service is listening'}"

echo.
echo Done. Your data in the "data" folder is untouched.
echo.
timeout /t 5 >nul
`
)

// 8) 一键启动（.vbs，UTF-16）。会轮询等端口真的监听上再开浏览器 ——
//    直接 start 浏览器会和服务的启动赛跑，开出「无法连接」的页面。
writeUtf16(
  path.join(portableDir, '启动看板.vbs'),
  `Option Explicit

' ============================================================
'  招聘情报看台 · 启动器（后台静默运行 + 自动打开浏览器）
'  找不到文件 / 端口起不来时会给出提示，并引导去看日志启动方式。
' ============================================================

Dim sh, fso, base, nodeExe, serverJs, ex, out, i, listening, logFile, backgroundBat

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base     = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe  = base & "\\node\\node.exe"
serverJs = base & "\\server\\index.js"

If Not fso.FileExists(nodeExe) Then
  MsgBox "找不到 node\\node.exe。" & vbCrLf & vbCrLf & _
         "便携包不完整，请重新解压一份完整的包。", 16, "招聘情报看台"
  WScript.Quit 1
End If

If Not fso.FileExists(serverJs) Then
  MsgBox "找不到 server\\index.js。" & vbCrLf & vbCrLf & _
         "便携包不完整，请重新解压一份完整的包。", 16, "招聘情报看台"
  WScript.Quit 1
End If

sh.CurrentDirectory = base

' 0 = 隐藏窗口，False = 不等它结束
'
' 调「启动看板-后台.bat」而不是直接跑 node.exe：重定向交给 .bat 做，
' 这里只需要把日志路径当参数传进去 —— 嵌套引号写错会让默认启动器彻底失效，风险太高。
' 之所以由 .vbs 传日志名：.bat 必须纯 ASCII（中文会破坏 cmd 的按字节解析），
' 而 .vbs 是 UTF-16，可以安全地拿中文文件名。
'
' 找不到那个 .bat 时（用户只拷了部分文件）退回直接启动：宁可没日志，也不能起不来。
logFile  = base & "\\启动日志.txt"
backgroundBat = base & "\\启动看板-后台.bat"
If fso.FileExists(backgroundBat) Then
  sh.Run """" & backgroundBat & """" & " " & """" & logFile & """", 0, False
Else
  sh.Run """" & nodeExe & """ """ & serverJs & """", 0, False
End If

' 等端口真正开始监听（最多 6 秒），避免浏览器比服务先打开
listening = False
For i = 1 To 12
  WScript.Sleep 500
  On Error Resume Next
  Set ex = sh.Exec("cmd /c netstat -ano -p tcp | findstr LISTENING | findstr ${process.env.SERVER_PORT || '8787'}")
  out = ""
  If Not ex Is Nothing Then out = ex.StdOut.ReadAll()
  On Error GoTo 0
  If Len(Trim(out)) > 0 Then
    listening = True
    Exit For
  End If
Next

If listening Then
  sh.Run "http://localhost:${process.env.SERVER_PORT || '8787'}/", 1, False
Else
  MsgBox "看板服务没能起来（等了 6 秒）。" & vbCrLf & vbCrLf & _
         "服务端的报错已经写进本文件夹的「启动日志.txt」，" & vbCrLf & _
         "里面通常有一行以 Error 开头，那一行就是原因。" & vbCrLf & vbCrLf & _
         "最常见的原因：" & vbCrLf & _
         "  · ${process.env.SERVER_PORT || '8787'} 端口被别的程序占用了" & vbCrLf & _
         "  · 本文件夹不可写（data 目录写不进去，常见于杀毒软件拦截、" & vbCrLf & _
         "    或从压缩包解压时带上了只读属性）" & vbCrLf & _
         "  · 杀毒软件拦截了包里的 node.exe" & vbCrLf & vbCrLf & _
         "下一步：双击「启动看板-带日志.bat」，它会直接在屏幕上显示原因；" & vbCrLf & _
         "或者打开「启动日志.txt」把最后几行发给我。", _
         48, "招聘情报看台 · 启动失败"
End If
`
)

// 9) 中文说明书（UTF-8+BOM，记事本双击即可）
writeUtf8Bom(
  path.join(portableDir, `使用说明.txt`),
  `招聘情报看台 · 便携版   v${builtExtVersion}
================================================================

【这是什么】
一个「采集简历 → 本地归档 → 网页看板汇总」的小工作台。
整个包自带运行环境：目标电脑什么都不用装 ——
不用 Node、不用 npm、不用数据库、不用从扩展商店装任何东西。

【需要什么】
  · 64 位 Windows（Win10 / Win11 都行）
  · 一个 Chromium 内核浏览器：Microsoft Edge（系统自带）或 Chrome
  · 就这些。不需要联网，不需要管理员权限。
  · ⚠️ 不适用于 32 位系统；包里的 Node 是 Windows x64 版。

【第一次使用：3 步】

  第 1 步 · 启动看板
      双击            启动看板.vbs
      —— 没有任何窗口弹出来是正常的，它故意在后台静默运行
      —— 约 2~3 秒后浏览器会自动打开 http://localhost:${process.env.SERVER_PORT || '8787'}/
      —— 首次启动会自动灌入 22 份「示例简历」，看板不会是空的

  第 2 步 · 安装浏览器扩展
      1) 地址栏输入        edge://extensions      （Chrome 用 chrome://extensions）
      2) 打开左下角的     「开发人员模式」开关
      3) 点「加载解压缩的扩展」，选择本文件夹里的     extension     文件夹
         ⚠️ 要选「包含 manifest.json 的那一层」文件夹，不要选里面的文件
      4) 点地址栏右边的拼图图标 → 给「招聘捕手」点图钉固定

  第 3 步 · 验证
      点一下工具栏上的「招聘捕手」图标，面板顶部应该显示：
          绿点   后端已连接 · http://localhost:${process.env.SERVER_PORT || '8787'}
      如果显示红点，说明第 1 步的看板没在运行。

【日常怎么用】
  · 让看板在后台跑着就行（关机就没了，下次开机再双击一次）
  · 想开机自动启动：右键「启动看板.vbs」→ 创建快捷方式 →
    按 Win+R 输入 shell:startup → 把快捷方式拖进那个文件夹
  · 在 Edge 里正常登录 BOSS直聘 / 猎聘，打开简历页
  · 扩展默认是「保存前询问」：页面右下角弹卡片问你要不要存
        想改回全自动  → 点扩展图标 → 顶部选「自动」
        想彻底不采集  → 选「关闭」

【看板上能做什么】（地址栏打开 http://localhost:${process.env.SERVER_PORT || '8787'}/）
  左侧有 7 个入口，最常用的四个：

  ▸ 岗位管理（第一次用建议先做这个）
      自己加岗位、填 JD。采集到的简历会按 JD 自动匹配到岗位。
      有候选人的岗位只能「停用」不能删（删了会让匹配变成孤儿数据）。

  ▸ 候选人库
      · 点某位候选人 → 右侧详情：基本信息（含**学历性质：统招/非统招**、院校层次、语言）
        / 技能标签 / 各岗位匹配度与命中点 / 简历原文
      · 在这里直接改招聘进度（待沟通 → 已沟通 → 筛选 → 面试 → Offer → 入职）
      · 顶部「导出 Excel」：把**当前筛选出来的全部人**导成一份真正的 .xlsx
        （文件名形如「项目经理_2026-10-05_推荐名单.xlsx」；冻结表头 + 自动筛选，
        年龄/工作年限是数字列可以直接排序；可选「精简 14 列 / 完整 25 列」）
      · 勾选多人 → 「删除选中」；单个候选人右上角也有「删除」
        删除时会问你要不要「不再采集此人」——**建议勾上**，
        否则以后又打开他的简历会被重新采回来

  ▸ 导出 PDF 给业务部门（要发给人看的时候用）
      · 候选人详情右上「导出 PDF」→ 生成一份参照猎聘排版的正式简历页，
        浏览器会弹出打印对话框，在里面选「另存为 PDF」即可
      · 页眉带姓名 + 应聘岗位 + 匹配度，页脚带来源链接与采集时间
      · 岗位漏斗 / 岗位管理页上的「导出候选人 PDF」= 把**该岗位下全部候选人**
        合成一个多页 PDF（这就是「分岗位给业务部门」最快的做法）
      ⚠️ 导出的是**在线简历文本**排的 PDF，不是候选人上传的附件原件
        （附件要向 TA 索要才能看），页脚有说明

  ▸ 岗位漏斗 / 每日简报 / 待办中心
      每个岗位卡在哪一环、今天该联系谁、哪些流程卡住了

【停止看板】
  双击     停止看板.bat

【数据在哪 / 怎么备份 / 怎么重置】
  · 全部数据就在本文件夹的    data    子文件夹里（几个 .json 文件，可以直接打开看）
  · 备份 = 把整个 data 文件夹复制走
  · 重置 = 删掉 data 文件夹再启动，会重新变成 22 份示例数据
           ⚠️ 会一并清掉你采集的真实简历

【常见问题】

  Q: 双击「启动看板.vbs」没反应？
     → 可能它已经在运行了。先双击「停止看板.bat」，再重新双击启动。
     → 想看看到底发生了什么：改双击「启动看板-带日志.bat」，会显示控制台输出。
     → 也可以打开本文件夹的「启动日志.txt」看最后几行。

  Q: ★ 我想用新版本的包直接替换掉旧的，我采的简历会不会丢？
     先确认一件事：**你的数据到底在哪个文件夹**（看板左下角就写着「数据目录 …」，
     鼠标悬浮能看到完整路径；或者看包里的「启动日志.txt」，有一行「数据目录：…」）。

     两种情况，处理方式完全不同：

     A) 显示的是**包内**的 data 文件夹（…\\招聘agent-portable\\data）
        → 数据就在包里。**直接删掉或覆盖这个文件夹 = 简历全没。**
          换包前必须先备份：把整个 data 文件夹复制到别处（比如桌面）。

     B) 显示的是**用户目录**（…\\AppData\\Local\\招聘agent-data）
        → 数据在包外面，**替换包不会动它**，放心换。
          但记住：以后要备份或搬去别的电脑，搬的是这个目录，不是包。

     ⚠️ 最容易踩的坑：原来是 B（包内目录写不进去，程序才退到用户目录），
        换了新包之后包内目录恰好变得可写了 → 程序会切回包内的空目录，
        看板上于是「简历全没了」（其实一条都没丢，只是没在用）。
        新版在启动时会主动提示「另一处还有 N 份简历，但当前没在用」，
        并给出两条找回办法，照着做即可。

     换包的**安全流程**（四步）：
        1) 双击「停止看板.bat」停掉服务
        2) 按上面 A / B 的判断，把数据目录整个复制一份到别处做备份
        3) 用新包替换旧文件夹
        4) 启动看板，确认左下角「数据目录」和「库内 N 人」与换之前一致

  Q: ★ 启动报错，日志里出现  EPERM: operation not permitted  或  EACCES？
     （实测在另一台电脑上遇到过：跑在 D:\\招聘agent-portable，写 data 目录被拒）

     **先说结论：新版会自动处理这种情况，看板照常能用。**
     程序启动时会先试写一下 data 目录；写不进去就自动把数据改存到
         C:\\Users\\<你的用户名>\\AppData\\Local\\招聘agent-data
     并把「原本想用的目录」和「现在实际使用」两个路径都打印出来
     （屏幕上和「启动日志.txt」里都有）。

     ⚠️ 但这种情况下**数据不在包文件夹里**了 ——
        所以「把整个包拷到别的电脑」不会把简历带走。
        要备份或搬运的是上面那个「现在实际使用」的目录。

     想让数据回到包内目录（这样整包拷走就带上数据），按顺序试：

     1) 先确认没有旧实例占着文件
        双击「停止看板.bat」，再重新启动。

     2) 解压时带上了「只读」属性
        · 在本文件夹上右键 → 属性 → 取消勾选「只读」→
          确定时选「应用到子文件夹」
        · 或者在本文件夹开命令行执行：
              attrib -R "本文件夹完整路径\\*" /S /D

     3) 把整个文件夹**换个位置**（如果上面两步没用，这步最有效）
        · 移到  C:\\Users\\<你的用户名>\\  下面，比如
              C:\\Users\\你的名字\\招聘agent-portable
        · 别放在 C:\\Program Files 这类受保护目录，
          也别放在只读介质（光盘镜像 / 写了保护的 U 盘）上。

     4) 杀毒软件 / Windows 的「受控文件夹访问」拦住了写入
        · 把这个文件夹加入杀毒软件的白名单；
        · 或「Windows 安全中心 → 病毒和威胁防护 → 勒索软件防护 →
          受控文件夹访问」里，把包里的 node.exe 加进去放行。

     5) 怎么看是哪种？
        在本文件夹开命令行（地址栏输入 cmd 回车），粘贴执行：

            echo test > data\\writetest.txt

        · 成功 → 说明能写，是别的原因（把「启动日志.txt」发我）
        · 报「拒绝访问」→ 就是 2) 或 4)

  Q: 出现蓝色警告框 /「Windows 已保护你的电脑」？
     → 包里的 node.exe 是未签名的官方运行时，加上 .vbs 启动脚本，
       可能触发 SmartScreen。点「更多信息」→「仍要运行」即可。
     → 如果杀毒软件报毒：把本文件夹加入信任/白名单。
       这个包不会往任何外部服务器上传东西，只监听本机 ${process.env.SERVER_PORT || '8787'} 端口。

  Q: 扩展图标显示红点 /「后端未响应」？
     → 看板没启动：双击「启动看板.vbs」。
     → 或端口被别的程序占了：双击「启动看板-带日志.bat」看报错。
       查占用：命令行执行   netstat -ano | findstr :${process.env.SERVER_PORT || '8787'}

  Q: 想换看板端口 / 换了扩展代码？
     → 扩展里的后端地址是**构建时写死的**。
       要换端口必须回到源码仓库：改 .env 里的 SERVER_PORT 与 VITE_API_BASE，
       重新 npm run build，重新生成便携包，再把扩展装一遍。
       光改本包的 .env 是不够的（扩展那边不会跟着变）。

  Q: 卸载扩展会丢什么？
     → 会清掉扩展自己的「本地待上传队列」（还没同步到看板的几份）。
       看板数据在 data 文件夹里，不受影响。

【★ 重要：两台电脑的数据是各自独立的】
  本包是「单机版」：每台电脑各自采集、各自存储，**不会自动互相同步**。
  也就是说，A 电脑采的简历，B 电脑的看板上看不到。

  ▸ 如果你要的就是「各管各的」 → 什么都不用做，把这个包复制一份到另一台即可。

  ▸ 如果你想让两台电脑**共用同一份数据** → 不要各装一份便携包，改用
    「一台跑服务、另一台当客户端」的方式，见下面【方案B】。

【方案B：两台电脑共用一份数据（局域网）】
  适用：两台电脑在同一个局域网 / 同一个 WiFi 下，其中一台常开。

  1) 在「主机」（数据要存的那台）上正常跑服务（便携包或源码都行）。
     服务已经监听 0.0.0.0，不需要额外配置。
  2) 查主机内网 IP：命令行执行   ipconfig      找到「IPv4 地址」，例如 192.168.1.6
  3) 在「客户端」那台电脑上打开  http://192.168.1.6:${process.env.SERVER_PORT || '8787'}/
     —— 看板能打开就说明网络通了。
  4) 扩展那一端需要重新构建：把 .env 里的 VITE_API_BASE 改成
     http://192.168.1.6:${process.env.SERVER_PORT || '8787'} ，**并且**把该地址加进
     apps/extension/manifest.json 的 host_permissions（否则浏览器会拦掉上报），
     然后 npm run build，再把扩展装到客户端电脑上。
     ⚠️ 扩展只能往 host_permissions 里声明过的地址发数据 —— 这是浏览器的硬规则。
     ⚠️ 建议给主机配一个固定的内网 IP，否则路由器重新分配 IP 后扩展就连不上了。

  权衡：好处是数据只有一份、两边都看得到同一批人；
        代价是主机必须开着，且扩展要按 IP 重新构建。

【这个包里各是什么】
  node\\node.exe        捆绑的 Node 运行时（就是它让目标电脑免安装）
  server\\index.js      后端服务（自包含单文件，含全部依赖）
  web\\                 看板前端静态文件
  extension\\           浏览器扩展（「加载解压缩的扩展」选它）
  data\\                你的数据（现在是空的，首次启动会自动灌示例数据）
  .env                 端口 / 数据目录配置
  启动看板.vbs          后台静默启动并打开浏览器（推荐日常用）
                        服务端输出会写进「启动日志.txt」
  启动看板-带日志.bat    带控制台输出的启动方式（排查问题用）
  停止看板.bat          停止服务

【更新到新版本】
  回源码仓库 npm run build && npm run portable，再把新生成的包整体拷过来。
  只覆盖 server\\ / web\\ / extension\\ 也行，但 data\\ 是你的数据，别覆盖。
`
)

// ------------------------------------------------------------ 自检

const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else files.push(p)
  }
}
walk(portableDir)

let problems = 0
for (const f of files) {
  const ext = path.extname(f).toLowerCase()
  const buf = fs.readFileSync(f)
  const nonAscii = buf.filter((b) => b > 127).length

  if (ext === '.bat' || ext === '.env' || f.endsWith('.keep')) {
    if (nonAscii > 0) {
      problems++
      console.error(`  ✗ ${path.relative(portableDir, f)} 含 ${nonAscii} 个非 ASCII 字节（.bat/.env 必须纯 ASCII）`)
    }
  }
  if (ext === '.vbs') {
    const bomOk = buf[0] === 0xff && buf[1] === 0xfe
    if (!bomOk) {
      problems++
      console.error(`  ✗ ${path.relative(portableDir, f)} 缺少 UTF-16LE BOM（WSH 会读错中文）`)
    }
    // ---- 变量声明自检
    // 这些 .vbs 都带 `Option Explicit`，**用到没声明的变量会直接运行时错误**，
    // 而默认启动方式（双击 .vbs）是隐藏运行的 —— 用户只会看到「没反应」。
    // 真实踩过：给 .vbs 加日志功能时新用了 logFile / backgroundBat 但忘了加进 Dim，
    // 结果默认启动器彻底失效。只有「真的把 .vbs 跑一遍」才暴露出来。
    // 这里做一道静态兜底：所有被赋值的变量都必须在 Dim 行里出现过。
    const src = buf.toString('utf16le')
    const dimLine = /^\s*Dim\s+(.+)$/im.exec(src)
    const declared = new Set(
      (dimLine?.[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    const assigned = new Set()
    for (const m of src.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)) assigned.add(m[1])
    for (const m of src.matchAll(/^\s*Set\s+([A-Za-z_]\w*)\s*=/gim)) assigned.add(m[1])
    for (const m of src.matchAll(/^\s*For\s+([A-Za-z_]\w*)\s*=/gim)) assigned.add(m[1])
    const undeclared = [...assigned].filter((v) => !declared.has(v))
    if (undeclared.length > 0) {
      problems++
      console.error(
        `  ✗ ${path.relative(portableDir, f)} 用了未声明的变量：${undeclared.join(', ')}` +
          `（Option Explicit 下会运行时错误，必须加进 Dim）`
      )
    }
  }
  if (ext === '.txt') {
    const bomOk = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    if (!bomOk) {
      problems++
      console.error(`  ✗ ${path.relative(portableDir, f)} 缺少 UTF-8 BOM（记事本可能显示乱码）`)
    }
  }
}

const totalBytes = files.reduce((s, f) => s + fs.statSync(f).size, 0)
console.log(`\n  编码自检：${problems === 0 ? '✓ 全部通过' : `✗ ${problems} 处问题`}`)
console.log(`  合计：${files.length} 个文件 · ${mb(totalBytes)}`)

if (problems > 0) {
  console.error('\n✗ 编码自检未通过，已中止。')
  process.exit(1)
}

// ------------------------------------------------------------ 打 zip

if (WANT_ZIP) {
  const zipName = `招聘agent-便携版-v${builtExtVersion}.zip`
  const zipPath = path.resolve(repoRoot, '..', zipName)
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true })

  const baseName = path.basename(portableDir)
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(`,
    `'${portableDir.replace(/'/g, "''")}',`,
    `'${zipPath.replace(/'/g, "''")}',`,
    `[System.IO.Compression.CompressionLevel]::Optimal, $true)`,
  ].join(' ')

  console.log(`\n  压缩中（${mb(totalBytes)}，多数是 node.exe）…`)
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { stdio: 'inherit' }
  )
  console.log(`\n✓ 便携包已生成`)
  console.log(`  目录：${portableDir}   (${mb(totalBytes)}，解压即可直接用)`)
  console.log(`  zip ：${zipPath}   (${mb(fs.statSync(zipPath).size)}，解压出 "${baseName}/")`)
} else {
  console.log(`\n✓ 便携包已生成（未打 zip）`)
  console.log(`  目录：${portableDir}   (${mb(totalBytes)})`)
}

console.log(`
给目标电脑的用法（三句话）：
  1. 把上面的 zip 拷过去解压（文件夹名随便改，不影响运行）
  2. 双击「启动看板.vbs」→ 浏览器自动打开 http://localhost:${process.env.SERVER_PORT || '8787'}/
  3. 在 edge://extensions 打开开发人员模式 →「加载解压缩的扩展」→ 选包里的 extension 文件夹
`)
