import { lookup } from 'node:dns/promises';

process.on('message', async ({ host }) => {
  try {
    const records = await lookup(host, { all: true });
    process.send?.({ ok: true, records }, () => process.exit(0));
  } catch (error) {
    process.send?.({
      ok: false,
      error: { code: error.code, message: error.message },
    }, () => process.exit(0));
  }
});
