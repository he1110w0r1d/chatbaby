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
const faceStatus = document.getElementById('face-status');
const floatingControls = document.getElementById('floating-controls');
const btnSwitchCam = document.getElementById('btn-switch-cam');
const btnHangup = document.getElementById('btn-hangup');

// --- 状态与对象 ---
let ws = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let playbackBuffer = [];
let isPlaying = false;
let nextPlayTime = 0;
let videoInterval = null;
let isConnected = false;
let currentFacingMode = "user"; // "user" 或 "environment"

// --- 人脸识别相关 ---
let labeledFaceDescriptors = [];
let faceMatcher = null;
let isFaceModelsLoaded = false;
let isRecognizing = false;

// 页面加载恢复 API Key 和加载人脸模型
window.addEventListener('DOMContentLoaded', () => {
    const savedKey = localStorage.getItem('qwen_api_key');
    if (savedKey) elApiKey.value = savedKey;
    initFaceAPI();
});

// 初始化 face-api 并提取照片特征
async function initFaceAPI() {
    try {
        faceStatus.textContent = '👨‍💻 加载人脸模型中...';
        // 加载模型权重 (从 public/models)
        await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
        
        // 动态调用后端接口获取 public/faces 下的所有合法照片
        const res = await fetch('/api/faces');
        const knownFiles = await res.json();
        
        labeledFaceDescriptors = [];
        
        for (const filename of knownFiles) {
            try {
                // 读取同名照片
                const img = await faceapi.fetchImage(`/faces/${filename}`);
                // 提取 128 维特征面部向量
                const detections = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
                if (detections) {
                    const name = filename.substring(0, filename.lastIndexOf('.'));
                    labeledFaceDescriptors.push(new faceapi.LabeledFaceDescriptors(name, [detections.descriptor]));
                    console.log(`✅ 已提取特征: ${filename}`);
                }
            } catch (e) {
                console.warn(`未找到或无法处理参考照片: /faces/${filename}`, e.message);
            }
        }
        
        if (labeledFaceDescriptors.length > 0) {
            faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, 0.6); // 距离 < 0.6 则认为匹配（原为 0.5 有可能过于严格）
            faceStatus.textContent = `✅ 人脸就绪 (已登记 ${labeledFaceDescriptors.length} 人)`;
        } else {
            faceStatus.textContent = '⚠️ 模型就绪，但 faces 目录下没图';
        }
        isFaceModelsLoaded = true;
    } catch (err) {
        console.error("Face API 初始化失败", err);
        faceStatus.textContent = '❌ 人脸模型加载失败';
    }
}

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

// --- 人脸录入中心 ---
const elFaceName = document.getElementById('face-name');
const elFaceFile = document.getElementById('face-file');
const btnUpload = document.getElementById('btn-upload');
const uploadStatus = document.getElementById('upload-status');

btnUpload.addEventListener('click', async () => {
    const name = elFaceName.value.trim();
    const file = elFaceFile.files[0];
    
    if (!name || !file) {
        uploadStatus.style.color = '#ef4444';
        uploadStatus.textContent = '请填写姓名拼音并选择一张照片！';
        return;
    }
    
    uploadStatus.style.color = '#94a3b8';
    uploadStatus.textContent = '正在上传录入...';
    btnUpload.disabled = true;
    
    const formData = new FormData();
    formData.append('name', name);
    formData.append('photo', file);
    
    try {
        const res = await fetch('/api/upload-face', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        
        if (data.success) {
            uploadStatus.style.color = '#10b981';
            uploadStatus.textContent = '上传成功！正在提取特征池...';
            // 清空表单
            elFaceName.value = '';
            elFaceFile.value = '';
            
            // 热重载人脸库
            await initFaceAPI();
            
            uploadStatus.textContent = `更新完毕！已认识: ${name}`;
            setTimeout(() => { uploadStatus.textContent = ''; }, 3000);
        } else {
            throw new Error(data.error || '上传失败');
        }
    } catch (e) {
        uploadStatus.style.color = '#ef4444';
        uploadStatus.textContent = e.message;
    } finally {
        btnUpload.disabled = false;
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

btnHangup.addEventListener('click', () => cleanup());

btnSwitchCam.addEventListener('click', async () => {
    if (!mediaStream || !mediaStream.getVideoTracks().length) return;
    
    // 反转摄像头朝向
    currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
    
    // 停止当前的视频轨道
    const videoTracks = mediaStream.getVideoTracks();
    videoTracks.forEach(track => {
        track.stop();
        mediaStream.removeTrack(track);
    });
    
    try {
        // 请求新方向的摄像头
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: currentFacingMode },
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { max: 15 }
            }
        });
        
        const newVideoTrack = newStream.getVideoTracks()[0];
        // 插入旧的包含话筒的音视流里，实现无缝切换画面不断音
        mediaStream.addTrack(newVideoTrack);
        elVideo.srcObject = mediaStream;
        
    } catch (e) {
        console.error("切换摄像头方向失败", e);
        appendSystemMsg("切换摄像头失败: " + e.message);
    }
});

function updateUIState() {
    if (isConnected) {
        btnStart.disabled = true;
        btnStop.disabled = false;
        elStatus.textContent = '已连接';
        elStatus.classList.add('connected');
        micStatus.classList.add('active');
        elApiKey.disabled = true;
        elModel.disabled = true;
        
        // 开启全屏沉浸通话界面
        document.body.classList.add('immersive-mode');
        floatingControls.style.display = 'flex';
    } else {
        btnStart.disabled = false;
        btnStop.disabled = true;
        elStatus.textContent = '未连接';
        elStatus.classList.remove('connected');
        micStatus.classList.remove('active');
        elApiKey.disabled = false;
        elModel.disabled = false;
        
        // 退出沉浸通话界面
        document.body.classList.remove('immersive-mode');
        floatingControls.style.display = 'none';
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
        facingMode: { ideal: currentFacingMode },
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
    // 每 2000 毫秒提取 1 帧发给模型 (降速以节省性能并为人脸识别留出算力)
    videoInterval = setInterval(async () => {
        if (!isConnected || !cameraToggle.checked) return;

        // 如果视频组件没有准备好
        if (elVideo.readyState !== elVideo.HAVE_ENOUGH_DATA || elVideo.videoWidth === 0) return;

        canvas.width = elVideo.videoWidth;
        canvas.height = elVideo.videoHeight;
        ctx.drawImage(elVideo, 0, 0, canvas.width, canvas.height);
        
        // 1. 发给 Qwen 模型看
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        const base64Image = dataUrl.split(',')[1];
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'input_image_buffer.append',
                image: base64Image
            }));
        }

        // 2. 本地执行人脸比对
        if (isFaceModelsLoaded && faceMatcher && !isRecognizing) {
            isRecognizing = true;
            try {
                // 使用刚才截好的 canvas 画布去计算
                const detection = await faceapi.detectSingleFace(canvas).withFaceLandmarks().withFaceDescriptor();
                if (detection) {
                    const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
                    console.log('📸 摄像头捕获到人脸 -> 匹配结果:', bestMatch.toString());
                    if (bestMatch.label !== 'unknown') {
                        console.log('👀 本地人脸识别确认是老熟人！发送打招呼信号...');
                        // 发送识别信号给 Node.js 后端代理
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'face_match',
                                name: bestMatch.label,
                                distance: bestMatch.distance
                            }));
                        }
                    }
                }
            } catch (e) {
                console.error("前端人脸识别运行报错", e);
            }
            isRecognizing = false;
        }

    }, 2000);
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
