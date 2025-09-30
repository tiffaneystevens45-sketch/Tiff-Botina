// Sister Botina 2.0 - Natural Language WhatsApp Chatbot
// For South African Parents - Immunization Support

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const fetch = require('node-fetch');
const { readJsonFile, saveUserToSupabase, loadUsersFromSupabase } = require('./utils/fileHandler');
const { startReminderScheduler } = require('./utils/reminderScheduler');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Health check endpoint for uptime monitors
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

const GEMINI_API_KEY = "AIzaSyBaHbEbjIHrgJsJBdsNNEE3J10HO6QIBZc"; // Your API key
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent";

// Initialize WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Global data storage
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
  const datePattern = /(\d{4})-(\d{2})-(\d{2})/;
  const match = text.match(datePattern);
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
    'ungxamiseko', 'ngxamisekile', 'nceda', 'i-ambulensi'
  ];
  return emergencyKeywords.some(k => text.toLowerCase().includes(k));
}

function isWebsiteRequest(text) {
  const websiteKeywords = [
    'website', 'webwerf', 'iwebhusayithi', 'online', 'link', 'url', 'community', 'forum'
  ];
  return websiteKeywords.some(k => text.toLowerCase().includes(k));
}

// ============================================================================
// GEMINI API INTEGRATION
// ============================================================================

function buildSystemPrompt(language, userState) {
  const languageNames = { en: 'English', af: 'Afrikaans', zu: 'isiZulu', xh: 'Xhosa' };
  let prompt = `You are Sister Botina, a friendly WhatsApp chatbot helping South African parents with child immunizations.

CRITICAL RULES:
1. Respond ONLY in ${languageNames[language]}
2. Keep responses SHORT - maximum 3-4 sentences
3. Use VERY SIMPLE language
4. Be warm and kind
5. For serious medical concerns, always say "Please visit your clinic"

CONTEXT ABOUT THIS USER:`;

  if (userState.childBirthDate) {
    const age = moment().diff(moment(userState.childBirthDate), 'months');
    prompt += `\n- Child's birth date: ${userState.childBirthDate} (${age} months old)`;
  } else {
    prompt += `\n- Child's birth date NOT provided yet`;
  }

  prompt += `
SOUTH AFRICAN VACCINATION SCHEDULE:
- Birth: BCG, OPV
- 6 weeks: OPV, Rotavirus, 6-in-1, Pneumonia
- 10 weeks: 6-in-1 (2nd), Pneumonia (2nd)
- 14 weeks: 6-in-1 (3rd), Pneumonia (3rd), Rotavirus (2nd)
- 9 months: Measles
- 18 months: Boosters + Measles (2nd)`;

  return prompt;
}

async function callGeminiAPI(systemPrompt, userMessage, chatHistory) {
  const messages = [
    { role: 'user', parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'I understand. I will help parents with clear advice.' }] }
  ];

  chatHistory.slice(-6).forEach(msg => {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  });

  const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: messages,
      generationConfig: { temperature: 0.8, maxOutputTokens: 250, topP: 0.9, topK: 40 }
    })
  });

  if (!response.ok) throw new Error(`Gemini API error: ${response.statusText}`);
  const data = await response.json();
  if (!data.candidates || data.candidates.length === 0) throw new Error('No response from Gemini API');
  return data.candidates[0].content.parts[0].text;
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

async function sendWelcomeMessage(message, language) {
  await message.reply(content[language].welcome);
}

async function handleEmergencyRequest(message, language) {
  await message.reply(content[language].emergency_contacts);
}

async function handleWebsiteRequest(message, language) {
  await message.reply(content[language].website_info);
}

async function processNaturalLanguageQuery(message, userState) {
  const userMessage = message.body.trim();
  const language = userState.language;
  userState.chatHistory.push({ role: 'user', content: userMessage });

  const systemPrompt = buildSystemPrompt(language, userState);
  const response = await callGeminiAPI(systemPrompt, userMessage, userState.chatHistory);

  const birthDate = extractBirthDate(userMessage);
  if (birthDate && !userState.childBirthDate) {
    userState.childBirthDate = birthDate;
    await saveUserToSupabase({
      whatsappId: message.from,
      language: userState.language,
      childBirthDate: birthDate,
      chatHistory: userState.chatHistory
    });
    await message.reply(content[language].birthdate_confirmed.replace('%BIRTHDATE%', birthDate));
  }

  await message.reply(response);
  userState.chatHistory.push({ role: 'assistant', content: response });

  if (userState.chatHistory.length > 20) {
    userState.chatHistory = userState.chatHistory.slice(-20);
  }
}

// ============================================================================
// CLIENT EVENTS
// ============================================================================

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('WhatsApp client is ready!');
  users = await loadUsersFromSupabase();
  startReminderScheduler(client, users);
});

client.on('message', async message => {
  const from = message.from;
  if (!userStates.has(from)) {
    userStates.set(from, { language: detectLanguage(message.body), chatHistory: [] });
  }
  const userState = userStates.get(from);

  if (isGreeting(message.body)) {
    await sendWelcomeMessage(message, userState.language);
  } else if (isEmergencyRequest(message.body)) {
    await handleEmergencyRequest(message, userState.language);
  } else if (isWebsiteRequest(message.body)) {
    await handleWebsiteRequest(message, userState.language);
  } else {
    await processNaturalLanguageQuery(message, userState);
  }
});

// ============================================================================
// START BOT
// ============================================================================

client.initialize();
