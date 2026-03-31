# Qwen-Omni-Realtime Web Demo 🚀

这是一个基于 **阿里云通义千问 Qwen-Omni-Realtime** 大模型开发的实时音视频流式交互 Web 演示系统。本项目不仅实现了官方的基础语音通话（Server VAD 模型打断），还在前端集成了“零系统依赖”的 AI 面部识别引擎，实现了极客级别的“看见熟人主动开口打招呼”的交互体验。

---

## ✨ 核心特性

1. **🎙️ Web Audio 重采样**：纯前端使用 `AudioWorklet` 将原生浏览器的 44.1kHz/48kHz 麦克风音频，实时降采样为符合 Qwen 标准的 16kHz 16-bit PCM，解决爆音和格式兼容问题。
2. **🔌 Node.js WebSocket 代理**：轻量级后端，由于前端无法定制 `Authorization: Bearer` 握手头，因此用 Node 中转一切消息，完美隐瞒阿里云后台的连接细节。
3. **👁️ 纯前端人脸识别引擎**：内置 `face-api.min.js`，借助浏览器 WebGL/WASM 算力进行人脸识别（0 系统依赖，无需配置 Python/C++ 环境），即便是几百 M 的小内存 Ubuntu 服务器也能流畅部署。
4. **🤖 大模型“强视觉注入”**：当识别到预设的熟人入画时，系统会在后端悄悄捏造 `conversation.item.create` 和 `response.create` 强行阻断 AI 等待状态，让大模型主动开口“认出你”。
5. **🖼️ 动态表单重载入库**：自带“老熟人照片墙”，可在网页一键传照片入库。前端图片上传，后端 `multer` 落盘接收，0 刷新实现特征库热重载。

---

## 🛠️ 环境要求

- **Node.js**: v14.x 或更高版本（推荐 v18 LTS）
- **阿里云 API Key**: 需自行前往百炼控制台申请，并且开通调用 `qwen3.5-omni-plus-realtime` 或 `qwen3-omni-flash-realtime` 权限。

---

## 🚀 极其简单的安装与运行

哪怕是一台干干净净的 Ubuntu，按以下步骤即可完美展现：

### 1. 克隆代码与安装依赖
```bash
git clone git@github.com:he1110w0r1d/chatbaby.git
cd chatbaby

# 安装 ws、express 和 multer 等纯 JS 依赖包，0 编译成本
npm install
```

### 2. 启动服务
```bash
npm run dev
# 或 
node server.js
```

跑起来后，终端会打印如下信息：
```text
🚀 Qwen-Omni-Realtime Demo 服务已启动
📡 访问地址: http://localhost:3000
🔌 WebSocket 代理: ws://localhost:3000/ws
```

### 3. 开启浏览器访问测试
打开浏览器，访问 `http://localhost:3000`。
- **配置与连麦**：输入你的 API Key。勾选你想要的音色，点击“开始对话”即可体验实时语音对话及 VAD (自动人声打断)。
- **视觉能力体验**：系统每 1 秒截取摄像头发送给大模型，你可以问它“你看我手上的杯子是什么颜色”。
- **人脸主动问候体验**：
  1. 在左下角“录入熟人”组件里，填个拼音（如：`boss`），选一张自己的清晰自拍照传上去。
  2. 听到“特征提取完毕”后。
  3. 点击“开始对话”连上麦。
  4. 把连麦摄像头正对刚才那张脸。
  5. 不出三秒，就会听到人工智能大梦初醒般主动跟你大声打招呼了！*(注：防止多次打扰，连续问候冷却时间配置在 `server.js` 里默认 5分钟)*。

---

## 📂 项目结构指南

- `server.js` : Node.js Websocket 中转、人脸缓存冷却计时、文件上传 multer 接口控制中枢。
- `public/index.html / css`: 赛博朋克深色极客风控制台。
- `public/app.js`: 在网页上跑满千军万马的真正魔法。包括：`getUserMedia` 采集、WebSocket 解析转发帧、`face-api.js` 特征寻址对齐。
- `public/audio-processor.js`: 最硬核的 PCM 音频抽样处理器。
- `public/models/`: 人脸检测与 128 维特征提取轻量级神经网络权重（已自动提供）。
- `public/faces/`: 人像图片长久保存的位置。

---
Enjoy chatting with Qwen Omni! 🤖 
如果有兴趣加入后续模块（如：唤醒词打断检测机制、自定义发音人克隆模块），欢迎提交 PR！
