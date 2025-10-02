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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyBaHbEbjIHrgJsJBdsNNEE3J10HO6QIBZc";
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

// Global data storage
let content = {};
let users = [];
const userStates = new Map();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function detectLanguage(text) {
  const lowerText = text.toLowerCase();
  
  if (lowerText.match(/goeie|dankie|asseblief|hoe|wat|kan|jammer|help|inenting|entstof/i)) {
    return 'af';
  }
  
  if (lowerText.match(/sawubona|ngiyabonga|ngicela|kanjani|yini|usizo|ukugoma|umgomo/i)) {
    return 'zu';
  }
  
  if (lowerText.match(/molo|enkosi|nceda|njani|yintoni|uncedo|ukugonya|isithintelo/i)) {
    return 'xh';
  }
  
  return 'en';
}

function isGreeting(text) {
  const greetings = [
    'hi', 'hello', 'hey', 'molo', 'sawubona', 'hallo', 
    'molweni', 'sanibonani', 'heita', 'howzit', 'good morning',
    'good afternoon', 'good evening', 'goeiedag', 'goeiemore'
  ];
  
  const lowerText = text.toLowerCase().trim();
  return greetings.some(greeting => 
    lowerText === greeting || lowerText.startsWith(greeting + ' ')
  );
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
    'ungxamiseko', 'ngxamisekile', 'nceda'
  ];
  
  const lowerText = text.toLowerCase();
  return emergencyKeywords.some(keyword => lowerText.includes(keyword));
}

function isWebsiteRequest(text) {
  const websiteKeywords = [
    'website', 'webwerf', 'iwebhusayithi', 'online', 'link', 'url', 'community', 'forum'
  ];
  
  const lowerText = text.toLowerCase();
  return websiteKeywords.some(keyword => lowerText.includes(keyword));
}

// ============================================================================
// GEMINI API
// ============================================================================

function buildSystemPrompt(language, userState) {
  const languageNames = {
    en: 'English',
    af: 'Afrikaans', 
    zu: 'isiZulu',
    xh: 'Xhosa'
  };
  
  let prompt = `You are Sister Botina, a friendly WhatsApp chatbot helping South African parents with child immunizations.

CRITICAL RULES:
1. Respond ONLY in ${languageNames[language]}
2. Keep responses SHORT - maximum 3-4 sentences
3. Use VERY SIMPLE language for people with low literacy levels
4. Be warm, kind, and never judgmental
5. Break complex words into simpler ones
6. If medical terms needed, explain them simply
7. For serious medical concerns, always say "Please visit your clinic"

YOUR PERSONALITY:
- Like a caring older sister or nurse
- Patient and understanding
- Encouraging and positive
- Never make parents feel guilty

CONTEXT ABOUT THIS USER:`;

  if (userState.childBirthDate) {
    const age = moment().diff(moment(userState.childBirthDate), 'months');
    prompt += `\n- Child's birth date: ${userState.childBirthDate} (${age} months old)`;
    prompt += `\n- Can calculate which vaccines are due`;
  } else {
    prompt += `\n- Child's birth date NOT provided yet`;
    prompt += `\n- If they ask about schedule, gently ask for birth date in format YYYY-MM-DD`;
  }
  
  prompt += `

SOUTH AFRICAN VACCINATION SCHEDULE:
- Birth: BCG (for TB), OPV (polio drops)
- 6 weeks: OPV, Rotavirus, 6-in-1 injection, Pneumonia vaccine
- 10 weeks: 6-in-1 injection (2nd), Pneumonia vaccine (2nd)
- 14 weeks: 6-in-1 injection (3rd), Pneumonia vaccine (3rd), Rotavirus (2nd)
- 9 months: Measles injection
- 18 months: Booster injections, Measles (2nd)

COMMON PARENT WORRIES (address these with empathy):
- "Are vaccines safe?" → Yes, very safe. Millions of children get them
- "Too many vaccines at once?" → Safe! Baby's immune system can handle it
- "Side effects?" → Usually mild: sore spot, slight fever. Goes away quickly
- "I missed an appointment" → It's okay! Just go to clinic soon to catch up
- "Natural immunity better?" → No, getting sick is more dangerous than vaccine

IMPORTANT REMINDERS:
- Always bring Road-to-Health book to clinic
- All vaccines are FREE at government clinics
- It's never too late to catch up on missed vaccines

RESPONSE STYLE:
❌ BAD: "Immunization is crucial for developing immunity against vaccine-preventable diseases."
✅ GOOD: "Vaccines help protect your baby from getting very sick. They're safe and free at the clinic!"`;

  return prompt;
}

async function callGeminiAPI(systemPrompt, userMessage, chatHistory) {
  const messages = [
    { 
      role: 'user', 
      parts: [{ text: systemPrompt }] 
    },
    { 
      role: 'model', 
      parts: [{ text: 'I understand. I will help parents with simple, kind, and clear advice about child vaccines in their language.' }] 
    }
  ];
  
  chatHistory.slice(-6).forEach(msg => {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  });
  
  const requestBody = {
    contents: messages,
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 250,
      topP: 0.9,
      topK: 40
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      }
    ]
  };
  
  const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Gemini API error:', errorText);
    throw new Error(`Gemini API error: ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('No response from Gemini API');
  }
  
  return data.candidates[0].content.parts[0].text;
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

async function sendWelcomeMessage(message, language) {
  const welcomeText = content[language]?.welcome || content.en?.welcome || 
    "Hello! I'm Sister Botina. I help parents with child vaccinations. What would you like to know?";
  await message.reply(welcomeText);
}

async function handleEmergencyRequest(message, language) {
  const emergencyText = content[language]?.emergency_contacts || content.en?.emergency_contacts ||
    "Emergency: Call 10177\nER24: 084 124\nNetcare: 082 911";
  await message.reply(emergencyText);
}

async function handleWebsiteRequest(message, language) {
  const websiteText = content[language]?.website_info || content.en?.website_info ||
    "Visit our website: https://sister-botina-companion-app-744.created.app/";
  await message.reply(websiteText);
}

async function processNaturalLanguageQuery(message, userState) {
  const userMessage = message.body.trim();
  const language = userState.language;
  
  userState.chatHistory.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date()
  });
  
  const systemPrompt = buildSystemPrompt(language, userState);
  
  try {
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
      
      const confirmMessage = (content[language]?.birthdate_confirmed || content.en?.birthdate_confirmed || 
        "Thank you! I've saved your child's birth date as %BIRTHDATE%.")
        .replace('%BIRTHDATE%', birthDate);
      await message.reply(confirmMessage);
    }
    
    await message.reply(response);
    
    userState.chatHistory.push({
      role: 'assistant',
      content: response,
      timestamp: new Date()
    });
    
    if (userState.chatHistory.length > 20) {
      userState.chatHistory = userState.chatHistory.slice(-20);
    }
    
  } catch (error) {
    console.error('Gemini API error:', error);
    const errorMsg = content[language]?.error_message || "Sorry, I'm having trouble right now. Please try again.";
    await message.reply(errorMsg);
  }
}

async function handleIncomingMessage(message) {
  const userId = message.from;
  const userMessage = message.body.trim();
  
  console.log(`Message from ${userId}: ${userMessage}`);
  
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      language: null,
      childBirthDate: null,
      chatHistory: [],
      hasGreeted: false
    });
  }
  
  const userState = userStates.get(userId);
  
  if (!userState.language) {
    userState.language = detectLanguage(userMessage);
    console.log(`Language detected: ${userState.language}`);
  }
  
  if (isEmergencyRequest(userMessage)) {
    await handleEmergencyRequest(message, userState.language);
    return;
  }
  
  if (isWebsiteRequest(userMessage)) {
    await handleWebsiteRequest(message, userState.language);
    return;
  }
  
  if (!userState.hasGreeted && isGreeting(userMessage)) {
    userState.hasGreeted = true;
    userStates.set(userId, userState);
    await sendWelcomeMessage(message, userState.language);
    return;
  }
  
  await processNaturalLanguageQuery(message, userState);
}

async function loadInitialData() {
  try {
    content = await readJsonFile('content.json');
    console.log('✓ Content loaded');
    
    users = await loadUsersFromSupabase();
    console.log(`✓ Loaded ${users.length} users`);
    
    users.forEach(user => {
      userStates.set(user.whatsappId, {
        language: user.language || 'en',
        childBirthDate: user.childBirthDate || null,
        chatHistory: user.chatHistory || [],
        hasGreeted: true
      });
    });
  } catch (error) {
    console.error('Data loading error:', error);
    content = {};
    users = [];
  }
}

// ============================================================================
// WHATSAPP EVENT LISTENERS
// ============================================================================

client.on('qr', (qr) => {
  console.log('\n=================================');
  console.log('SCAN THIS QR CODE WITH WHATSAPP:');
  console.log('=================================\n');
  qrcode.generate(qr, { small: true });
  console.log('\n=================================\n');
});

client.on('authenticated', () => {
  console.log('✓ WhatsApp authenticated!');
});

client.on('auth_failure', (msg) => {
  console.error('✗ Authentication failed:', msg);
});

client.on('ready', async () => {
  console.log('\n========================================');
  console.log('Sister Botina 2.0 is ready!');
  console.log('========================================\n');
  
  await loadInitialData();
  
  if (typeof startReminderScheduler === 'function') {
    startReminderScheduler(client, users, content);
    console.log('✓ Reminder scheduler started');
  }
});

client.on('message', async (message) => {
  if (message.from.endsWith('@g.us') || message.fromMe) {
    return;
  }
  
  try {
    await handleIncomingMessage(message);
  } catch (error) {
    console.error('Error handling message:', error);
    try {
      await message.reply("Sorry, something went wrong. Please try again.");
    } catch (replyError) {
      console.error('Could not send error message:', replyError);
    }
  }
});

client.on('disconnected', (reason) => {
  console.log('✗ Client disconnected:', reason);
});

// ============================================================================
// START THE BOT
// ============================================================================

console.log('Starting Sister Botina 2.0...');
console.log('Node version:', process.version);
console.log('Express server started for keep-alive');

client.initialize().catch(err => {
  console.error('Failed to initialize WhatsApp client:', err);
});
