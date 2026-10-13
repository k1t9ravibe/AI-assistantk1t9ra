// Голосовой ввод: запись с микрофона и распознавание локальной моделью Whisper (transformers.js).
// Модель скачивается в браузер один раз при первом использовании, звук на сервер не уходит.
import { pipeline, env } from "/vendor/transformers/transformers.min.js";

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("/vendor/onnxruntime-web/", location.origin).href;

const SAMPLE_RATE = 16000;

let transcriber = null; // { model, promise }
let recorder = null;
let chunks = [];

async function hasWebGpu() {
  try {
    return Boolean(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

function loadTranscriber(model, onStatus) {
  if (transcriber?.model === model) return transcriber.promise;
  const files = new Map();
  const promise = (async () => {
    // Видеокарта (WebGPU) в разы быстрее; если её нет — считаем на процессоре.
    if (await hasWebGpu()) {
      try {
        return await createPipeline(model, files, onStatus, {
          device: "webgpu",
          dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
        });
      } catch (err) {
        console.warn("WebGPU недоступен, переключаюсь на процессор:", err);
      }
    }
    return createPipeline(model, files, onStatus, { device: "wasm" });
  })();
  transcriber = { model, promise };
  promise.catch(() => { transcriber = null; });
  return promise;
}

async function createPipeline(model, files, onStatus, opts) {
  const asr = await pipeline("automatic-speech-recognition", model, {
    ...opts,
    progress_callback: (p) => {
      if (p.status === "progress" && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        onStatus?.(`Загружаю модель распознавания… ${Math.round((loaded / total) * 100)}% (только в первый раз)`);
      }
    },
  });
  // Прогрев: первый прогон самый медленный, делаем его на тишине, пока человек ещё говорит.
  await asr(new Float32Array(SAMPLE_RATE), { task: "transcribe" });
  return asr;
}

async function start() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!recorder) return resolve(null);
    recorder.onstop = () => {
      recorder.stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      resolve(new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }));
    };
    recorder.stop();
  });
}

async function toPcm(blob) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    return audio.getChannelData(0);
  } finally {
    ctx.close();
  }
}

async function transcribe(pcm, { model, language, onStatus }) {
  const asr = await loadTranscriber(model, onStatus);
  onStatus?.("Распознаю речь…");
  const opts = { task: "transcribe", chunk_length_s: 30, stride_length_s: 5 };
  if (language && language !== "auto") opts.language = language;
  const out = await asr(pcm, opts);
  return (out.text || "").trim();
}

// Останавливает запись и возвращает распознанный текст.
async function stop(options) {
  const blob = await stopRecording();
  if (!blob || !blob.size) return "";
  const pcm = await toPcm(blob);
  if (pcm.length < SAMPLE_RATE * 0.3) return "";
  return transcribe(pcm, options);
}

function cancel() {
  stopRecording();
}

window.voice = {
  start,
  stop,
  cancel,
  isRecording: () => Boolean(recorder),
  preload: (model, onStatus) => loadTranscriber(model, onStatus),
  transcribe, // для самопроверки
};
