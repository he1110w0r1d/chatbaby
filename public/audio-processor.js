/**
 * AudioWorklet Processor - 麦克风音频采集处理器
 * 将浏览器原生采样率（通常 44.1kHz/48kHz）的音频降采样为 16kHz 16bit 单声道 PCM
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputBuffer = [];
    this.targetSampleRate = 16000;
    // 每 100ms 发送一次，16kHz × 0.1s = 1600 samples
    this.chunkSamples = 1600;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // 单声道

    // 累积输入样本
    for (let i = 0; i < channelData.length; i++) {
      this.inputBuffer.push(channelData[i]);
    }

    // 计算降采样比率
    const ratio = sampleRate / this.targetSampleRate;
    const inputSamplesNeeded = Math.ceil(this.chunkSamples * ratio);

    // 当累积足够样本时，降采样并发送
    while (this.inputBuffer.length >= inputSamplesNeeded) {
      const pcm16 = new Int16Array(this.chunkSamples);

      for (let i = 0; i < this.chunkSamples; i++) {
        const srcIdx = Math.min(Math.floor(i * ratio), inputSamplesNeeded - 1);
        const sample = Math.max(-1, Math.min(1, this.inputBuffer[srcIdx]));
        // Float32 → Int16
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      // 发送 PCM 数据到主线程
      this.port.postMessage({ pcm: pcm16.buffer }, [pcm16.buffer]);

      // 移除已处理的样本
      this.inputBuffer.splice(0, inputSamplesNeeded);
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
