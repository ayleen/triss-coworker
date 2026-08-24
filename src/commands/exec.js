import pc from 'picocolors';
import { runAsk, validateAskOptions } from './ask.js';
import { runReview, validateReviewOptions } from './review.js';
import { runChat, validateChatOptions } from './chat.js';
import { runCoderRun, validateCoderRunOptions } from './coder.js';

const ROUTE_INFO = {
  review: { executes: 'triss review' },
  ask: { executes: 'triss ask' },
  coder: { executes: 'triss coder run' },
  chat: { executes: 'triss chat' },
};

const ROUTE_OPTION_SUPPORT = {
  provider: new Set(['ask', 'review', 'coder']),
  format: new Set(['ask', 'review']),
  system: new Set(['ask', 'chat']),
  skipIssue: new Set(['review']),
  engine: new Set(['coder']),
  agent: new Set(['coder']),
  session: new Set(['coder']),
  continue: new Set(['coder']),
  smallModel: new Set(['coder']),
  isolate: new Set(['coder']),
  noIsolate: new Set(['coder']),
  allowBestEffortCallerWorktree: new Set(['coder']),
  protectCredentials: new Set(['coder']),
  restrict: new Set(['coder']),
  noRestrict: new Set(['coder']),
  cwd: new Set(['coder']),
  timeout: new Set(['coder']),
  stream: new Set(['ask', 'review', 'chat']),
  noStream: new Set(['ask', 'review', 'chat']),
  payloadMode: new Set(['review']),
  files: new Set(['review']),
  issue: new Set(['review']),
};

const OPTION_LABELS = {
  skipIssue: '--skip-issue',
  smallModel: '--small-model',
  noIsolate: '--no-isolate',
  noRestrict: '--no-restrict',
  noStream: '--no-stream',
};

function active(value) {
  return value !== undefined && value !== null && value !== false && value !== '';
}

function optionWasSet(input, name) {
  if (name === 'isolate' || name === 'restrict' || name === 'stream') {
    return input[name] !== undefined;
  }
  return active(input[name]);
}

function optionLabel(input, name) {
  if ((name === 'isolate' || name === 'restrict' || name === 'stream') && input[name] === false) {
    return `--no-${name}`;
  }
  return OPTION_LABELS[name] || `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function validateRouteOptions(route, input) {
  const unsupported = Object.entries(ROUTE_OPTION_SUPPORT)
    .filter(([name, supported]) => optionWasSet(input, name) && !supported.has(route))
    .map(([name]) => optionLabel(input, name));
  if (unsupported.length) {
    throw new Error(`${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not supported by the ${route} route`);
  }
}

// A change verb used in a *read-only* phrasing — being updated, informed, or
// handed a summary — is not an implementation request, even when it names a
// code object afterwards ("update me on the API status", "write a summary of
// the code changes"). These run before the code-object test so such wording
// stays on chat; callers with a real implementation intent can always pass
// --code explicitly.
const READONLY_IMPERATIVES = [
  /^(?:update|inform)\s+me\s+(?:on|about|of)\b/,
  /^(?:write|create)\s+(?:a|the)\s+(?:(?:brief|concise|detailed|short)\s+){0,2}(?:summary|report|overview|description|explanation)\s+(?:of|about|for)\b/,
  /^build\s+(?:failures?|status|results?|output)\s+(?:are|is|was|were|remain|remains)\b/,
  /^write\s+(?:access|permissions?)\b.*\b(?:are|is|was|were|remain|remains)\b/,
];

function lexicalRoute(task) {
  const text = String(task || '').trim().toLowerCase();
  // Questions that merely mention a change verb are read-only. A mutating
  // route must look like an imperative request; ambiguous prose stays on chat
  // and callers can always choose --code explicitly.
  if (/^(?:what|where|when|why|how|which|should)\b/.test(text)) return 'chat';
  const imperative = text.replace(
    /^(?:(?:can|could|would)\s+you\s+(?:please\s+)?|please\s+|(?:i|we)\s+need\s+(?:you\s+)?to\s+)/,
    '',
  );
  if (
    /^(?:review|inspect|critique)\b/.test(imperative)
    || /^audit(?:[?!]*$|\s+(?:this|that)[?!]*$|\s+(?:(?:this|that|these|those|the|a|an|my|our)\s+)?(?:(?:new|current|latest|recent|existing)\s+)*(?:branches?|changes?|code|dependencies|diffs?|files?|implementations?|modules?|patches?|prs?|pull requests?|repos?|repositor(?:y|ies)|security)\b)/.test(imperative)
    || /^(?:analy[sz]e|check)\s+(?:(?:this|that|these|those|the|a|an|my|our)\s+)?(?:(?:new|current|latest|recent|existing)\s+)*(?:branches?|changes?|code|dependencies|diffs?|files?|implementations?|modules?|patches?|prs?|pull requests?|repos?|repositor(?:y|ies))\b/.test(imperative)
    || /^(?:run|perform|conduct|do)\s+(?:a\s+)?(?:(?:code|security)\s+)?(?:review|audit)\b/.test(imperative)
  ) return 'review';
  if (READONLY_IMPERATIVES.some((pattern) => pattern.test(imperative))) return 'chat';
  // "implement" and "refactor" are intrinsically mutating technical
  // imperatives. Less-specific verbs still need an artifact or defect target,
  // so requests such as "fix grammar" and "modify this" remain on chat.
  if (/^(?:implement|refactor)\b/.test(imperative)) return 'coder';
  if (
    /^(?:add|build|change|create|delete|fix|migrate|modify|remove|rename|repair|update|upgrade|write)\b/.test(imperative)
    && /\b(?:api|behavior|bugs?|class|code|command|config|crash(?:es)?|dependencies|docs?|endpoint|errors?|failures?|feature|file|function|handler|implementation|issues?|logic|logging|migration|module|option|parser|patch|readme|router|script|test|validation)\b/.test(imperative)
  ) {
    return 'coder';
  }
  return 'chat';
}

function decision(route, reason, signals) {
  return {
    schema_version: 1,
    route,
    reason,
    signals,
    executes: route ? ROUTE_INFO[route].executes : null,
  };
}

function validateDownstreamRoute(route, opts) {
  if (route === 'ask') return validateAskOptions(askOptions(opts), { checkTty: false });
  if (route === 'review') return validateReviewOptions(opts.pr, reviewOptions(opts));
  if (route === 'coder') return validateCoderRunOptions(coderOptions(opts), { prompt: opts.task });
  return validateChatOptions(chatOptions(opts), opts.task);
}

export function decideRoute(input = {}) {
  const explicit = [];
  const reviewSignals = ['pr', 'base', 'review'].filter((name) => active(input[name]));
  const askSignals = ['paths', 'urls'].filter((name) => Array.isArray(input[name]) ? input[name].length > 0 : active(input[name]));
  const coderSignals = input.code === true ? ['code'] : [];
  const chatSignals = input.chat === true ? ['chat'] : [];
  if (reviewSignals.length) explicit.push({ route: 'review', signals: reviewSignals });
  if (askSignals.length) explicit.push({ route: 'ask', signals: askSignals });
  if (coderSignals.length) explicit.push({ route: 'coder', signals: coderSignals });
  if (chatSignals.length) explicit.push({ route: 'chat', signals: chatSignals });

  if (explicit.length > 1) {
    return decision(null, `conflicting explicit routing signals: ${explicit.map((x) => x.signals.join(', ')).join(' vs ')}`, explicit.flatMap((x) => x.signals));
  }
  if (explicit.length === 1) {
    const [{ route, signals }] = explicit;
    if (input.stdin && !input.task && (route === 'ask' || route === 'review')) {
      return decision(null, `${route} with --stdin requires a positional task as the question`, signals.concat('stdin'));
    }
    return decision(route, route === 'ask' ? 'source inputs require corpus analysis' : `explicit ${signals[0]} route`, signals);
  }
  if (active(input.stdin)) {
    return decision(null, 'stdin-only execution is ambiguous; select an explicit route', ['stdin']);
  }

  const route = lexicalRoute(input.task);
  const reason = route === 'review'
    ? 'task explicitly requests review or audit'
    : route === 'coder'
      ? 'task explicitly requests implementation or change'
      : 'no explicit route; conservative default is chat';
  return decision(route, reason, []);
}

function askOptions(input) {
  return {
    paths: input.paths,
    urls: input.urls,
    stdin: input.stdin,
    question: input.task,
    provider: input.provider,
    model: input.model,
    maxTokens: input.maxTokens,
    format: input.format,
    system: input.system,
    stream: input.stream,
    noStream: input.noStream,
  };
}

function reviewOptions(input) {
  return {
    base: input.base,
    skipIssue: input.skipIssue,
    stdin: input.stdin,
    question: input.task,
    provider: input.provider,
    model: input.model,
    maxTokens: input.maxTokens,
    format: input.format,
    stream: input.stream,
    noStream: input.noStream,
    payloadMode: input.payloadMode,
    files: input.files,
    issue: input.issue,
  };
}

function coderOptions(input) {
  const names = [
    'engine', 'provider', 'model', 'smallModel', 'isolate', 'noIsolate', 'allowBestEffortCallerWorktree', 'protectCredentials', 'restrict',
    'noRestrict', 'session', 'continue', 'agent', 'cwd', 'timeout', 'stdin',
    // Crush supports a real per-run token cap. runCoderRun rejects this option
    // for OpenCode, whose CLI exposes no equivalent, instead of ignoring it.
    'maxTokens',
  ];
  return Object.fromEntries(names.filter((name) => input[name] !== undefined).map((name) => [name, input[name]]));
}

function chatOptions(input) {
  return {
    stdin: input.stdin,
    system: input.system,
    model: input.model,
    maxTokens: input.maxTokens,
    stream: input.stream,
    noStream: input.noStream,
  };
}

export async function runExecWithDeps(input = {}, deps = {}) {
  const opts = typeof input === 'string' ? { ...(deps.options || {}), task: input } : input;
  const route = decideRoute(opts);
  const stdout = deps.stdout || ((value) => process.stdout.write(value));
  const stderr = deps.stderr || ((value) => process.stderr.write(value));
  let result = route;
  if (route.route) {
    try {
      validateRouteOptions(route.route, opts);
      validateDownstreamRoute(route.route, opts);
    } catch (error) {
      if (!opts.explain) throw error;
      result = decision(null, error.message, route.signals);
    }
  }
  if (opts.explain) {
    stdout(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (!route.route) throw new Error(route.reason);
  stderr(pc.dim(`[triss/exec] route=${route.route} reason=${route.reason}\n`));

  if (route.route === 'ask') {
    return (deps.runAsk || runAsk)(askOptions(opts));
  }
  if (route.route === 'review') {
    return (deps.runReview || runReview)(opts.pr, reviewOptions(opts));
  }
  if (route.route === 'coder') {
    return (deps.runCoderRun || runCoderRun)(opts.task, coderOptions(opts));
  }
  return (deps.runChat || runChat)(opts.task, chatOptions(opts));
}

export async function runExec(task, opts = {}) {
  return runExecWithDeps({ ...opts, task });
}
