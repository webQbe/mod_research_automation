function ts() {
  return new Date().toISOString(); // ISO with ms, UTC
}

// optional: include process id or a tag if helpful
function formatPrefix(taskId) {
  const pid = process.pid;
  return `[${ts()}]${taskId ? `[task:${taskId}]` : `[pid:${pid}]`}`;
}

module.exports = {
  log: (taskId, ...args) => {
    if (typeof taskId !== 'string' && typeof taskId !== 'number') {
      // called as log(...args)
      return console.log(formatPrefix(), taskId, ...args);
    }
    return console.log(formatPrefix(taskId), ...args);
  },
  info: (taskId, ...args) => {
    if (typeof taskId !== 'string' && typeof taskId !== 'number') {
      return console.info(formatPrefix(), taskId, ...args);
    }
    return console.info(formatPrefix(taskId), ...args);
  },
  warn: (taskId, ...args) => {
    if (typeof taskId !== 'string' && typeof taskId !== 'number') {
      return console.warn(formatPrefix(), taskId, ...args);
    }
    return console.warn(formatPrefix(taskId), ...args);
  },
  error: (taskId, ...args) => {
    if (typeof taskId !== 'string' && typeof taskId !== 'number') {
      return console.error(formatPrefix(), taskId, ...args);
    }
    return console.error(formatPrefix(taskId), ...args);
  }
};