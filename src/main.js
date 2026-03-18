const {
  app, BrowserWindow, ipcMain, globalShortcut,
  screen, nativeImage
} = require('electron');
const path = require('path');
const { net } = require('electron');
const Store = require('./store.js');

const store = new Store();

let mainWindow = null;
let settingsWindow = null;

// ─── Window Creation ──────────────────────────────────────────────────────────

function createMainWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 400,
    height: 260,
    x: width - 440,
    y: 60,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    minWidth: 320,
    minHeight: 140,
    maxWidth: 720,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return; }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 560,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();

  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus());
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── IPC: Config ──────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => store.get('config') || {});

ipcMain.handle('save-config', (_, config) => { store.set('config', config); return true; });

ipcMain.on('open-settings', () => createSettingsWindow());
ipcMain.on('close-settings', () => settingsWindow?.close());
ipcMain.on('close-main', () => { mainWindow?.close(); app.quit(); });
ipcMain.on('config-updated', () => mainWindow?.webContents.send('config-updated'));
ipcMain.on('resize-window', (event, width, height) => {
  if (mainWindow) {
    if (width && height) {
      const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
      const newX = screenWidth - width - 40; // 40px margin from right edge
      mainWindow.setSize(width, height);
      mainWindow.setPosition(newX, 60);
    } else if (height) {
      const currentSize = mainWindow.getSize();
      mainWindow.setSize(currentSize[0], height);
    }
  }
});

// ─── IPC: Text Translation ────────────────────────────────────────────────────

ipcMain.handle('translate', async (_, { text, targetLang }) => {
  const config = store.get('config') || {};
  if (!config.apiKey) throw new Error('Please configure API Key in settings first');
  return await callTranslateAPI(config, text, targetLang);
});

// ─── IPC: Voice Recognition (HTTP/2 SSE via main process) ──────────────────────
// We manage the HTTP streaming in the main process to avoid renderer sandbox issues.

let asrHttpStream = null;
let asrActive = false;
let audioBufferQueue = [];
let isStreaming = false;

ipcMain.on('asr-start', (event, { recognitionLang, targetLang }) => {
  const config = store.get('config') || {};
  if (!config.apiKey) {
    event.sender.send('asr-error', 'Please configure API Key first');
    return;
  }
  startASR(event.sender, config.apiKey, recognitionLang, targetLang);
});

ipcMain.on('asr-audio-chunk', (_, chunk) => {
  if (asrActive && isStreaming) {
    try {
      // Queue audio chunks for streaming
      audioBufferQueue.push(chunk);
    } catch (e) {
      console.error('[ASR] Failed to queue audio chunk:', e);
    }
  }
});

ipcMain.on('asr-stop', () => {
  stopASR();
});

async function startASR(sender, apiKey, recognitionLang, targetLang) {
  if (asrHttpStream) stopASR();

  // Use HTTP/2 streaming API
  const url = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription/streaming';

  // Language codes for recognition (input)
  const recognitionLangMap = {
    'zh-CN': 'zh', 'en-US': 'en', 'ja-JP': 'ja',
    'ko-KR': 'ko', 'fr-FR': 'fr', 'de-DE': 'de',
    'es-ES': 'es', 'ru-RU': 'ru'
  };
  
  // If auto, don't set language so server will auto-detect
  const inputLanguage = recognitionLang === 'auto' ? null : (recognitionLangMap[recognitionLang] || 'zh');
  
  // Language codes for translation (output)
  const translationLangMap = {
    'zh': 'zh', 'en': 'en', 'ja': 'ja',
    'ko': 'ko', 'fr': 'fr', 'de': 'de',
    'es': 'es', 'ru': 'ru'
  };
  const outputLanguage = translationLangMap[targetLang] || 'zh';

  try {
    asrActive = true;
    isStreaming = true;
    audioBufferQueue = [];

    // Start SSE connection for receiving results
    const sseUrl = `${url}?model=qwen3-asr-flash-realtime&language=${inputLanguage || 'auto'}&translation_language=${outputLanguage}`;
    
    // Create streaming request
    const request = net.request({
      method: 'POST',
      url: sseUrl,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'audio/pcm;rate=16000',
        'Accept': 'text/event-stream',
        'Transfer-Encoding': 'chunked'
      }
    });

    let responseData = '';
    
    request.on('response', (response) => {
      let buffer = '';
      
      response.on('data', (chunk) => {
        buffer += chunk.toString();
        
        // Process SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              handleASRMessage(sender, data);
            } catch (e) {
              console.error('[ASR] Failed to parse SSE data:', e);
            }
          }
        }
      });

      response.on('end', () => {
        asrActive = false;
        isStreaming = false;
        sender.send('asr-closed');
      });

      response.on('error', (err) => {
        console.error('[ASR] HTTP stream error:', err);
        sender.send('asr-error', 'Stream error: ' + (err.message || 'Unknown error'));
        asrActive = false;
        isStreaming = false;
      });
    });

    request.on('error', (err) => {
      console.error('[ASR] HTTP request error:', err);
      sender.send('asr-error', 'Connection error: ' + (err.message || 'Unknown error'));
      asrActive = false;
      isStreaming = false;
    });

    // Start streaming audio data
    const streamAudio = async () => {
      while (isStreaming && asrActive) {
        if (audioBufferQueue.length > 0) {
          const chunks = audioBufferQueue.splice(0, audioBufferQueue.length);
          for (const chunk of chunks) {
            request.write(chunk);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 40)); // ~25fps
      }
      request.end();
    };

    // Send initial request to establish connection
    request.write(Buffer.alloc(0)); // Empty chunk to start
    
    asrHttpStream = request;
    sender.send('asr-ready');
    
    // Start audio streaming loop
    streamAudio();
    
  } catch (e) {
    console.error('[ASR] Failed to start HTTP stream:', e);
    sender.send('asr-error', 'Failed to start: ' + e.message);
    asrActive = false;
    isStreaming = false;
  }
}

function handleASRMessage(sender, msg) {
  
  switch (msg.type) {
    case 'conversation.item.input_audio_transcription.delta':
      // Incremental transcript (source language)
      if (msg.delta) {
        sender.send('asr-transcript-delta', msg.delta);
      }
      break;
    case 'conversation.item.input_audio_transcription.completed':
      // Final transcript (source language)
      if (msg.transcript) {
        sender.send('asr-transcript-final', msg.transcript);
      }
      break;
    case 'response.done':
      // Final translation result
      if (msg.response?.output && msg.response.output.length > 0) {
        const item = msg.response.output[0];
        if (item.content && item.content.length > 0 && item.content[0].transcript) {
          sender.send('asr-translation-final', item.content[0].transcript);
        }
      }
      break;
    case 'input_audio_buffer.speech_started':
      sender.send('asr-speech-start');
      break;
    case 'input_audio_buffer.speech_stopped':
      sender.send('asr-speech-stop');
      break;
    case 'error':
      sender.send('asr-error', msg.error?.message || 'Unknown ASR error');
      break;
  }
}

function stopASR() {
  asrActive = false;
  isStreaming = false;
  audioBufferQueue = [];
  if (asrHttpStream) {
    try {
      asrHttpStream.end();
    } catch (e) {}
    asrHttpStream = null;
  }
}

// ─── Translation API ──────────────────────────────────────────────────────────

async function callTranslateAPI(config, text, targetLang) {
  const langMap = {
    zh: 'Chinese (Simplified)', en: 'English', ja: '日本語',
    ko: '한국어', fr: 'Français', de: 'Deutsch',
    es: 'Español', ru: 'Русский', pt: 'Português', it: 'Italiano'
  };

  const prompt = `Translate the following text to ${langMap[targetLang] || targetLang}. Output ONLY the translation, no explanations:\n\n${text}`;

  const { provider, apiKey, model, baseUrl } = config;
  let endpoint, headers, body;

  if (provider === 'anthropic') {
    endpoint = 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
    body = JSON.stringify({
      model: model || 'claude-3-haiku-20240307',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
  } else {
    // OpenAI / custom / Bailian
    endpoint = (baseUrl || 'https://api.openai.com/v1') + '/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };
    body = JSON.stringify({
      model: model || 'qwen-turbo',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
  }

  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url: endpoint });
    Object.entries(headers).forEach(([k, v]) => request.setHeader(k, v));
    let data = '';
    request.on('response', (res) => {
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const result = provider === 'anthropic'
            ? json.content?.[0]?.text
            : json.choices?.[0]?.message?.content;
          resolve(result || 'Translation failed');
        } catch (e) {
          reject(new Error('Response parsing failed'));
        }
      });
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}
