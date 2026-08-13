// Deliberately keeps an active timer while simulating a resolver that never
// returns. The production lookup wrapper must terminate this child on abort.
setTimeout(() => {}, 500);
process.on('message', () => {});
