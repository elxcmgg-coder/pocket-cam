# PocketCam

把 **iPhone 前置摄像头**通过局域网送到 **Windows PC**，再通过 **OBS Virtual Camera** 在会议软件中使用。

```text
iPhone Safari（前置摄像头，无音频）
        │ WebRTC 视频，同一局域网
        ▼
PC Chrome / Edge（PocketCam 接收页面）
        │ OBS 窗口采集
        ▼
OBS Virtual Camera → 会议软件的摄像头选择
```

这是可自行运行的源码项目，**需要 OBS 才会出现 Windows 虚拟摄像头设备**。PocketCam 本身不安装 Windows 摄像头驱动。它不会接入飞书考勤、虚拟定位或打卡验证。当前没有音频传输，会议麦克风使用 PC 自己的设备。

## 1. 准备

- Windows PC：[Node.js](https://nodejs.org/) 22 或更新版本、[OBS Studio](https://obsproject.com/)、Chrome 或 Edge。
- iPhone：使用更新的 iOS Safari。保持 Safari 在前台、屏幕不锁定。
- PC 和 iPhone 在同一可信局域网。PC 用网线、iPhone 用同一路由器的 Wi-Fi 也可以；访客网络、AP 隔离可能阻断视频。
- 下载本仓库到 PC。项目不需要 npm 依赖，不需要运行 `npm install`。

## 2. 配置可信 HTTPS（首次使用）

Safari 访问相机要求可信的安全上下文。普通 `http://192.168...` 不能用；证书必须包含实际访问的局域网 IP，并在 iPhone 上被信任。

1. 从 [mkcert 官方项目](https://github.com/FiloSottile/mkcert) 安装 Windows 版 mkcert，使 `mkcert` 在终端中可用。
2. 在 Windows 网络设置查看 PC 当前局域网 IPv4，例如 `192.168.1.25`。
3. 在项目文件夹打开 PowerShell，运行（替换示例 IP）：

   ```powershell
   .\Setup-Certificates.ps1 -LanIP 192.168.1.25
   ```

   脚本会先要求输入 `YES`，然后生成本地证书，并为 Windows 安装本地开发 CA。如果系统策略禁止脚本，使用下述手动命令；无需更改执行策略。

   ```powershell
   New-Item -ItemType Directory -Force certs
   mkcert -install
   mkcert -cert-file certs/server.pem -key-file certs/server-key.pem localhost 127.0.0.1 192.168.1.25
   mkcert -CAROOT
   ```

4. 脚本会把 CA **公钥证书**复制为 `certs/PocketCam-CA.crt`。用你信任的方式传到 iPhone。手动配置时，复制上一步 CA 目录中的 `rootCA.pem`，将副本命名为 `PocketCam-CA.crt` 即可。**不要传输 `rootCA-key.pem`、`server-key.pem`，也不要提交 `certs/`。**
5. 在 iPhone 打开 CA 证书文件，按系统提示安装描述文件，再到“设置 → 通用 → 关于本机 → 证书信任设置”为自己生成的 CA 开启完全信任。这是用户手动的信任决定；CA 的私钥可签发被设备信任的证书，必须妥善保管。不再使用时可移除描述文件和信任。
6. 如果 Safari 显示证书错误，先修复 CA 信任、IP 或证书问题。不要忽略警告或关闭证书校验。

PC 局域网 IP 改变时需要重新生成服务器证书；同一个 mkcert CA 无需重复导入 iPhone。也可以提供你自己已有且被两端信任的证书：设置 `TLS_CERT`、`TLS_KEY` 指向文件。

## 3. 启动和连接

1. 双击 `Start-PocketCam.cmd`，或在项目目录执行 `node server.mjs`。启动窗口会列出 PC 地址和 iPhone 地址。
2. PC 浏览器打开 `https://localhost:8443`，选择“电脑接收”，点击“创建配对码”。
3. iPhone Safari 打开启动窗口列出的地址，例如 `https://192.168.1.25:8443/?mode=phone`。iPhone 的 `localhost` 指手机自己，不能用于访问 PC。
4. 在 iPhone 输入 PC 上的 8 位配对码，点击“开启前置摄像头”，由你本人允许 Safari 摄像头权限。画质默认 720p/30fps，也可选择 1080p；实际分辨率依设备和浏览器协商。
5. 两端显示“已连接”后，PC 可切换镜像，并进入“纯画面模式”。按 **Esc** 返回控制界面。
6. 结束时点击任一端的“结束连接”。摄像头轨道会停止，对端画面会清空。

服务器监听本机 `8443/TCP`。如果 Windows 防火墙询问，确认仅允许你使用的专用网络；不要关闭防火墙。WebRTC 的媒体连接也可能需要 Node/浏览器在专用网络被允许。不要做公网端口映射。本项目没有外部 STUN/TURN，跨网络或隔离 Wi-Fi 不保证连接。

## 4. 在 Windows 作为摄像头使用

1. 在 PC Chrome/Edge 中确认已经收到 iPhone 画面，点“纯画面模式”。
2. 打开 OBS，新建场景，添加 **窗口采集**，选择 PocketCam 所在的浏览器窗口。启用“客户端区域”以去掉窗口边框；若仍含浏览器工具栏，可按住 Alt 拖动源边缘裁剪。建议用单独的浏览器窗口承载 PocketCam，保持可见且不最小化。
3. 右键采集源 → 变换 → 适配屏幕，按需设置 OBS 画布为 1280×720、30fps。竖屏 iPhone 可能出现黑边；横放手机通常更适合会议。
4. 点击 OBS 的 **启动虚拟摄像头 / Start Virtual Camera**。
5. 在会议软件里选择 **OBS Virtual Camera**。在 OBS 本身使用时，直接使用已创建的采集场景；避免把自己的虚拟输出再次采入同一场景形成递归画面。
6. 会议结束，停止 OBS 虚拟摄像头并结束 PocketCam 连接。

这条路径需要 PC 浏览器和 OBS 都保持运行。没有自动注册名为 PocketCam 的系统摄像头，也不保证兼容每一个限制虚拟设备的软件。[OBS 官方虚拟摄像头说明](https://obsproject.com/kb/virtual-camera-guide)。

## 5. 常见问题

| 现象 | 处理 |
| --- | --- |
| iPhone 打不开地址 | 核对 PC IPv4、同一网络、专用网络防火墙规则，先确认 Node 正在运行。 |
| Safari 没有摄像头或 `getUserMedia` | 检查 HTTPS、CA 完全信任、证书 IP 是否匹配，以及 Safari 网站摄像头权限。 |
| 配对后一直连接 | 检查访客网络/AP 隔离、VPN、多网卡和浏览器权限；结束两端连接再新建配对。 |
| 切到后台后黑屏 | iOS 可能暂停摄像头。回到 Safari；不能恢复时重新配对。网页无法保证后台相机持续工作。 |
| OBS 黑屏 | 先看 PC 页面是否有画面，再检查窗口采集目标/采集方式。保持窗口可见，重新选择窗口。 |
| 找不到 OBS Virtual Camera | 检查 OBS 官方安装及虚拟摄像头功能，启动虚拟摄像头后重启会议软件。 |
| 卡顿/发热 | 使用 5GHz Wi-Fi、720p，靠近路由器；避免长时间高亮屏幕或同时充电导致过热。 |

## 隐私、边界与实现

- 视频由 WebRTC 传输；本机 Node 只转发配对和连接信令，不接收或保存相机视频。
- 不请求麦克风或定位权限；不加载 CDN、统计或第三方脚本。
- 配对码只能使用一次，10 分钟有效；连接使用独立随机令牌。令牌仅在页面内存中，刷新后需要重新配对。
- 服务有配对尝试限速、同源校验、64KB 请求限制、会话数量限制；会话最长 4 小时、无轮询 10 分钟过期。用于可信局域网，不适合作为公网多租户服务。
- OBS 和会议软件在本机用户的控制下处理后续视频；PocketCam 的“结束连接”不负责停止 OBS 或退出会议。
- 不会启动飞书、调用考勤 API、伪造位置或绕过身份/打卡验证。

## 开发与验证

```powershell
node --check server.mjs
node --check public/app.js
node --test
```

自动测试覆盖配对、单次加入、令牌隔离、信令角色、消息重读、到期、限速、跨站请求和静态文件白名单。真实 iPhone 前置摄像头、网络环境、Safari 证书信任及 OBS 虚拟设备输出需要双设备手动验收；本仓库不声称自动测试已验证这些硬件行为。

可用环境变量：`PORT`（默认 8443）、`TLS_CERT`、`TLS_KEY`、`ALLOWED_HOSTS`（逗号分隔的额外主机名，不含协议/端口；相应名称也必须在证书中）。

参考：[MDN 相机权限及 HTTPS 要求](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[mkcert 官方文档](https://github.com/FiloSottile/mkcert)、[OBS Virtual Camera](https://obsproject.com/kb/virtual-camera-guide)。
