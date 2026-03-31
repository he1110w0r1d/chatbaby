// ==========================================
// Qwen-Omni-Realtime Web Demo 核心前端业务逻辑
// ==========================================

// --- UI 元素 ---
const elApiKey = document.getElementById('api-key');
const elModel = document.getElementById('model-select');
const elVoice = document.getElementById('voice-select');
const elInstructions = document.getElementById('instructions');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const elStatus = document.getElementById('connection-status');
const elVideo = document.getElementById('local-video');
const elVideoOverlay = document.getElementById('video-overlay');
const cameraToggle = document.getElementById('camera-toggle');
const canvas = document.getElementById('snapshot-canvas');
const ctx = canvas.getContext('2d');
const chatLog = document.getElementById('chat-log');
const micStatus = document.getElementById('mic-status');

// --- 状态与对象 ---
let ws = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let playbackBuffer = []; // 用于模型音频响应的缓冲
let isPlaying = false;
let nextPlayTime = 0;
let videoInterval = null;
let isConnected = false;

// 页面加载恢复 API Key
window.addEventListener('DOMContentLoaded', () => {
    const savedKey = localStorage.getItem('qwen_api_key');
    if (savedKey) elApiKey.value = savedKey;
});

// 保存 API Key 并在输入时触发
elApiKey.addEventListener('change', () => {
    localStorage.setItem('qwen_api_key', elApiKey.value.trim());
});

cameraToggle.addEventListener('change', (e) => {
    if (e.target.checked) {
        elVideoOverlay.classList.remove('active');
    } else {
        elVideoOverlay.classList.add('active');
    }
});

// --- 会话控制 ---

btnStart.addEventListener('click', async () => {
    const apiKey = elApiKey.value.trim();
    if (!apiKey) {
        alert('请先输入百炼 API Key');
        return;
    }
    localStorage.setItem('qwen_api_key', apiKey);

    appendSystemMsg('正在请求系统权限并连接服务器...');
    btnStart.disabled = true;

    try {
        await startMedia();
        connectWebSocket();
    } catch (e) {
        console.error(e);
        appendSystemMsg(`错误: ${e.message}`);
        btnStart.disabled = false;
        stopMedia();
    }
});

btnStop.addEventListener('click', () => {
    cleanup();
});

function cleanup() {
    if (ws) {
        ws.close();
        ws = null;
    }
    stopMedia();
    stopAudioPlayback();
    clearInterval(videoInterval);

    isConnected = false;
    updateUIState();
    appendSystemMsg('对话已结束');
}

function updateUIState() {
    if (isConnected) {
        btnStart.disabled = true;
        btnStop.disabled = false;
        elStatus.textContent = '已连接';
        elStatus.classList.add('connected');
        micStatus.classList.add('active');
        elApiKey.disabled = true;
        elModel.disabled = true;
    } else {
        btnStart.disabled = false;
        btnStop.disabled = true;
        elStatus.textContent = '未连接';
        elStatus.classList.remove('connected');
        micStatus.classList.remove('active');
        elApiKey.disabled = false;
        elModel.disabled = false;
    }
}

// --- WebSocket 交互 ---

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        // 第一条消息发给 Node.js 后端，带上配置要求去建连
        const initData = {
            type: 'init',
            apiKey: elApiKey.value.trim(),
            model: elModel.value,
            voice: elVoice.value,
            instructions: elInstructions.value
        };
        ws.send(JSON.stringify(initData));
    };

    ws.onmessage = (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            console.error('无法解析 WS 消息', e);
            return;
        }

        handleServerMessage(msg);
    };

    ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
        appendSystemMsg('WebSocket 连接发生错误');
    };

    ws.onclose = () => {
        console.log('WebSocket 挂断');
        cleanup();
    };
}

let currentUserMsg = null;
let currentAiMsg = null;

function handleServerMessage(msg) {
    switch (msg.type) {
        case 'proxy.connected':
            isConnected = true;
            updateUIState();
            appendSystemMsg('已连接到 Qwen-Omni-Realtime，你可以开始说话了。');
            startVideoFrameExtraction(); // 连接成功后开始发视频帧
            break;
        case 'proxy.error':
            appendSystemMsg(`代理错误: ${msg.error}`);
            cleanup();
            break;
        case 'input_audio_buffer.speech_started':
            // 用户开始说话，打断 AI 播放
            stopAudioPlayback();
            currentUserMsg = createMsgBubble('user', '正在听...');
            break;
        case 'conversation.item.input_audio_transcription.completed':
            // 用户的语音转文本完成了
            if (currentUserMsg && msg.transcript) {
                currentUserMsg.querySelector('.msg-content').textContent = msg.transcript;
                currentUserMsg = null; // 释放引用
            } else if (msg.transcript) {
                createMsgBubble('user', msg.transcript);
            }
            break;
        case 'response.created':
            currentAiMsg = createMsgBubble('ai', '正在回复...');
            break;
        case 'response.audio_transcript.delta':
            // AI 正在生成的文字增量
            if (currentAiMsg && msg.delta) {
                const contentEl = currentAiMsg.querySelector('.msg-content');
                if (contentEl.textContent === '正在回复...') contentEl.textContent = '';
                contentEl.textContent += msg.delta;
            }
            break;
        case 'response.audio_transcript.done':
            // AI 文字生成完成
            if (currentAiMsg && msg.transcript) {
                currentAiMsg.querySelector('.msg-content').textContent = msg.transcript;
            }
            currentAiMsg = null;
            break;
        case 'response.audio.delta':
            // 收到 AI 语音的 Base64 PCM 数据，加入播放队列
            if (msg.delta) {
                queueAudioPlayback(msg.delta);
            }
            break;
        default:
            // 其他内部事件不予展示
            // console.log("Unhandled event:", msg.type);
            break;
    }
}

// --- 音视频采集 (getUserMedia, AudioContext) ---

async function startMedia() {
    // 决定是否请求视频流
    const requestVideo = cameraToggle.checked ? {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { max: 15 }
    } : false;

    const audioConstraints = {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
    };

    try {
        // 尝试获取设备
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: requestVideo
        });
    } catch (e) {
        // 如果是因为找不到摄像头 (NotFoundError) 导致的失败，且我们请求了摄像头
        if (e.name === 'NotFoundError' && requestVideo) {
            console.warn("未检测到摄像头，尝试仅请求麦克风");
            appendSystemMsg('未检测到摄像头设备，自动降级为仅语音模式...');
            
            // 降级：仅请求麦克风
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
                video: false
            });
            
            // 同步更新 UI 状态
            cameraToggle.checked = false;
            elVideoOverlay.classList.add('active');
            elVideoOverlay.textContent = '无摄像头设备';
        } else {
            // 如果是拒绝权限或连麦克风都没有，则直接抛出异常
            throw new Error(e.name === 'NotAllowedError' ? '您拒绝了麦克风/摄像头权限' : '未检测到麦克风设备');
        }
    }

    // 如果成功获取到视频轨道，则播放视频
    if (mediaStream.getVideoTracks().length > 0) {
        elVideo.srcObject = mediaStream;
    }

    // --- 音频处理部分 ---
    // 为了使用 AudioWorklet，初始化 audio context
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
    });

    // 麦克风流输入 -> Worklet Node -> 无需连接到 destination (避免听到自己的回音)
    const source = audioContext.createMediaStreamSource(mediaStream);

    await audioContext.audioWorklet.addModule('audio-processor.js');
    audioProcessor = new AudioWorkletNode(audioContext, 'audio-capture-processor');

    audioProcessor.port.onmessage = (event) => {
        if (!isConnected) return;
        
        // 当 Worklet 将麦克风降采样好的 PCM ArrayBuffer 发过来，我们通过 WS 转发给后端
        const pcmData = event.data.pcm; // ArrayBuffer (Int16)
        
        // 转 base64
        const base64PCM = arrayBufferToBase64(pcmData);
        
        ws.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: base64PCM
        }));
    };

    source.connect(audioProcessor);
}

function stopMedia() {
    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    elVideo.srcObject = null;
}

// --- 视频帧提取 ---

function startVideoFrameExtraction() {
    clearInterval(videoInterval);
    // 每 1000 毫秒 (1秒) 提取 1 帧发给模型
    videoInterval = setInterval(() => {
        if (!isConnected || !cameraToggle.checked) return;

        // 如果视频组件没有准备好
        if (elVideo.readyState !== elVideo.HAVE_ENOUGH_DATA || elVideo.videoWidth === 0) return;

        canvas.width = elVideo.videoWidth;
        canvas.height = elVideo.videoHeight;
        ctx.drawImage(elVideo, 0, 0, canvas.width, canvas.height);
        
        // 压缩成 JPEG base64 (Qwen 要求每抓一帧至少一次 input_audio_buffer.append 后发)
        // jpeg 质量可以压低一点避免包太大，比如 0.6
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        // data:image/jpeg;base64,... 提取 base64 部分
        const base64Image = dataUrl.split(',')[1];
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'input_image_buffer.append',
                image: base64Image
            }));
        }

    }, 1000);
}


// --- 语音播放 (Qwen => Browser) ---
// AI 下发的格式为：24000Hz, 16bit 耳机播放 PCM

// 解码 base64 成 Float32Array 供 AudioContext 播放
function base64ToFloat32Array(base64) {
    const binary = atob(base64);
    const len = binary.length;
    // 16bit PCM 意味着每个采样2字节
    const floatArray = new Float32Array(len / 2);
    for (let i = 0; i < len / 2; i++) {
        // 还原 小端序 int16
        const uint16 = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
        const int16 = uint16 >= 0x8000 ? uint16 - 0x10000 : uint16;
        floatArray[i] = int16 / 0x8000;
    }
    return floatArray;
}

function queueAudioPlayback(base64PcmData) {
    if (!audioContext) return;
    try {
        const floatArray = base64ToFloat32Array(base64PcmData);
        // Qwen 输出音频指定为 24000
        const audioBuffer = audioContext.createBuffer(1, floatArray.length, 24000);
        audioBuffer.getChannelData(0).set(floatArray);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        // 控制不要重叠播放
        const currentTime = audioContext.currentTime;
        if (!isPlaying || currentTime >= nextPlayTime) {
            nextPlayTime = currentTime;
            isPlaying = true;
        }

        source.start(nextPlayTime);
        nextPlayTime += audioBuffer.duration;

        source.onended = () => {
            if (audioContext.currentTime >= nextPlayTime) {
                isPlaying = false;
            }
        };

        // 保存对 source 的引用，可用于打断清空
        playbackBuffer.push(source);
    } catch (e) {
        console.error("Audio playback error:", e);
    }
}

function stopAudioPlayback() {
    playbackBuffer.forEach(source => {
        try { source.stop(); } catch(e) {}
    });
    playbackBuffer = [];
    isPlaying = false;
    nextPlayTime = audioContext ? audioContext.currentTime : 0;
}

// --- Utils ---

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function appendSystemMsg(text) {
    const el = document.createElement('div');
    el.className = 'system-msg';
    el.textContent = text;
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function createMsgBubble(role, text) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    
    const header = document.createElement('div');
    header.className = 'msg-header';
    header.textContent = role === 'user' ? '你' : 'AI 助手';
    
    const content = document.createElement('div');
    content.className = 'msg-content';
    content.textContent = text;

    el.appendChild(header);
    el.appendChild(content);

    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
    
    return el; // 方便外部更新内容（如流式文字）
}
