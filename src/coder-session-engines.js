/**
 * coder-session-engines.js — the canonical v2 coder session engine enum.
 *
 * Dependency-neutral single source of truth: every surface that names the
 * persistent v2 session engines (session transitions, CLI list/clean,
 * state backup/rollback, result registry validation) imports THIS list
 * instead of keeping its own hardcoded copy. A future engine added here is
 * picked up everywhere; a directory under engine-sessions-v2 that is NOT in
 * this list is an unrecognized state and must fail closed, never be ignored.
 */
export const CODER_SESSION_ENGINES = Object.freeze(['opencode', 'opencode2', 'crush']);

/**
 * Engines that own a namespace in the versioned session store
 * (.triss/sessions.json engines.*). crush keeps no store mapping.
 */
export const CODER_SESSION_STORE_ENGINES = Object.freeze(['opencode', 'opencode2']);
