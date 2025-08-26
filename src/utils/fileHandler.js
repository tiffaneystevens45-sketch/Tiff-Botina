const fs = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ======================================================================
// ENHANCEMENT: Supabase Configuration & Real Functions
// This section now contains the actual implementation for Supabase.
// It retrieves credentials from environment variables for security.
// ======================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// FIX: Initializing supabase client only if credentials are provided
let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('Supabase client initialized successfully.');
} else {
  console.warn('Supabase credentials not found in environment variables. Using local JSON files for data persistence.');
}

/**
 * Loads user data from the Supabase database if available, otherwise from local JSON.
 * @returns {Promise<Array>} - The array of users.
 */
async function loadUsersFromSupabase() {
  if (supabase) {
    console.log('Fetching user data from Supabase...');
    try {
      // FIX: Changed table name from 'users' to 'profiles'
      const { data, error } = await supabase.from('profiles').select('*');
      if (error) {
        console.error('Supabase fetch error:', error);
        return await readJsonFile('users.json'); // Fallback to local file
      }
      return data;
    } catch (e) {
      console.error('Supabase connection failed:', e);
      return await readJsonFile('users.json'); // Fallback to local file
    }
  } else {
    return await readJsonFile('users.json');
  }
}

/**
 * Saves a single user to the Supabase database if available, otherwise to local JSON.
 * @param {object} user - The user object to save.
 */
async function saveUserToSupabase(user) {
  if (supabase) {
    console.log(`Saving user ${user.whatsappId} to Supabase...`);
    try {
      // Check if the user already exists
      // FIX: Changed table name from 'users' to 'profiles'
      const { data: existingUser, error: fetchError } = await supabase
        .from('profiles')
        .select('whatsappId')
        .eq('whatsappId', user.whatsappId)
        .maybeSingle();

      if (fetchError && fetchError.code !== 'PGRST116') {
        throw fetchError;
      }

      if (existingUser) {
        // User exists, so update their data
        // FIX: Changed table name from 'users' to 'profiles'
        const { data, error } = await supabase
          .from('profiles')
          .update(user)
          .eq('whatsappId', user.whatsappId);
        if (error) throw error;
        console.log(`User ${user.whatsappId} successfully updated in Supabase.`);
      } else {
        // User does not exist, so insert a new row
        // FIX: Changed table name from 'users' to 'profiles'
        const { data, error } = await supabase
          .from('profiles')
          .insert([user]);
        if (error) throw error;
        console.log(`User ${user.whatsappId} successfully created in Supabase.`);
      }
    } catch (e) {
      console.error(`Failed to save user ${user.whatsappId} to Supabase:`, e);
      // Fallback to local file on error
      const users = await readJsonFile('users.json');
      const existingUserIndex = users.findIndex(u => u.whatsappId === user.whatsappId);
      if (existingUserIndex !== -1) {
        users[existingUserIndex] = user;
      } else {
        users.push(user);
      }
      await writeJsonFile('users.json', users);
    }
  } else {
    // No Supabase, so always save to the local JSON file
    const users = await readJsonFile('users.json');
    const existingUserIndex = users.findIndex(u => u.whatsappId === user.whatsappId);
    if (existingUserIndex !== -1) {
      users[existingUserIndex] = user;
    } else {
      users.push(user);
    }
    await writeJsonFile('users.json', users);
  }
}

// ======================================================================
// END OF SUPABASE ENHANCEMENT
// The rest of the file remains the same for file-based fallback
// ======================================================================

/**
 * Reads data from a JSON file.
 * @param {string} filename - The name of the JSON file (e.g., 'users.json').
 * @returns {Promise<Array|Object>} - The parsed JSON data.
 */
async function readJsonFile(filename) {
  const filePath = path.join(__dirname, '..', 'data', filename);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`File not found: ${filePath}. Returning empty array/object.`);
      return filename === 'users.json' || filename === 'reminders.json' ? [] : {};
    }
    console.error(`Error reading file ${filename}:`, error);
    throw error;
  }
}

/**
 * Writes data to a JSON file.
 * @param {string} filename - The name of the JSON file (e.g., 'users.json').
 * @param {Array|Object} data - The data to write.
 * @returns {Promise<void>}
 */
async function writeJsonFile(filename, data) {
  const filePath = path.join(__dirname, '..', 'data', filename);
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error writing file ${filename}:`, error);
    throw error;
  }
}

module.exports = {
  readJsonFile,
  writeJsonFile,
  loadUsersFromSupabase,
  saveUserToSupabase,
};
