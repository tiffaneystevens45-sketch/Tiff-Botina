const moment = require('moment');
const cron = require('node-cron');
const { readJsonFile, writeJsonFile } = require('./fileHandler');

// Load content and reminders data once
let content = {};
let reminders = [];

async function loadReminderData() {
  try {
    content = await readJsonFile('content.json');
    reminders = await readJsonFile('reminders.json');
    console.log('Reminder data loaded successfully.');
  } catch (error) {
    console.error('Failed to load reminder data:', error);
  }
}

/**
 * Calculates the exact date for a vaccine based on birth date and age_in_weeks/months/years.
 * @param {string} birthDateStr - Child's birth date in YYYY-MM-DD format.
 * @param {object} vaccine - Vaccine object from reminders.json.
 * @returns {string|null} - The calculated vaccine date in YYYY-MM-DD format, or null if invalid.
 */
function calculateVaccineDate(birthDateStr, vaccine) {
  const birthDate = moment(birthDateStr);
  if (!birthDate.isValid()) {
    return null;
  }

  let vaccineDate;
  // For birth dose, it's the birth date itself.
  if (vaccine.type === 'birth') {
    vaccineDate = birthDate.clone();
  } else if (vaccine.type === 'weeks') {
    vaccineDate = birthDate.clone().add(vaccine.age_in_weeks, 'weeks');
  } else if (vaccine.type === 'months') {
    // Approximate weeks to months for calculation.
    // A more precise approach would involve specific month/year values in reminders.json
    vaccineDate = birthDate.clone().add(vaccine.age_in_weeks / (365.25 / 12 / 7), 'months');
  } else if (vaccine.type === 'years') {
    // Approximate weeks to years for calculation.
    vaccineDate = birthDate.clone().add(vaccine.age_in_weeks / 52.177, 'years');
  } else {
    return null;
  }

  return vaccineDate.format('YYYY-MM-DD');
}

/**
 * Checks for upcoming vaccine reminders for all users and sends them.
 * This function should be called by a cron job.
 * @param {object} client - The WhatsApp client instance.
 */
async function checkAndSendReminders(client) {
  await loadReminderData(); // Ensure data is fresh
  const users = await readJsonFile('users.json');
  const today = moment().startOf('day');

  console.log(`Running reminder check for Sister Botina 2.0 at ${moment().format('YYYY-MM-DD HH:mm:ss')}`);

  for (const user of users) {
    if (!user.whatsappId || !user.childBirthDate || !user.language) {
      console.warn(`Skipping user ${user.whatsappId || 'unknown'} due to missing data.`);
      continue; // Skip users without essential data
    }

    const userLastReminderSent = user.lastReminderSent ? moment(user.lastReminderSent) : null;
    const userLang = user.language;

    for (const vaccine of reminders) {
      const vaccineDateStr = calculateVaccineDate(user.childBirthDate, vaccine);
      if (!vaccineDateStr) {
        console.warn(`Could not calculate vaccine date for ${vaccine.name} for user ${user.whatsappId}.`);
        continue;
      }

      const vaccineDate = moment(vaccineDateStr);
      const daysUntilVaccine = vaccineDate.diff(today, 'days');

      // Send reminder a week before (7 days), and on the day (0 days) if not sent yet for today.
      // Ensure reminder is only sent once per specific vaccine date.
      const shouldSendReminder = (
        (daysUntilVaccine === 7 && (!userLastReminderSent || userLastReminderSent.isBefore(today.clone().subtract(7, 'days')))) ||
        (daysUntilVaccine === 0 && (!userLastReminderSent || userLastReminderSent.isBefore(today)))
      );

      if (shouldSendReminder) {
        const messageTemplate = content[userLang].reminder_message;
        const message = messageTemplate
          .replace('%VACCINE_DATE%', vaccineDate.format('DD MMMM YYYY'))
          .replace('%VACCINE_NAME%', vaccine.name);

        try {
          await client.sendMessage(user.whatsappId, message);
          // Update last reminder sent date for the user to prevent duplicate sends on the same day
          user.lastReminderSent = today.format('YYYY-MM-DD');
          await writeJsonFile('users.json', users); // Save updated user data
          console.log(`Reminder sent to ${user.whatsappId} for ${vaccine.name} due on ${vaccineDate.format('YYYY-MM-DD')}`);
        } catch (error) {
          console.error(`Failed to send reminder to ${user.whatsappId}:`, error);
        }
      }
    }
  }
}

/**
 * Schedules the reminder check to run daily.
 * @param {object} client - The WhatsApp client instance.
 */
function startReminderScheduler(client) {
  // Schedule to run every day at 8:00 AM SAST (adjust as needed)
  cron.schedule('0 8 * * *', () => {
    console.log('Daily reminder check initiated by Sister Botina 2.0.');
    checkAndSendReminders(client);
  }, {
    scheduled: true,
    timezone: "Africa/Johannesburg" // Use a common SA timezone
  });
  console.log('Sister Botina 2.0 reminder scheduler started. Will check daily at 8:00 AM SAST.');
}

module.exports = {
  startReminderScheduler,
  calculateVaccineDate // Export for testing/displaying schedule
};
