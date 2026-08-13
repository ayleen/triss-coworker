import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

export function requestSequence(steps, { onRequest } = {}) {
  let index = 0;
  return (url, options, callback) => {
    onRequest?.(url, options);
    const request = new EventEmitter();
    request.destroy = (error) => {
      if (error) request.emit('error', error);
    };
    request.end = () => {
      const step = steps[index++];
      if (!step || step.never) return;
      const incoming = step.stream || Readable.from(
        (step.chunks || [step.body || Buffer.alloc(0)]).map((chunk) => Buffer.from(chunk)),
      );
      incoming.statusCode = step.status ?? 200;
      incoming.statusMessage = step.statusText || 'OK';
      incoming.headers = step.headers || {};
      callback(incoming);
    };
    return request;
  };
}
