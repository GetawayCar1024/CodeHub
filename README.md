# CodeHub

信息学竞赛程序回收系统：选手在浏览器中提交源代码，管理员管理用户与比赛，可与 [LemonServer](https://github.com/GetawayCar1024/LemonServer) 联动评测。

版本 0.1.2 · Node.js ≥ 22.2，无第三方依赖。

## 安装

从 [Releases](https://github.com/GetawayCar1024/CodeHub/releases) 下载（已内置 Node.js，无需另外安装）：

- **Windows**：`CodeHub-<版本>-windows-x64.zip`，解压后双击 `start.bat`，数据在同目录的 `data` 中。
- **Linux**：`CodeHub-<版本>-linux-x64.tar.gz`，解压后运行 `./codehub`，数据在同目录的 `data` 中。
- **Ubuntu / Debian**：`sudo apt install ./codehub_<版本>_amd64.deb`，然后 `sudo systemctl enable --now codehub`（数据在 `/var/lib/codehub`）；也可以在终端运行 `codehub`（数据在 `~/.local/share/codehub`）。

默认端口 8088，浏览器打开 `http://<本机 IP>:8088/`。

## 从源码运行

```bash
node server.js                      # 默认 http://0.0.0.0:8088/，数据在 ./data
node server.js --port 80 --data D:\CodeHubData
node server.js --reset-admin        # 管理员密码重置为 123456
```

Windows 下也可以双击 `start.bat`。

首次启动会创建管理员账号 **admin / 123456**，登录后请在右上角菜单中修改密码。

## 功能

**选手**

- 登录（上传了考生手册时，需勾选“已阅读考生手册”）。
- 比赛列表：只显示当前的比赛（从“提前进入”时间到比赛结束），且只显示自己所在分组可参加的比赛。
- 比赛页：考试信息与倒计时、下载考生手册 / 试题包（提前进入后即可下载）、试题包密码（开始后显示）、每道题一个卡片（绿色 = 已提交，显示提交时间、语言、代码长度）。
- 提交代码（C++）：可粘贴或从文件读取，比赛期间可无限次提交，以最后一次为准；查看已提交的代码。
- 提前结束比赛：比赛进行中可在比赛页点“提前结束比赛”，之后不能再提交，但到比赛结束前仍可进入比赛页、下载文件、查看已提交的代码。
- 修改密码：右上角菜单（至少 6 位，其他设备上的登录会退出）。

**管理员**

- 用户：批量导入（`用户名,密码[,真实姓名[,分组;分组]]`，真实姓名为空则同用户名；已存在的用户可跳过或覆盖）、编辑姓名 / 密码 / 分组、批量加入或移出分组、删除、导出 CSV。
- 分组：新建、重命名、删除。
- 比赛：比赛名（即文件夹名）、标题、开始与结束时间（必填）、提前进入时间（默认 30 分钟）、题目列表、可参加的分组（不选则所有用户）、down.zip 与解压密码（可不设置）、是否启用子文件夹。
- 提交概况：每名选手每道题的代码长度；关联 LemonServer 后还显示是否已评测、得分与总分，并提供评测结果链接。比赛中与赛后看到的一样，随时可查看代码、下载全部代码（zip）。“提前结束”一列显示选手结束比赛的时间，可撤销（选手误点时恢复提交）。
- 设置：站点名称、代码长度上限、存储位置、考生手册、LemonServer 接入、管理员密码。
- 浅色 / 深色 / 跟随系统。

## 存储结构

```
<存储位置>/<比赛名>/<选手用户名>/<题目名>.cpp                 # 不启用子文件夹
<存储位置>/<比赛名>/<选手用户名>/<题目名>/<题目名>.cpp        # 启用子文件夹
```

与 LemonServer（LemonLime）的 `source/` 结构一致。存储位置默认为 `<数据目录>/submissions`，修改后已有代码会一并移动。已有提交的比赛不能再切换子文件夹设置。

其余数据（用户、比赛、提交记录）保存在 `<数据目录>/codehub.json`，试题包与考生手册在 `<数据目录>/files/`。

## 与 LemonServer 联动

1. 在 LemonServer 网页“设置 → 令牌与 API Key”中创建一个 API Key。
2. CodeHub“设置 → LemonServer”中填写 API 地址（如 `http://127.0.0.1:8080`）与 API Key，点“测试连接”。网页地址只用于结果链接，浏览器访问地址不同时再填。
3. 编辑比赛：
   - “从 LemonServer 导入”：一键导入该比赛的试题作为题目，并可同时导入 down.zip；或者选择“关联比赛”/“新建同名”。比赛可以先设置好，之后再关联。
   - 评测方式：
     - **赛后统一**：比赛结束后评测；
     - **每次提交**：每有新提交就执行一次任务；
     - **定时**：每 x 分钟执行一次，从 max(比赛开始时间, 关联时间) 起算。

关联后：

- 选手的每次提交都会上传到 LemonServer 比赛的 `source/` 中（失败会自动重试）。LemonServer 收到新代码后会把对应格子标为未评测，所以重新提交的代码在下一次任务中一定会重新评测。
- 一次“任务”= 上传未同步的代码 → 在 LemonServer 的评测队列中加入“评测**未评测**的代码”（开始时先刷新选手）→ 等待它完成。该比赛上一次的评测还没完成（包括在 LemonServer 上手动发起的）时，本次跳过；LemonServer 正在评测其他比赛时，本次排队等待。需要 LemonServer ≥ 0.1.6。
- 比赛结束后，等最后一次任务结束，再执行一次任务评测未评测的代码。
- 比赛时间只在 CodeHub 中设置（LemonServer 没有比赛时间，成绩与评测详情任何时候都能看到）：它决定选手何时能进入和提交、定时评测从何时算起、何时执行赛后评测。

## 测试

```bash
node tests/smoke.mjs                                          # 只测 CodeHub
node tests/smoke.mjs http://127.0.0.1:18080 D:\tmp\contests   # 连同 LemonServer（新配置、令牌 123456、需要 g++）
```

## 代码结构

- `server.js`：启动参数。
- `src/app.js`：HTTP 服务、会话、静态文件；`src/routes-user.js`：选手接口；`src/routes-admin.js`：管理接口。
- `src/lemon.js`：LemonServer 客户端与联动调度（上传、评测任务）。
- `src/store.js`：JSON 数据文件；`src/zip.js`：打包下载。
- `public/`：网页前端（原生 JS，无需构建）。
- `packaging/`：发布包（`node packaging/package.mjs windows|linux`，`packaging/linux/build-deb.sh`）；推送 `v*` 标签后由 GitHub Actions 构建并发布。
