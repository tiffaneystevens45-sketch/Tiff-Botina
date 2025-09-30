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

/**
 * Detect language from user input using keyword matching
 */
function detectLanguage(text) {
  const lowerText = text.toLowerCase();
  
  // Afrikaans indicators
  if (lowerText.match(/goeie|dankie|asseblief|hoe|wat|kan|jammer|help|inenting|entstof/i)) {
    return 'af';
  }
  
  // isiZulu indicators
  if (lowerText.match(/sawubona|ngiyabonga|ngicela|kanjani|yini|usizo|ukugoma|umgomo/i)) {
    return 'zu';
  }
  
  // Xhosa indicators
  if (lowerText.match(/molo|enkosi|nceda|njani|yintoni|uncedo|ukugonya|isithintelo/i)) {
    return 'xh';
  }
  
  // Default to English
  return 'en';
}

/**
 * Check if message is a greeting
 */
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

/**
 * Extract birth date from message (format: YYYY-MM-DD)
 */
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

/**
 * Check if user is asking for emergency help
 */
function isEmergencyRequest(text) {
  const emergencyKeywords = [
    'emergency', 'urgent', 'help me', 'emergency number', 'ambulance',
    'noodgeval', 'dringend', 'help my', 'ambulans',
    'isimo esiphuthumayo', 'ngishesha', 'ngisize', 'i-ambulensi',
    'ungxamiseko', 'ngxamisekile', 'nceda', 'i-ambulensi'
  ];
  
  const lowerText = text.toLowerCase();
  return emergencyKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Check if user is asking about the website
 */
function isWebsiteRequest(text) {
  const websiteKeywords = [
    'website', 'webwerf', 'iwebhusayithi', 'iwebhusayithi',
    'online', 'link', 'url', 'community', 'forum'
  ];
  
  const lowerText = text.toLowerCase();
  return websiteKeywords.some(keyword => lowerText.includes(keyword));
}

// ============================================================================
// GEMINI API INTEGRATION
// ============================================================================

/**
 * Build system prompt based on language and context
 */
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
✅ GOOD: "Vaccines help protect your baby from getting very sick. They're safe and free at the clinic!"

❌ BAD: "The DTaP-IPV-Hib-HepB vaccine contains antigens that..."
✅ GOOD: "Your baby will get one injection that protects against 6 diseases. It's safe!"`;

  return prompt;
}

/**
 * Call Gemini API for natural language response
 */
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
  
  // Add recent chat history for context (last 3 exchanges = 6 messages)
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

/**
 * Send welcome message
 */
async function sendWelcomeMessage(message, language) {
  const welcomeText = content[language].welcome;
  await message.reply(welcomeText);
}

/**
 * Handle emergency requests
 */
async function handleEmergencyRequest(message, language) {
  const emergencyText = content[language].emergency_contacts;
  await message.reply(emergencyText);
}

/**
 * Handle website requests
 */
async function handleWebsiteRequest(message, language) {
  const websiteText = content[language].website_info;
  await message.reply(websiteText);
}

/**
 * Process natural language query through Gemini
 */
async function processNaturalLanguageQuery(message, userState) {
  const userMessage = message.body.trim();
  const language = userState.language;
  
  // Add to chat history
  userState.chatHistory.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date()
  });
  
  // Build context-aware prompt
  const systemPrompt = buildSystemPrompt(language, userState);
  
  try {
    // Call Gemini API
    const response = await callGeminiAPI(systemPrompt, userMessage, userState.chatHistory);
    
    // Extract birth date if provided
    const birthDate = extractBirthDate(userMessage);
    if (birthDate && !userState.childBirthDate) {
      userState.childBirthDate = birthDate;
      userState.hasProvidedBirthDate = true;
      
      // Save to database
      await saveUserToSupabase({
        whatsappId: message.from,
        language: userState.language,
        childBirthDate: birthDate,
        chatHistory: userState.chatHistory
      });
      
      // Send confirmation
      const confirmMessage = content[language].birthdate_confirmed.replace('%BIRTHDATE%', birthDate);
      await message.reply(confirmMessage);
      
      // Then send the AI response
      await message.reply(response);
    } else {
      // Just send the AI response
      await message.reply(response);
    }
    
    // Add assistant response to history
    userState.chatHistory.push({
      role: 'assistant',
      content: response,
      timestamp: new Date()
    });
    
    // Keep only last 10 exchanges (20 messages) to manage memory
    if (userState.chatHistory.length > 20) {
      userState.chatHistory = userState.chatHistory.slice(-20);
    }
    
    // Update user state in database periodically
    await saveUserToSupabase({
      whatsappId: message.from,
      language: userState.language,
      childBirthDate: userState.childBirthDate,
      chatHistory: userState.chatHistory
    });
    
  } catch (error) {
    console.error('Gemini API error:', error);
    const errorMsg = content[language]?.error_message || "Sorry, I'm having trouble right now. Please try again.";
    await message.reply(errorMsg);
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Handle incoming WhatsApp message
 */
async function handleIncomingMessage(message) {
  const userId = message.from;
  const userMessage = message.body.trim();
  
  console.log(`Message from ${userId}: ${userMessage}`);
  
  // Initialize or get user state
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      language: null,
      childBirthDate: null,
      chatHistory: [],
      hasGreeted: false
    });
  }
  
  const userState = userStates.get(userId);
  
  // Detect language if not set
  if (!userState.language) {
    userState.language = detectLanguage(userMessage);
    console.log(`Language detected: ${userState.language}`);
  }
  
  // Check for emergency requests first
  if (isEmergencyRequest(userMessage)) {
    await handleEmergencyRequest(message, userState.language);
    return;
  }
  
  // Check for website requests
  if (isWebsiteRequest(userMessage)) {
    await handleWebsiteRequest(message, userState.language);
    return;
  }
  
  // Handle first-time greetings
  if (!userState.hasGreeted && isGreeting(userMessage)) {
    userState.hasGreeted = true;
    userStates.set(userId, userState);
    await sendWelcomeMessage(message, userState.language);
    return;
  }
  
  // Process all other messages through NLP
  await processNaturalLanguageQuery(message, userState);
}

// ============================================================================
// DATA LOADING
// ============================================================================

/**
 * Load initial data from JSON and Supabase
 */
async function loadInitialData() {
  try {
    content = await readJsonFile('content.json');
    console.log('✓ Content loaded from content.json');
    
    users = await loadUsersFromSupabase();
    console.log(`✓ Loaded ${users.length} users from database`);
    
    // Initialize userStates from persisted data
    users.forEach(user => {
      userStates.set(user.whatsappId, {
        language: user.language || 'en',
        childBirthDate: user.childBirthDate || null,
        chatHistory: user.chatHistory || [],
        hasGreeted: true
      });
    });
    
    console.log('✓ Initial data loaded successfully');
  } catch (error) {
    console.error('Failed to load initial data:', error);
    // Continue anyway with empty data
    content = {};
    users = [];
  }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

client.on('qr', (qr) => {
  console.log('\n=================================');
  console.log('SCAN THIS QR CODE WITH WHATSAPP:');
  console.log('=================================\n');
  qrcode.generate(qr, { small: true });
  console.log('\n=================================\n');
});

client.on('authenticated', () => {
  console.log('✓ WhatsApp authenticated successfully!');
});

client.on('auth_failure', (msg) => {
  console.error('✗ Authentication failed:', msg);
});

client.on('ready', async () => {
  console.log('\n========================================');
  console.log('🎉 Sister Botina 2.0 is ready!');
  console.log('========================================\n');
  
  await loadInitialData();
  
  // Start reminder scheduler if needed
  if (typeof startReminderScheduler === 'function') {
    startReminderScheduler(client, users, content);
    console.log('✓ Reminder scheduler started');
  }
});

client.on('message', async (message) => {
  // Ignore group messages
  if (message.from.endsWith('@g.us')) {
    return;
  }
  
  // Ignore messages from self
  if (message.fromMe) {
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
  console.log('✗ Client was disconnected:', reason);
});

// ============================================================================
// START THE BOT
// ============================================================================

console.log('Starting Sister Botina 2.0...');
console.log('Node version:', process.version);
console.log('Environment:', process.env.NODE_ENV || 'development');

client.initialize().catch(err => {
  console.error('Failed to initialize client:', err);
  process.exit(1);
});
