import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODEL = "models/gemini-2.5-flash-preview-native-audio-dialog"; // native audio dialog
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY in .env");
  process.exit(1);
}

const app = express();

// Serve static web assets via Vite dev server for convenience:
const vite = await (await import('vite')).createServer({
  root: path.join(__dirname, "..", "web"),
  server: { port: 5173, strictPort: true },
});
await vite.listen();

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (client) => {
  console.log('Client connected');

  // Create a Gemini Live API websocket for this client session
  const gemini = new WebSocket(`${GEMINI_WS_URL}?key=${encodeURIComponent(API_KEY)}`);

  gemini.on('open', () => {
    console.log('Connected to Gemini Live API');
    // Send setup message: model + response modality AUDIO + system instruction
    const setup = {
      setup: {
        model: MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          // Optional speech/voice configuration can go here when supported.
        },
        // Keep the system instruction short and crisp.
        systemInstruction: {
          role: "system",
          parts: [{ text: "You are a friendly, concise voice assistant. Speak in short, natural sentences. If the user interrupts, immediately stop and listen. Use an upbeat, professional tone." }]
        },
        // Let the server do automatic VAD so user can barge in naturally.
        realtimeInputConfig: {
          automaticActivityDetection: {}
        },
        // Enable transcription of the model's audio output (optional)
        outputAudioTranscription: {}
      }
    };
    gemini.send(JSON.stringify(setup));
  });

  // Relay messages from browser to Gemini
  client.on('message', (data, isBinary) => {
    // Browser sends either JSON (control/text) or binary audio chunks already wrapped.
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        gemini.send(JSON.stringify(msg));
      } catch (e) {
        console.warn('Invalid JSON from client:', e);
      }
    } else {
      // If you ever choose to send raw PCM bytes from the browser,
      // you could wrap them here into the expected Live API JSON envelope.
      const envelope = {
        realtimeInput: {
          audio: {
            data: Buffer.from(data).toString('base64'),
            mimeType: "audio/pcm;rate=16000"
          }
        }
      };
      gemini.send(JSON.stringify(envelope));
    }
  });

  client.on('close', () => {
    console.log('Client disconnected');
    try { gemini.close(); } catch {}
  });

  // Relay Gemini -> browser
  gemini.on('message', (data) => {
    // Forward raw JSON directly to client; client knows how to play audio & handle interruptions.
    client.send(data);
  });

  gemini.on('close', (code, reason) => {
    console.log('Gemini socket closed:', code, reason.toString());
    try { client.close(); } catch {}
  });

  gemini.on('error', (err) => {
    console.error('Gemini socket error:', err.message);
    client.send(JSON.stringify({ error: 'Gemini connection error', detail: err.message }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  console.log(`Frontend served by Vite at http://localhost:5173`);
});
