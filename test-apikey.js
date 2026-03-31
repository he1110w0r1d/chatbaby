const WebSocket = require('ws');

const apiKey = 'sk-384be0eb0a6a40e082a89be7437ffc6b';
const models = ['qwen3.5-omni-plus-realtime', 'qwen3-omni-flash-realtime'];

function testModel(model) {
  return new Promise((resolve) => {
    console.log(`\n正在测试模型: ${model}...`);
    const url = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${model}`;
    
    const ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    ws.on('open', () => {
      console.log(`✅ [${model}] 连接成功！正在发送 session.update...`);
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          voice: 'Cherry',
          instructions: '你是一个友好的AI助手。',
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
      ws.send(JSON.stringify(sessionUpdate));
    });

    ws.on('error', (err) => {
      console.error(`❌ [${model}] 发生错误:`, err.message);
    });

    ws.on('message', (data) => {
        console.log(`📩 [${model}] 收到消息:`, JSON.parse(data.toString()).type);
        if (JSON.parse(data.toString()).type === 'session.updated') {
             console.log(`✅ [${model}] session.update 成功！`);
             ws.close();
             resolve(true);
        }
    });

    ws.on('unexpected-response', (request, response) => {
      console.error(`❌ [${model}] HTTP 握手被拒绝: ${response.statusCode} - ${response.statusMessage}`);
      resolve(false);
    });

    ws.on('close', (code, reason) => {
      let desc = '';
      if (code === 1007) desc = '(这通常代表 Access Denied / 鉴权失败或数据格式错误)';
      console.log(`ℹ️ [${model}] 连接已断开，状态码: ${code} ${reason ? reason.toString() : ''} ${desc}`);
      resolve(false);
    });
  });
}

async function runTests() {
  console.log('开始验证你的 API Key...');
  for (const model of models) {
    await testModel(model);
    await new Promise(r => setTimeout(r, 1000)); // 暂停 1 秒防频繁请求拦截
  }
}

runTests();
