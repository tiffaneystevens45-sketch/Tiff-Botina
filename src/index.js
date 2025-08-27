const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const fetch = require('node-fetch');
const { readJsonFile, saveUserToSupabase, loadUsersFromSupabase } = require('./utils/fileHandler');
const { startReminderScheduler, calculateVaccineDate } = require('./utils/reminderScheduler');

// ======================================================================
// ENHANCEMENT: SISTER BOTINA 2.0 - HYBRID CHATBOT LOGIC
// This code has been updated to integrate Gemini for dynamic conversations
// while keeping the existing menu-driven functionality for core features.
// ======================================================================

// Initialize WhatsApp Client
// Initialize WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Gemini API Configuration
// NOTE: YOUR API KEY HERE. This is crucial for the conversational functionality.
const GEMINI_API_KEY = "AIzaSyBaHbEbjIHrgJsJBdsNNEE3J10HO6QIBZc";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent";

// Global state for content and users (loaded from JSON, but planned for Supabase)
let content = {};
let users = [];

// In-memory user state management. Now includes chat history.
const userStates = new Map();

// ======================================================================
// ALL HANDLER FUNCTIONS ARE NOW DEFINED FIRST TO AVOID REFERENCE ERRORS
// ======================================================================

/**
 * Loads initial data from JSON files and a placeholder for Supabase.
 */
async function loadInitialData() {
  try {
    content = await readJsonFile('content.json');
    users = await loadUsersFromSupabase();
    console.log('Initial content and user data loaded.');

    // Initialize userStates map from persisted users data for quick access
    users.forEach(user => {
      userStates.set(user.whatsappId, {
        language: user.language || 'en',
        menuState: user.menuState || 'main',
        childBirthDate: user.childBirthDate || null,
        lastReminderSent: user.lastReminderSent || null,
        chatHistory: user.chatHistory || [] // Load existing chat history
      });
    });
  } catch (error) {
    console.error('Failed to load initial data:', error);
    process.exit(1);
  }
}

/**
 * Saves user data to the planned Supabase database via a placeholder function.
 */
async function saveUserData() {
  const usersToSave = Array.from(userStates.entries()).map(([id, state]) => ({
    whatsappId: id,
    language: state.language,
    menuState: state.menuState,
    childBirthDate: state.childBirthDate,
    lastReminderSent: state.lastReminderSent,
    chatHistory: state.chatHistory // Save chat history
  }));
  for (const user of usersToSave) {
    await saveUserToSupabase(user);
  }
  console.log('User data saved.');
}

/**
 * Calls the Gemini API to get a dynamic response.
 * @param {Array} chatHistory - The conversation history.
 * @param {string} userPrompt - The user's new message.
 * @returns {Promise<string>} - The response from the Gemini API.
 */
async function getGeminiResponse(chatHistory, userPrompt) {
  // FIX: Check for a valid API key before making the call.
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in environment variables. Please configure it for Render.");
    return "I'm sorry, my conversational engine is not configured correctly. Please let the developer know.";
  }

  chatHistory.push({ role: "user", parts: [{ text: userPrompt }] });
  const payload = { contents: chatHistory };

  try {
    const response = await fetch(GEMINI_API_URL + `?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
        console.error(`Gemini API error: ${response.status} ${response.statusText}`);
        return "I'm sorry, I'm having trouble connecting to my conversational engine right now. Please try again later or type 'menu' to use my other features.";
    }

    const result = await response.json();
    const geminiText = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (geminiText) {
      chatHistory.push({ role: "model", parts: [{ text: geminiText }] });
      return geminiText;
    } else {
      console.error("Gemini API response was empty or malformed.");
      return "I'm sorry, I couldn't generate a response. Please try asking in a different way.";
    }
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    return "I'm sorry, I'm having a technical issue. Please type 'menu' to return to the main options.";
  }
}

/**
 * Handles the initial language selection.
 */
async function handleLanguageSelection(msg, userState, userInput) {
  const langMap = {
    '1': 'en',
    '2': 'af',
    '3': 'zu',
    '4': 'xh'
  };

  const selectedLang = langMap[userInput];
  if (selectedLang && content[selectedLang]) {
    userState.language = selectedLang;
    userState.menuState = 'main';
    await saveUserData();
    // FIX: Removed the disclaimer message and only sending the main menu.
    await msg.reply(content[userState.language].main_menu);
  } else {
    await msg.reply(content[userState.language].invalid_input + '\n' + content[userState.language].welcome);
  }
}

/**
 * Main message routing function.
 */
async function handleMessage(msg, userState, userInput, userLang) {
  switch (userState.menuState) {
    case 'main':
      await handleMainMenu(msg, userState, userInput, userLang);
      break;
    case 'info_menu':
      await handleInfoMenu(msg, userState, userInput, userLang);
      break;
    case 'schedule_menu':
      await handleScheduleMenu(msg, userState, userInput, userLang);
      break;
    case 'conversational_mode':
      const geminiResponse = await getGeminiResponse(userState.chatHistory, userInput);
      await msg.reply(geminiResponse);
      await saveUserData();
      break;
    case 'awaiting_birthdate':
      await handleBirthdateInput(msg, userState, userInput, userLang);
      break;
    default:
      await msg.reply(content[userLang].invalid_input + '\n' + content[userLang].main_menu);
      userState.menuState = 'main';
      userState.chatHistory = [];
      await saveUserData();
      break;
  }
}

/**
 * Handles input when in the main menu.
 */
async function handleMainMenu(msg, userState, userInput, userLang) {
  switch (userInput) {
    case '1':
      userState.menuState = 'info_menu';
      await saveUserData();
      await msg.reply(content[userLang].info_menu);
      break;
    case '2':
      userState.menuState = 'schedule_menu';
      await saveUserData();
      if (userState.childBirthDate) {
        await displayImmunizationSchedule(msg, userState);
      } else {
        await msg.reply(content[userLang].schedule_prompt_birthdate);
        userState.menuState = 'awaiting_birthdate';
        await saveUserData();
      }
      break;
    case '3':
      userState.menuState = 'conversational_mode';
      userState.chatHistory = [{ role: "user", parts: [{ text: content[userLang].emotional_support_intro }] }];
      await saveUserData();
      await msg.reply(content[userLang].gemini_intro);
      break;
    case '4':
      userState.menuState = 'language_selection';
      await saveUserData();
      await msg.reply(content[userState.language].welcome);
      break;
    case '5':
      await msg.reply(content[userLang].contact_help);
      await msg.reply(content[userLang].main_menu);
      userState.menuState = 'main';
      await saveUserData();
      break;
    case '6':
      await msg.reply(content[userLang].website_link_message);
      await msg.reply(content[userLang].main_menu);
      userState.menuState = 'main';
      await saveUserData();
      break;
    case '8':
      userState.menuState = 'conversational_mode';
      userState.chatHistory = [{ role: "user", parts: [{ text: content[userLang].gemini_intro }] }];
      await saveUserData();
      await msg.reply(content[userLang].gemini_intro);
      break;
    default:
      await msg.reply(content[userLang].invalid_input + '\n' + content[userLang].main_menu);
      break;
  }
}

/**
 * Handles input when in the immunization information menu.
 */
async function handleInfoMenu(msg, userState, userInput, userLang) {
  switch (userInput) {
    case '1':
      await msg.reply(content[userLang].info_benefits_safety);
      break;
    case '2':
      await msg.reply(content[userLang].info_side_effects);
      break;
    case '3':
      await msg.reply(content[userLang].info_schedule_explanation);
      break;
    case '4':
      await msg.reply(content[userLang].info_misinformation);
      break;
    case '5':
      userState.menuState = 'main';
      await saveUserData();
      await msg.reply(content[userLang].main_menu);
      return;
    default:
      await msg.reply(content[userLang].invalid_input);
      break;
  }
  userState.menuState = 'conversational_mode';
  await msg.reply(content[userLang].gemini_intro);
  await saveUserData();
}

/**
 * Handles input when in the vaccination schedule menu.
 */
async function handleScheduleMenu(msg, userState, userInput, userLang) {
  if (userState.childBirthDate) {
    await displayImmunizationSchedule(msg, userState);
  } else {
    await msg.reply(content[userLang].schedule_prompt_birthdate);
    userState.menuState = 'awaiting_birthdate';
    await saveUserData();
  }
}

/**
 * Handles birth date input.
 */
async function handleBirthdateInput(msg, userState, userInput, userLang) {
  const birthDate = moment(userInput, 'YYYY-MM-DD', true);
  if (birthDate.isValid() && birthDate.isBefore(moment())) {
    userState.childBirthDate = birthDate.format('YYYY-MM-DD');
    userState.menuState = 'main';
    await saveUserData();
    let confirmationMessage = content[userLang].schedule_confirm_birthdate.replace('%BIRTHDATE%', userState.childBirthDate);
    await msg.reply(confirmationMessage);
    await displayImmunizationSchedule(msg, userState);
  } else {
    await msg.reply(content[userLang].invalid_input + '\n' + content[userState.language].schedule_prompt_birthdate);
  }
}

/**
 * Displays the child's comprehensive immunization schedule.
 */
async function displayImmunizationSchedule(msg, userState) {
  const userLang = userState.language;
  const birthDateStr = userState.childBirthDate;
  const remindersData = await readJsonFile('reminders.json');
  const today = moment().startOf('day');

  if (!birthDateStr) {
    await msg.reply(content[userLang].schedule_no_birthdate);
    return;
  }

  let scheduleMessage = content[userLang].schedule_upcoming_reminders + '\n\n';
  let hasScheduleEntries = false;

  remindersData.forEach(vaccine => {
    const vaccineDate = moment(calculateVaccineDate(birthDateStr, vaccine));
    if (vaccineDate.isValid()) {
      hasScheduleEntries = true;
      let status = '';
      if (vaccineDate.isSame(today, 'day')) {
        status = ' (DUE TODAY)';
      } else if (vaccineDate.isBefore(today, 'day')) {
        status = ' (OVERDUE)';
      } else if (vaccineDate.isAfter(today, 'day')) {
        status = ' (Upcoming)';
      }
      scheduleMessage += `- ${vaccine.name}: ${vaccineDate.format('DD MMMM YYYY')}${status}\n`;
    }
  });

  if (!hasScheduleEntries) {
    scheduleMessage += content[userLang].schedule_no_upcoming_reminders;
  }

  scheduleMessage += `\n\n${content[userLang].main_menu}`;
  await msg.reply(scheduleMessage);
}

// ======================================================================
// MAIN EXECUTION FLOW - ORDERED TO PREVENT REFERENCE ERRORS
// The code below now calls the functions defined above.
// ======================================================================

// WhatsApp Client Events
client.on('qr', qr => {
  console.log('QR RECEIVED', qr);
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('Client is ready! Sister Botina 2.0 is online.');
  await loadInitialData();
  startReminderScheduler(client);
});

client.on('authenticated', () => {
  console.log('Client is authenticated!');
});

client.on('auth_failure', msg => {
  console.error('AUTHENTICATION FAILURE', msg);
});

client.on('disconnected', reason => {
  console.log('Client was disconnected', reason);
});

client.on('message', async msg => {
  const userWhatsappId = msg.from;
  const userInput = msg.body.trim();
  let userState = userStates.get(userWhatsappId);

  if (!userState) {
    userState = { language: 'en', menuState: 'language_selection', childBirthDate: null, lastReminderSent: null, chatHistory: [] };
    userStates.set(userWhatsappId, userState);
    await saveUserData();
    await msg.reply(content[userState.language].welcome);
    return;
  }
  
  const userLang = userState.language;
  const lowerInput = userInput.toLowerCase();
  
  const greetingKeywords = ['hi', 'hello', 'hey', 'start', 'menu', '0', 'sawubona', 'molo', 'hallo', 'spyskaart', 'begin', 'imenyu', 'qala'];
  if (userState.menuState === 'main' && greetingKeywords.includes(lowerInput)) {
      await msg.reply(content[userLang].main_menu);
      return;
  }

  // Handle language selection first if in that state
  if (userState.menuState === 'language_selection') {
    await handleLanguageSelection(msg, userState, userInput);
    return;
  }

  // Allow users to return to the main menu from any state
  if (lowerInput === 'back' || lowerInput === 'menu' || lowerInput === '0') {
    userState.menuState = 'main';
    userState.chatHistory = []; // Clear chat history to reset context
    await saveUserData();
    await msg.reply(content[userLang].main_menu);
    return;
  }

  // ======================================================================
  // DYNAMIC MESSAGE HANDLING
  // The logic is now more intelligent. It first checks for specific
  // menu commands. If it doesn't match, it sends the query to Gemini.
  // ======================================================================
  switch (userState.menuState) {
    case 'main':
      await handleMainMenu(msg, userState, userInput, userLang);
      break;
    case 'info_menu':
      await handleInfoMenu(msg, userState, userInput, userLang);
      break;
    case 'schedule_menu':
      await handleScheduleMenu(msg, userState, userInput, userLang);
      break;
    case 'conversational_mode':
      const geminiResponse = await getGeminiResponse(userState.chatHistory, userInput);
      await msg.reply(geminiResponse);
      await saveUserData(); // Save chat history after response
      break;
    case 'awaiting_birthdate':
      await handleBirthdateInput(msg, userState, userInput, userLang);
      break;
    default:
      await msg.reply(content[userLang].invalid_input + '\n' + content[userState.language].main_menu);
      userState.menuState = 'main';
      userState.chatHistory = [];
      await saveUserData();
      break;
  }
});

// Start the client
client.initialize();
