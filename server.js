const express = require('express');
const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const QWEN_BASE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

// --- 人脸识别打招呼冷却缓存 (内存型地图: name -> timestamp) ---
const greetingsMap = new Map();

wss.on('connection', (clientWs, req) => {
  console.log('[Proxy] 新的客户端连接');
  let qwenWs = null;
  let initialized = false;

  clientWs.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (e) {
      console.error('[Proxy] 无法解析客户端消息:', e.message);
      return;
    }

    // 第一条消息必须是 init，用于建立与阿里云的连接
    if (msg.type === 'init' && !initialized) {
      initialized = true;
      const { apiKey, model, voice, instructions } = msg;

      if (!apiKey) {
        clientWs.send(JSON.stringify({
          type: 'proxy.error',
          error: 'API Key 不能为空'
        }));
        return;
      }

      const qwenUrl = `${QWEN_BASE_URL}?model=${encodeURIComponent(model)}`;
      console.log(`[Proxy] 正在连接阿里云: ${model}`);

      try {
        qwenWs = new WebSocket(qwenUrl, {
          headers: {
            'Authorization': `Bearer ${apiKey}`
          }
        });
      } catch (err) {
        clientWs.send(JSON.stringify({
          type: 'proxy.error',
          error: `创建连接失败: ${err.message}`
        }));
        return;
      }

      qwenWs.on('open', () => {
        console.log('[Proxy] 已连接到阿里云 API');

        // 发送会话配置
        const sessionUpdate = {
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            voice: voice || 'Cherry',
            instructions: instructions || '你是一个友好的AI助手。',
            input_audio_format: 'pcm',
            output_audio_format: 'pcm',
            input_audio_transcription: {
              model: 'gummy-realtime-v1'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              silence_duration_ms: 800
            }
          }
        };
        qwenWs.send(JSON.stringify(sessionUpdate));

        // 通知客户端连接成功
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'proxy.connected' }));
        }
      });

      qwenWs.on('message', (data) => {
        // 将阿里云的响应转发给前端
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data.toString());
        }
      });

      qwenWs.on('error', (err) => {
        console.error('[Proxy] 阿里云连接错误:', err.message);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'proxy.error',
            error: `阿里云连接错误: ${err.message}`
          }));
        }
      });

      qwenWs.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : '未知原因';
        console.log(`[Proxy] 阿里云连接关闭: ${code} - ${reasonStr}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'proxy.closed',
            code,
            reason: reasonStr
          }));
        }
      });

      return;
    }

    // --- 拦截前端的本地人脸识别比对成功事件 ---
    if (msg.type === 'face_match') {
      const parsedName = msg.name;
      const now = Date.now();
      const lastGreetTime = greetingsMap.get(parsedName) || 0;
      
      // 5 分钟冷却期 (300000 毫秒)
      const COOLDOWN_MS = 5 * 60 * 1000;
      if (now - lastGreetTime > COOLDOWN_MS) {
        greetingsMap.set(parsedName, now);
        console.log(`\n[Proxy 中控] 触发主动问候机制 -> 镜头前用户为: ${parsedName}`);
        
        if (qwenWs && qwenWs.readyState === WebSocket.OPEN) {
          // 伪造一条 user 角色的消息塞给模型，带有长提示词
          const injectItem = {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{
                type: "input_text",
                text: `(这是系统底层发来的强视觉提示信号)：系统通过安防摄像头刚刚成功识别到，目前坐在你面前与你视频连线的熟人是【${parsedName}】。目前不需要了解他要办什么事，仅仅需要你立刻、大方、热情地开口向 ${parsedName} 打个招呼问好！绝不能暴露你是看“提示信号”知道的。`
              }]
            }
          };
          qwenWs.send(JSON.stringify(injectItem));
          
          // 紧接着强制引发模型说话，无视 VAD 的沉默计时
          qwenWs.send(JSON.stringify({ type: "response.create" }));
        }
      } else {
        // console.log(`[Proxy] ${parsedName} 还在冷却期内，不打扰`);
      }
      return; // 拦截完毕，不能原样转发这坨自定义协议给 Qwen 否则报错
    }
    // --- 拦截逻辑结束 ---

    // 后续消息直接且透明地转发给阿里云
    if (qwenWs && qwenWs.readyState === WebSocket.OPEN) {
      qwenWs.send(rawData.toString());
    }
  });

  clientWs.on('close', () => {
    console.log('[Proxy] 客户端断开');
    if (qwenWs) {
      if (qwenWs.readyState === WebSocket.OPEN || qwenWs.readyState === WebSocket.CONNECTING) {
        qwenWs.close();
      }
      qwenWs = null;
    }
  });

  clientWs.on('error', (err) => {
    console.error('[Proxy] 客户端错误:', err.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Qwen-Omni-Realtime Demo 服务已启动`);
  console.log(`📡 访问地址: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket 代理: ws://localhost:${PORT}/ws\n`);
});
