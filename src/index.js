// Sister Botina 2.0 - Replit Compatible Version
// Natural Language WhatsApp Chatbot for South African Parents

// ============================================================================
// KEEP-ALIVE SERVER (Prevents Replit from sleeping)
// ============================================================================
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Sister Botina 2.0</title></head>
      <body style="font-family: Arial; padding: 40px; text-align: center;">
        <h1>🤖 Sister Botina 2.0</h1>
        <p style="color: green; font-size: 20px;">✓ WhatsApp Bot is Running</p>
        <p>Uptime: ${Math.floor(process.uptime())} seconds</p>
        <p style="color: #666;">This server keeps the bot alive on Replit</p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// ✅ Replit requires port 5000 and host 0.0.0.0
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Keep-alive server running on port ${PORT}`);
});

// ============================================================================
// WHATSAPP BOT (Runs in parallel with Express)
// ============================================================================
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const fetch = require('node-fetch');
const { readJsonFile, saveUserToSupabase, loadUsersFromSupabase } = require('./utils/fileHandler');
const { startReminderScheduler } = require('./utils/reminderScheduler');

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent";

// Initialize WhatsApp Client with Replit-optimized settings
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

// ============================================================================
// GLOBAL STATE
// ============================================================================
let content = {};
let users = [];
const userStates = new Map();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function detectLanguage(text) {
  const lowerText = text.toLowerCase();
  if (lowerText.match(/goeie|dankie|asseblief|hoe|wat|kan|jammer|help|inenting|entstof/i)) return 'af';
  if (lowerText.match(/sawubona|ngiyabonga|ngicela|kanjani|yini|usizo|ukugoma|umgomo/i)) return 'zu';
  if (lowerText.match(/molo|enkosi|nceda|njani|yintoni|uncedo|ukugonya|isithintelo/i)) return 'xh';
  return 'en';
}

function isGreeting(text) {
  const greetings = [
    'hi', 'hello', 'hey', 'molo', 'sawubona', 'hallo',
    'molweni', 'sanibonani', 'heita', 'howzit', 'good morning',
    'good afternoon', 'good evening', 'goeiedag', 'goeiemore'
  ];
  const lowerText = text.toLowerCase().trim();
  return greetings.some(g => lowerText === g || lowerText.startsWith(g + ' '));
}

function extractBirthDate(text) {
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const date = moment(match[0], 'YYYY-MM-DD', true);
    if (date.isValid() && date.isBefore(moment()) && date.isAfter(moment().subtract(5, 'years'))) {
      return match[0];
    }
  }
  return null;
}

function isEmergencyRequest(text) {
  const emergencyKeywords = [
    'emergency', 'urgent', 'help me', 'emergency number', 'ambulance',
    'noodgeval', 'dringend', 'help my', 'ambulans',
    'isimo esiphuthumayo', 'ngishesha', 'ngisize', 'i-ambulensi',
    'ungxamiseko', 'ngxamisekile', 'nceda'
  ];
  return emergencyKeywords.some(k => text.toLowerCase().includes(k));
}

function isWebsiteRequest(text) {
  const websiteKeywords = ['website','webwerf','iwebhusayithi','online','link','url','community','forum'];
  return websiteKeywords.some(k => text.toLowerCase().includes(k));
}

// ============================================================================
// GEMINI API
// ============================================================================
function buildSystemPrompt(language, userState) {
  const languageNames = { en: 'English', af: 'Afrikaans', zu: 'isiZulu', xh: 'Xhosa' };
  let prompt = `You are Sister Botina, a friendly WhatsApp chatbot helping South African parents with child immunizations.

CRITICAL RULES:
1. Respond ONLY in ${languageNames[language]}
2. Keep responses SHORT (max 3–4 sentences)
3. Use SIMPLE words
4. Be warm, kind, never judgmental
5. If medical terms needed, explain them simply
6. For serious issues, always say "Please visit your clinic"`;

  if (userState.childBirthDate) {
    const age = moment().diff(moment(userState.childBirthDate), 'months');
    prompt += `\n\nChild's birth date: ${userState.childBirthDate} (${age} months old).`;
  } else {
    prompt += `\n\nChild's birth date not provided yet. If they ask about vaccines, gently ask for YYYY-MM-DD.`;
  }
  return prompt;
}

async function callGeminiAPI(systemPrompt, userMessage, chatHistory) {
  const messages = [
    { role: 'user', parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'I understand. I will reply simply, kindly, and clearly.' }] },
    ...chatHistory.slice(-6).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }))
  ];

  const res = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: messages })
  });
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I didn’t understand.";
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================
async function sendWelcomeMessage(message, language) {
  await message.reply(
    content[language]?.welcome ||
    content.en?.welcome ||
    "Hello! I'm Sister Botina. I help parents with child vaccinations. What would you like to know?"
  );
}

async function handleEmergencyRequest(message, language) {
  await message.reply(
    content[language]?.emergency_contacts ||
    content.en?.emergency_contacts ||
    "🚨 Emergency: 10177 (Ambulance), 084 124 (ER24), 082 911 (Netcare)"
  );
}

async function handleWebsiteRequest(message, language) {
  await message.reply(
    content[language]?.website_info ||
    content.en?.website_info ||
    "🌐 Visit: https://sister-botina-companion-app-744.created.app/"
  );
}

async function processNaturalLanguageQuery(message, userState) {
  const userMessage = message.body.trim();
  const language = userState.language;
  userState.chatHistory.push({ role: 'user', content: userMessage });

  const systemPrompt = buildSystemPrompt(language, userState);
  try {
    const response = await callGeminiAPI(systemPrompt, userMessage, userState.chatHistory);

    const birthDate = extractBirthDate(userMessage);
    if (birthDate && !userState.childBirthDate) {
      userState.childBirthDate = birthDate;
      await saveUserToSupabase({
        whatsappId: message.from,
        language,
        childBirthDate: birthDate,
        chatHistory: userState.chatHistory
      });
      await message.reply(`✅ Thank you! I've saved your child's birth date as ${birthDate}.`);
    }

    await message.reply(response);
    userState.chatHistory.push({ role: 'assistant', content: response });
    if (userState.chatHistory.length > 20) {
      userState.chatHistory = userState.chatHistory.slice(-20);
    }
  } catch (err) {
    console.error('Gemini API error:', err);
    await message.reply(content[language]?.error_message || "Sorry, I'm having trouble. Please try again.");
  }
}

async function handleIncomingMessage(message) {
  const userId = message.from;
  const userMessage = message.body.trim();
  if (!userStates.has(userId)) {
    userStates.set(userId, { language: detectLanguage(userMessage), childBirthDate: null, chatHistory: [], hasGreeted: false });
  }
  const userState = userStates.get(userId);

  if (isEmergencyRequest(userMessage)) return handleEmergencyRequest(message, userState.language);
  if (isWebsiteRequest(userMessage)) return handleWebsiteRequest(message, userState.language);
  if (!userState.hasGreeted && isGreeting(userMessage)) {
    userState.hasGreeted = true;
    return sendWelcomeMessage(message, userState.language);
  }
  return processNaturalLanguageQuery(message, userState);
}

async function loadInitialData() {
  try {
    content = await readJsonFile('content.json');
    users = await loadUsersFromSupabase();
    users.forEach(u => {
      userStates.set(u.whatsappId, {
        language: u.language || 'en',
        childBirthDate: u.childBirthDate || null,
        chatHistory: u.chatHistory || [],
        hasGreeted: true
      });
    });
    console.log(`✓ Loaded ${users.length} users`);
  } catch (e) {
    console.error('Data load error:', e);
  }
}

// ============================================================================
// WHATSAPP EVENT LISTENERS
// ============================================================================
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('authenticated', () => console.log('✓ WhatsApp authenticated!'));
client.on('auth_failure', msg => console.error('✗ Authentication failed:', msg));
client.on('ready', async () => {
  console.log('🚀 Sister Botina 2.0 is ready!');
  await loadInitialData();
  if (typeof startReminderScheduler === 'function') {
    startReminderScheduler(client, users, content);
    console.log('✓ Reminder scheduler started');
  }
});
client.on('message', msg => { if (!msg.from.endsWith('@g.us') && !msg.fromMe) handleIncomingMessage(msg); });
client.on('disconnected', reason => console.log('✗ Client disconnected:', reason));

// ============================================================================
// START BOT
// ============================================================================
console.log('🚀 Starting Sister Botina 2.0...');
client.initialize().catch(err => console.error('Failed to init WhatsApp client:', err));

