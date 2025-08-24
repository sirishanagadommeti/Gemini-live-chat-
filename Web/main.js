// Frontend: mic capture → ws://localhost:3000/ws → server → Gemini
// and audio playback (24kHz PCM16) from Gemini → server → browser
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

let ws;
let audioCtx;
let workletNode;
let playbackQueue = []; // Uint8Array chunks (PCM16 mono 24kHz)
let playing = false;

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

async function setupAudioWorklet() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  const workletUrl = URL.createObjectURL(new Blob([`(${micProcessor.toString()})()`], { type: 'text/javascript' }));
  await audioCtx.audioWorklet.addModule(workletUrl);
  workletNode = new AudioWorkletNode(audioCtx, 'mic-worklet');
  return workletNode;
}

// Inline worklet processor. Captures mic @ 48k, downsample to 16k, PCM16, posts to main thread.
function micProcessor() {
  class MicWorklet extends AudioWorkletProcessor {
    constructor() {
      super();
      this._resampleBuffer = [];
      this._sourceRate = sampleRate; // usually 48k
      this._targetRate = 16000;
      this._ratio = this._sourceRate / this._targetRate;
      this._acc = 0;
    }

    static get parameterDescriptors() { return []; }

    process(inputs) {
      const input = inputs[0];
      if (!input || input.length === 0) return true;
      const ch = input[0];
      if (!ch) return true;

      // Downsample by simple averaging (for demo; production: use polyphase filter)
      for (let i = 0; i < ch.length; i++) {
        this._acc += 1;
        if (this._acc >= this._ratio) {
          const idx = Math.floor(i);
          const sample = ch[idx];
          // Convert float (-1..1) to PCM16 LE
          let s = Math.max(-1, Math.min(1, sample));
          s = s < 0 ? s * 0x8000 : s * 0x7FFF;
          this._resampleBuffer.push(s);
          this._acc -= this._ratio;
        }
      }

      // Emit ~20ms chunks
      const samplesPerChunk = Math.floor(0.02 * this._targetRate);
      while (this._resampleBuffer.length >= samplesPerChunk) {
        const chunk = this._resampleBuffer.splice(0, samplesPerChunk);
        const buf = new ArrayBuffer(chunk.length * 2);
        const view = new DataView(buf);
        for (let i = 0; i < chunk.length; i++) {
          view.setInt16(i * 2, chunk[i], true);
        }
        this.port.postMessage(buf, [buf]);
      }

      return true;
    }
  }
  registerProcessor('mic-worklet', MicWorklet);
}

async function start() {
  if (ws) return;
  statusEl.textContent = 'connecting…';

  // Connect to our server
  ws = new WebSocket(`ws://${location.hostname}:3000/ws`);

  ws.onopen = () => {
    statusEl.textContent = 'connected';
    log('Connected to local server.');
  };

  ws.onerror = (e) => log('WS error: ' + e.message);
  ws.onclose = () => {
    statusEl.textContent = 'closed';
    log('Socket closed.');
    ws = null;
  };

  // Messages from server (Gemini responses). We expect JSON with either:
  // - serverContent.modelTurn.parts[].inlineData.data  (base64 audio)
  // - serverContent.interrupted === true               (barge-in signal)
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);

      // SetupComplete
      if (msg.setupComplete) {
        log('Gemini session ready.');
        return;
      }

      if (msg.serverContent) {
        if (msg.serverContent.interrupted) {
          // Clear queued audio to stop playback ASAP
          playbackQueue = [];
          log('Model interrupted (barge-in).');
        }
        // Inline audio data
        const mt = msg.serverContent.modelTurn;
        if (mt && mt.parts && mt.parts.length) {
          const part = mt.parts[0];
          if (part.inlineData && part.inlineData.data) {
            const b64 = part.inlineData.data;
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            // bytes are PCM16 LE 24kHz mono
            playbackQueue.push(bytes);
            if (!playing) {
              playing = true;
              playLoop(); // fire and forget
            }
          }
        }
        // Optional: show output transcription when present
        if (msg.serverContent.outputTranscription && msg.serverContent.outputTranscription.text) {
          log('Model (text): ' + msg.serverContent.outputTranscription.text);
        }
      }
    } catch (e) {
      console.warn('Bad message from server', e);
    }
  };

  // Audio capture
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await setupAudioWorklet();
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(workletNode);
  workletNode.connect(audioCtx.destination); // silent path; not audible

  workletNode.port.onmessage = (ev) => {
    const buf = ev.data; // ArrayBuffer PCM16 16kHz mono
    // Wrap in Live API realtimeInput envelope and send
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const envelope = {
      realtimeInput: {
        audio: {
          data: b64,
          mimeType: "audio/pcm;rate=16000"
        }
      }
    };
    ws?.send(JSON.stringify(envelope));
  };

  // Send a short greeting to kick things off (optional)
  ws?.send(JSON.stringify({
    clientContent: {
      turns: { role: "user", parts: [{ text: "Hi! Say hello and wait for me to speak. Keep answers short." }] },
      turnComplete: true
    }
  }));

  startBtn.disabled = true;
  stopBtn.disabled = false;
}

function stop() {
  if (ws) { ws.close(); ws = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  playbackQueue = [];
  playing = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = 'idle';
  log('Stopped.');
}

// Very small playback scheduler: stitch PCM16(24k) into AudioBuffers
async function playLoop() {
  if (!audioCtx) return;
  while (playing) {
    const bytes = playbackQueue.shift();
    if (!bytes) {
      // wait a moment for new chunks
      await new Promise(r => setTimeout(r, 10));
      if (!ws) break;
      continue;
    }
    // Convert PCM16 → Float32
    const len = bytes.byteLength / 2;
    const f32 = new Float32Array(len);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < len; i++) {
      const s = view.getInt16(i*2, true);
      f32[i] = s / 0x8000;
    }
    const buf = audioCtx.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(f32, 0);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
    // Let it finish before scheduling next to avoid pile‑up
    await new Promise(r => src.onended = r);
  }
}

startBtn.addEventListener('click', () => start().catch(e => log('Start failed: ' + e.message)));
stopBtn.addEventListener('click', () => stop());
