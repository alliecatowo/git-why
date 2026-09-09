// Small shared utilities.

function clampRetryDelay(ms) {
  return Math.min(5000, Math.max(100, ms));
}

module.exports = { clampRetryDelay };
