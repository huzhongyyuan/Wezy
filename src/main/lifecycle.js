const fs = require('fs');
const path = require('path');

// Only process metadata: never log terminal output, prompts, environment or tokens.
module.exports = function lifecycle(directory) {
  return (event, details = {}) => {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'terminal-lifecycle.jsonl');
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n', { mode: 0o600 });
    } catch (error) { console.error('Unable to record terminal lifecycle:', error.message); }
  };
};
