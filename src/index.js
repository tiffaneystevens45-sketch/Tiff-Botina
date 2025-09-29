const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const fetch = require('node-fetch');
// Assuming these utility functions are available in the runtime environment
const { readJsonFile, saveUserToSupabase, loadUsersFromSupabase } = require('./utils/fileHandler');
const { startReminderScheduler, calculateVaccineDate } = require('./utils/reminderScheduler');

// ======================================================================
// SISTER BOTINA 2.0 - CONVERSATIONAL CHATBOT LOGIC
// The menu has been removed as the default interaction.
// All non-menu-command inputs default to the Gemini NLP engine.
// ======================================================================

// Initialize WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Gemini API Configuration
const GEMINI_API_KEY = "AIzaSyBaHbEbjIHrgJsJBdsNNEE3J10HO6QIBZc";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent";

// Global state for content and users
let content = {};
let users = [];

// In-memory user state management.
const userStates = new Map();

// ======================================================================
// CORE SYSTEM INSTRUCTION FOR LOW-LITERACY COMPREHENSION
// This is the most critical change to meet the requirement.
// The language is included dynamically in handleGeminiQuery.
// ======================================================================
const BASE_SYSTEM_INSTRUCTION = `
    You are **Sister Botina**, a kind and clear health assistant on WhatsApp for parents in South Africa.
    
    **CRITICAL RULE:** All your answers must be extremely **simple, short, and easy to understand**, suitable for a person with low literacy (Grade 4-6 level). Use **simple words**, **short sentences**, and **bullet points** when helpful. Avoid medical jargon or complex technical terms. Be empathetic and supportive.
    
    Translate the user's question into the best response in the user's current language before answering.
    
    *Example Tone:* "Don't worry, a little fever after the shot is normal. It means the medicine is working! Give your baby lots of cuddles. If the fever is very high, please call your clinic."
    
    If you cannot answer, gently remind the parent to call a nurse or doctor.
`;


// ======================================================================
// HELPER FUNCTIONS FOR LANGUAGE AND GREETING DETECTION
// ======================================================================

/**
 * Checks if the message is a simple, non-question greeting.
 */
function isGreeting(text) {
    const lowerText = text.toLowerCase().trim();
    // Common SA greetings in various languages
    const greetings = ['hi', 'hello', 'molo', 'mholweni', 'sawubona', 'sawbona', 'hallo', 'howzit', 'hey'];
    
    // Check if the message is only a greeting or very short (max 5 characters)
    return lowerText.length > 0 && (greetings.includes(lowerText) || lowerText.length <= 5);
}

/**
 * Attempts to detect the user's language based on the greeting used.
 */
function detectLanguageFromGreeting(text) {
    const lowerText = text.toLowerCase().trim();
    if (lowerText.includes('molo') || lowerText.includes('mholweni')) return 'xh'; // Xhosa
    if (lowerText.includes('sawubona') || lowerText.includes('sawbona')) return 'zu'; // isiZulu
    if (lowerText.includes('hallo')) return 'af'; // Afrikaans
    return 'en'; // Default
}

/**
 * Simple function to get the current user state, or initialize a new one.
 */
function getUserState(chatID) {
    if (!userStates.has(chatID)) {
        userStates.set(chatID, { 
            language: 'en', 
            menuState: 'initial', 
            childBirthDate: null, 
            chatHistory: [] 
        });
    }
    return userStates.get(chatID);
}

// ======================================================================
// GEMINI API HANDLERS (UPDATED WITH LOW-LITERACY PROMPT)
// ======================================================================

/**
 * Calls the Gemini API with the full chat history and a specific system instruction.
 */
async function callGeminiAPI(history, lang) {
    const systemPrompt = BASE_SYSTEM_INSTRUCTION.replace('current language', lang);

    const payload = {
        contents: history,
        config: {
            systemInstruction: systemPrompt
        }
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': GEMINI_API_KEY },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`API call failed with status: ${response.status}`);
        }

        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text || content[lang]['invalid_input'];
    } catch (error) {
        console.error('Error calling Gemini API:', error);
        return content[lang]['gemini_intro'] + ' I am currently having trouble connecting to my brain. Please try asking again or type *\'menu\'* for my core options.';
    }
}

/**
 * Handles the user's message as an NLP query.
 */
async function handleGeminiQuery(msg, userState) {
    const chatID = msg.from;
    const text = msg.body;
    const lang = userState.language;

    // 1. Add user message to history
    userState.chatHistory.push({ role: "user", parts: [{ text }] });
    
    // Cap history size to prevent overly long requests
    if (userState.chatHistory.length > 10) {
        userState.chatHistory.splice(0, userState.chatHistory.length - 10);
    }

    // 2. Call Gemini API
    const replyText = await callGeminiAPI(userState.chatHistory, lang);

    // 3. Add bot reply to history
    userState.chatHistory.push({ role: "model", parts: [{ text: replyText }] });

    // 4. Send the reply
    await msg.reply(replyText);

    // 5. Update state (no menu state change needed, remain in 'awaiting_question')
    userStates.set(chatID, userState);
    saveUserToSupabase(userState); // Assuming this function saves the updated state
}


// ======================================================================
// UTILITY FUNCTIONS (Placeholders - MUST BE FULLY DEFINED IN REAL BOT)
// ======================================================================

/**
 * Handles language selection from the menu.
 */
async function handleLanguageChange(msg, userState) {
    const langOptions = { '1': 'en', '2': 'af', '3': 'zu', '4': 'xh' };
    const newLangCode = langOptions[msg.body];

    if (newLangCode) {
        const oldLang = userState.language;
        userState.language = newLangCode;
        userState.menuState = 'awaiting_question'; // Back to conversation
        userStates.set(msg.from, userState);
        await msg.reply(content[newLangCode]['language_changed']);
        await msg.reply(content[newLangCode]['welcome_simple_hi']);
    } else {
        await msg.reply(content[userState.language]['invalid_input']);
    }
}

/**
 * Handles menu options (1, 2, 3, 4, 5) when user is in a menu state.
 * Returns true if input was handled as a menu option.
 */
async function handleMenuSelection(msg, userState) {
    const chatID = msg.from;
    const lang = userState.language;
    const text = msg.body.trim();
    let handled = true;
    let reply = '';
    
    // Check if coming from main menu
    if (userState.menuState === 'main') {
        userState.menuState = 'awaiting_question'; // Assume conversation after one click
        switch (text) {
            case '1':
                reply = content[lang]['info_menu'];
                userState.menuState = 'info_menu'; // Go to next menu level
                break;
            case '2':
                reply = content[lang]['schedule_no_birthdate'];
                userState.menuState = 'awaiting_birthdate';
                break;
            case '3':
                reply = content[lang]['emotional_support_intro'];
                userState.menuState = 'awaiting_question'; // Back to conversation, let Gemini handle support topics
                break;
            case '4':
                reply = content[lang]['welcome_simple_hi'].replace(/.*\n/, 'Please choose your new language by number:');
                userState.menuState = 'changing_language';
                break;
            case '5':
                reply = content[lang]['contact_help'];
                userState.menuState = 'awaiting_question'; 
                break;
            default:
                reply = content[lang]['invalid_input'];
                userState.menuState = 'main'; // Stay in main menu if invalid
                handled = false;
        }
    } else if (userState.menuState === 'info_menu') {
        userState.menuState = 'awaiting_question'; // Assume conversation after one click
        switch (text) {
             case '1': reply = content[lang]['info_benefits_safety']; break;
             case '2': reply = content[lang]['info_side_effects']; break;
             case '3': reply = content[lang]['info_schedule_explanation']; break;
             case '4': reply = content[lang]['info_misinformation']; break;
             case '5': reply = content[lang]['main_menu_prompt']; userState.menuState = 'main'; break;
             default: reply = content[lang]['invalid_input']; userState.menuState = 'info_menu'; handled = false;
        }
    } else {
        handled = false; // Not in a menu state
    }

    if (handled) {
        await msg.reply(reply);
        userStates.set(chatID, userState);
        saveUserToSupabase(userState);
    }
    return handled;
}

/**
 * Handles saving the birth date input.
 */
async function handleScheduleInput(msg, userState) {
    const chatID = msg.from;
    const lang = userState.language;
    const birthDate = moment(msg.body, 'YYYY-MM-DD', true);

    if (birthDate.isValid()) {
        userState.childBirthDate = birthDate.format('YYYY-MM-DD');
        userState.menuState = 'awaiting_question'; // Back to conversation
        userStates.set(chatID, userState);

        let reply = content[lang]['schedule_confirm_birthdate'].replace('%BIRTHDATE%', userState.childBirthDate);
        
        // This is where you would call your reminder scheduler logic
        // startReminderScheduler(userState.whatsappId, userState.childBirthDate, lang);

        await msg.reply(reply);
    } else {
        await msg.reply(content[lang]['schedule_no_birthdate'] + '\n\n' + content[lang]['invalid_input']);
        userState.menuState = 'awaiting_birthdate'; // Stay in this state
    }
    userStates.set(chatID, userState);
    saveUserToSupabase(userState);
}


// ======================================================================
// MAIN WHATSAPP CLIENT EVENT HANDLERS
// ======================================================================

async function loadInitialData() {
    try {
        content = await readJsonFile('content.json');
        // Simulate loading user data for state preservation
        const persistedUsers = await loadUsersFromSupabase(); 
        
        persistedUsers.forEach(user => {
            userStates.set(user.whatsappId, {
                language: user.language || 'en',
                menuState: user.menuState || 'initial',
                childBirthDate: user.childBirthDate || null,
                lastReminderSent: user.lastReminderSent || null,
                chatHistory: user.chatHistory || []
            });
        });
        console.log('Initial content and user data loaded.');
    } catch (error) {
        console.error('Failed to load initial data:', error);
        // Do not exit, use default in-memory maps if file load fails
    }
}

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('Client is ready!');
    await loadInitialData();
    // Start scheduler on ready (assuming it runs independently)
    // startReminderScheduler(client, userStates, content); 
});

client.on('message', async (msg) => {
    const chatID = msg.from;
    const userState = getUserState(chatID);
    const text = msg.body || '';
    const lowerText = text.toLowerCase().trim();
    const lang = userState.language;

    // --- 1. SPECIAL STATES (Non-Conversational) ---
    // Handle Birthdate Input
    if (userState.menuState === 'awaiting_birthdate') {
        await handleScheduleInput(msg, userState);
        return;
    }
    // Handle Language Change Input
    if (userState.menuState === 'changing_language') {
        await handleLanguageChange(msg, userState);
        return;
    }

    // --- 2. INITIAL CONTACT / GREETING ---
    if (userState.menuState === 'initial' || isGreeting(lowerText)) {
        const detectedLang = detectLanguageFromGreeting(lowerText);

        // Update state with detected language and move to conversational mode
        userState.language = detectedLang;
        userState.menuState = 'awaiting_question'; 
        userStates.set(chatID, userState);
        saveUserToSupabase(userState);

        // Respond with simple, conversational welcome
        const welcomeMessageKey = 'welcome_simple_hi';
        await msg.reply(content[detectedLang][welcomeMessageKey]);
        return;
    }

    // --- 3. EXPLICIT MENU / OPTION COMMANDS ---
    if (lowerText === 'menu' || lowerText === 'options') {
        userState.menuState = 'main'; // Force menu state
        userStates.set(chatID, userState);
        saveUserToSupabase(userState);
        await msg.reply(content[lang]['main_menu_prompt']); 
        return;
    }

    // Handle inputs if user is currently *inside* a menu structure
    if (userState.menuState === 'main' || userState.menuState === 'info_menu') {
        const handled = await handleMenuSelection(msg, userState);
        if (handled) return;
    }
    
    // --- 4. DEFAULT TO CONVERSATIONAL NLP ---
    // All other messages (questions, statements, emotional support) go to Gemini
    await handleGeminiQuery(msg, userState);
});

client.initialize();
