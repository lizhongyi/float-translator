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
ipcMain.on('close-main', () => mainWindow?.hide());
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

// ─── IPC: Voice Recognition (WebSocket via main process) ──────────────────────
// We manage the WebSocket in the main process to avoid renderer sandbox issues.

let asrWs = null;
let asrActive = false;

ipcMain.on('asr-start', (event, { recognitionLang, targetLang }) => {
  const config = store.get('config') || {};
  if (!config.apiKey) {
    event.sender.send('asr-error', 'Please configure API Key first');
    return;
  }
  startASR(event.sender, config.apiKey, recognitionLang, targetLang);
});

ipcMain.on('asr-audio-chunk', (_, chunk) => {
  if (asrWs && asrWs.readyState === 1 && asrActive) {
    try {
      const b64 = Buffer.from(chunk).toString('base64');
      asrWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: b64
      }));
    } catch (e) {
      console.error('[ASR] Failed to send audio chunk:', e);
    }
  }
});

ipcMain.on('asr-stop', () => {
  stopASR();
});

function startASR(sender, apiKey, recognitionLang, targetLang) {
  if (asrWs) stopASR();

  // Use live translation model
  const url = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-livetranslate-flash-realtime';

  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch (e) {
    sender.send('asr-error', 'Failed to load ws module, please install: npm install ws');
    return;
  }

  try {
    asrWs = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
  } catch (e) {
    sender.send('asr-error', 'Failed to create WebSocket: ' + e.message);
    return;
  }

  asrWs.on('open', () => {
    asrActive = true;
    // Init session with VAD and translation enabled
    try {
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
      
      let transcriptionConfig = {
        model: 'qwen3-asr-flash-realtime'
      };
      if (inputLanguage) {
        transcriptionConfig.language = inputLanguage;
      }
      
      let sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          input_audio_format: 'pcm16',
          input_audio_transcription: transcriptionConfig,
          translation: {
            language: outputLanguage  // Target language for translation
          },
          turn_detection: {
            type: 'server_vad',
            silence_duration_ms: 400,
            threshold: 0.5
          }
        }
      };
      asrWs.send(JSON.stringify(sessionUpdate));
    } catch (e) {
      console.error('[ASR] Failed to send session update:', e);
    }
    sender.send('asr-ready');
  });

  asrWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
    
      if (msg.response && msg.response.output) {
      }
      handleASRMessage(sender, msg);
    } catch (e) {}
  });

  asrWs.on('error', (err) => {
    console.error('[ASR] WebSocket error:', err);
    sender.send('asr-error', 'Connection error: ' + (err.message || 'Unknown error'));
    asrActive = false;
  });

  asrWs.on('close', (code, reason) => {
    asrActive = false;
    sender.send('asr-closed');
  });
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
  if (asrWs) {
    try {
      asrWs.send(JSON.stringify({ type: 'session.finish' }));
      asrWs.close();
    } catch (e) {}
    asrWs = null;
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
