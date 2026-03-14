# 🌊 Float Translator v2.0

极简桌面悬浮翻译工具 — 文字翻译 + 实时语音识别翻译。

## 功能

| 功能 | 说明 |
|------|------|
| 📝 文字翻译 | 粘贴文字 → 选语言 → `⌘↵` 翻译 |
| 🎙️ 语音翻译 | 点击麦克风 → 实时说话 → 自动识别 + 翻译 |
| 🌍 支持语言 | 中、英、日、韩、法、德、西、俄 |
| ⌨️ 全局快捷键 | `Cmd+Shift+T` 显示/隐藏 |
| 📋 一键复制 | 悬停结果区显示复制按钮 |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 安装 ws 模块（语音识别必须）
npm install ws

# 3. 运行
npm start
```

## 配置

首次启动点击右上角 ⚙️，推荐选择 **阿里百炼**：

- API Key：在 [bailian.console.aliyun.com](https://bailian.console.aliyun.com) 创建
- 翻译模型：`qwen-turbo`（性价比最高）
- 语音识别：自动使用 `qwen3-asr-flash-realtime`，无需额外配置

## 语音翻译使用流程

```
切换到「语音」标签
    ↓
点击麦克风按钮（变红 = 录音中）
    ↓
说话 → 识别框实时显示文字
    ↓
停顿后自动触发翻译 → 译文显示在下方
    ↓
再次点击停止
```

## 支持的 API 提供商

| 提供商 | 文字翻译 | 语音识别 |
|--------|----------|----------|
| **阿里百炼** ⭐ | ✅ | ✅ |
| Anthropic Claude | ✅ | ❌ |
| OpenAI | ✅ | ❌ |
| 自定义（兼容 OpenAI） | ✅ | ❌ |

## 打包

```bash
# macOS DMG
npm run build:mac

# Windows
npm run build:win
```

## 项目结构

```
float-translator/
├── src/
│   ├── main.js        # 主进程（翻译 API + ASR WebSocket）
│   ├── store.js       # 本地配置持久化
│   ├── index.html     # 主窗口（文字 + 语音双模式）
│   └── settings.html  # 设置窗口
└── package.json
```
