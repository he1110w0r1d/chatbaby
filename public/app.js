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
const debugLog = document.getElementById('debug-log');
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
let recognizedUserName = null; // 识别到的用户名
let continuousFaceCheckInterval = null;

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
            faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, 0.65);
            faceStatus.textContent = `✅ 人脸就绪 (已登记 ${labeledFaceDescriptors.length} 人)`;
            // 如果摄像头已经打开，开始连续检测
            if (elVideo.srcObject) {
                startContinuousFaceDetection();
            }
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

cameraToggle.addEventListener('change', async (e) => {
    if (e.target.checked) {
        elVideoOverlay.classList.remove('active');
        // 自动启动摄像头
        try {
            await startMediaOnly();
            // 开始连续人脸检测
            startContinuousFaceDetection();
        } catch (e) {
            console.error('启动摄像头失败', e);
            appendSystemMsg('摄像头启动失败: ' + e.message);
            e.target.checked = false;
            elVideoOverlay.classList.add('active');
        }
    } else {
        elVideoOverlay.classList.add('active');
        stopContinuousFaceDetection();
        stopMedia();
    }
});

// 仅启动媒体（不创建 AudioWorklet）
async function startMediaOnly() {
    const requestVideo = {
        facingMode: { ideal: currentFacingMode },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { max: 15 }
    };

    const audioConstraints = {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
    };

    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: requestVideo
    });
    
    elVideo.srcObject = mediaStream;
    await elVideo.play();
}

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

    appendSystemMsg('正在打开摄像头并识别人脸...');
    btnStart.disabled = true;

    try {
        // 1. 打开摄像头
        await startMedia();
        debugLogMsg('📷 摄像头已打开');
        
        // 2. 等待摄像头稳定
        appendSystemMsg('⏳ 等待摄像头稳定...');
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // 3. 做人脸识别
        appendSystemMsg('🔍 正在识别人脸...');
        let userName = await detectCurrentUser();
        debugLogMsg(`🔍 人脸识别结果: ${userName || '未识别'}`);
        
        if (userName) {
            const newInstructions = `用户叫 ${userName}，请在他们说话前主动打招呼说"你好 ${userName}，见到你很高兴！"`;
            elInstructions.value = newInstructions;
            debugLogMsg(`📝 更新 instructions: ${newInstructions}`);
            appendSystemMsg(`👤 识别成功！用户: ${userName}`);
        } else {
            appendSystemMsg('⚠️ 未识别到已登记的用户，将以普通模式开始对话');
        }
        
        // 4. 开始对话
        appendSystemMsg('🚀 正在连接服务器...');
        connectWebSocket();
    } catch (e) {
        console.error(e);
        appendSystemMsg(`错误: ${e.message}`);
        btnStart.disabled = false;
        stopMedia();
    }
});

// 连续人脸检测
function startContinuousFaceDetection() {
    if (continuousFaceCheckInterval) return;
    
    continuousFaceCheckInterval = setInterval(async () => {
        if (!isFaceModelsLoaded || !faceMatcher || !elVideo.srcObject || isRecognizing) return;
        
        isRecognizing = true;
        try {
            if (elVideo.readyState < 2) {
                isRecognizing = false;
                return;
            }
            
            canvas.width = elVideo.videoWidth || 640;
            canvas.height = elVideo.videoHeight || 480;
            ctx.drawImage(elVideo, 0, 0, canvas.width, canvas.height);
            
            const detection = await faceapi.detectSingleFace(canvas).withFaceLandmarks().withFaceDescriptor();
            if (detection) {
                const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
                if (bestMatch.label !== 'unknown') {
                    recognizedUserName = bestMatch.label;
                    debugLogMsg(`👤 识别到: ${recognizedUserName} (距离: ${bestMatch.distance.toFixed(3)})`);
                    
                    // 更新 UI：显示欢迎信息
                    faceStatus.textContent = `👋 欢迎 ${recognizedUserName}！`;
                    faceStatus.style.color = '#10b981';
                    
                    // 更新按钮文字
                    btnStart.textContent = `开始对话 (${recognizedUserName})`;
                    btnStart.disabled = false;
                    
                    // 更新 system prompt
                    elInstructions.value = `用户叫 ${recognizedUserName}，请在他们说话前主动打招呼说"你好 ${recognizedUserName}，见到你很高兴！"`;
                }
            }
        } catch (e) {
            console.error('人脸检测错误', e);
        }
        isRecognizing = false;
    }, 1000); // 每秒检测一次
}

function stopContinuousFaceDetection() {
    if (continuousFaceCheckInterval) {
        clearInterval(continuousFaceCheckInterval);
        continuousFaceCheckInterval = null;
    }
    recognizedUserName = null;
}

// 开始对话前先做人脸识别
async function detectCurrentUser() {
    if (!isFaceModelsLoaded || !faceMatcher) {
        debugLogMsg('⚠️ 人脸模型未加载');
        return null;
    }
    
    if (!elVideo.srcObject) {
        debugLogMsg('⚠️ 视频流未就绪');
        return null;
    }
    
    // 等待视频帧准备好
    if (elVideo.readyState < 2) {
        debugLogMsg('⏳ 等待视频帧...');
        await new Promise(resolve => {
            elVideo.onloadeddata = resolve;
            setTimeout(resolve, 2000);
        });
    }
    
    // 额外等待确保视频帧已渲染
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (!elVideo.videoWidth) {
        debugLogMsg('⚠️ 视频宽度为0，无法识别');
        return null;
    }
    
    debugLogMsg(`📷 视频尺寸: ${elVideo.videoWidth}x${elVideo.videoHeight}`);
    
    try {
        canvas.width = elVideo.videoWidth;
        canvas.height = elVideo.videoHeight;
        ctx.drawImage(elVideo, 0, 0, canvas.width, canvas.height);
        
        const detection = await faceapi.detectSingleFace(canvas).withFaceLandmarks().withFaceDescriptor();
        if (detection) {
            const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
            debugLogMsg(`👤 人脸识别: ${bestMatch.label} (距离: ${bestMatch.distance.toFixed(3)})`);
            if (bestMatch.label !== 'unknown') {
                return bestMatch.label;
            }
        } else {
            debugLogMsg('⚠️ 未检测到人脸');
        }
    } catch (e) {
        console.error('人脸识别失败', e);
        debugLogMsg(`❌ 人脸识别错误: ${e.message}`);
    }
    return null;
}

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
        debugLogMsg('✅ WS 连接代理服务器成功');
        // 第一条消息发给 Node.js 后端，带上配置要求去建连
        const initData = {
            type: 'init',
            apiKey: elApiKey.value.trim(),
            model: elModel.value,
            voice: elVoice.value,
            instructions: elInstructions.value
        };
        ws.send(JSON.stringify(initData));
        debugLogMsg(`📤 发送 init: model=${elModel.value}, voice=${elVoice.value}`);
    };

    ws.onmessage = (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
            debugLogMsg(`📥 收到: type=${msg.type}`);
        } catch (e) {
            debugLogMsg(`❌ 无法解析 WS 消息`);
            console.error('无法解析 WS 消息', e);
            return;
        }

        handleServerMessage(msg);
    };

    ws.onerror = (err) => {
        debugLogMsg('❌ WS 错误');
        console.error('WebSocket Error:', err);
        appendSystemMsg('WebSocket 连接发生错误');
    };

    ws.onclose = (event) => {
        debugLogMsg(`🔌 WS 断开: code=${event.code}`);
        console.log(`WebSocket 挂断: code=${event.code}, reason=${event.reason}`);
        appendSystemMsg(`连接已断开 (code: ${event.code})`);
        // 不要立即 cleanup，给 AI 回复一点时间
        setTimeout(() => {
            if (ws === null || ws.readyState === WebSocket.CLOSED) {
                cleanup();
            }
        }, 3000);
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
            debugLogMsg('🔊 收到 AI 音频数据，开始播放');
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

    let audioCount = 0;
    audioProcessor.port.onmessage = (event) => {
        if (!isConnected) return;
        
        const pcmData = event.data.pcm;
        audioCount++;
        if (audioCount % 10 === 0) {
            debugLogMsg(`🎤 采集音频: ${pcmData.byteLength} bytes`);
        }
        
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
                    debugLogMsg(`👤 人脸: ${bestMatch.label} (距离: ${bestMatch.distance.toFixed(3)})`);
                    if (bestMatch.label !== 'unknown') {
                        debugLogMsg(`✅ 识别成功，发送 face_match 信号`);
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'face_match',
                                name: bestMatch.label,
                                distance: bestMatch.distance
                            }));
                        } else {
                            debugLogMsg(`⚠️ WS 未连接，无法发送 face_match`);
                        }
                    }
                } else {
                    debugLogMsg(`⚠️ 未检测到人脸`);
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
        // 手机浏览器需要先恢复 AudioContext 才能播放
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        
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

function debugLogMsg(text) {
    if (!debugLog) return;
    const el = document.createElement('div');
    el.style.fontSize = '11px';
    el.style.color = '#64748b';
    el.style.wordBreak = 'break-all';
    el.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    debugLog.appendChild(el);
    debugLog.scrollTop = debugLog.scrollHeight;
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
