const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { parse, stringify } = require('smol-toml');

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:48730';

function normalizeGatewayUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Gateway URL is required.');
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Gateway URL must be a valid HTTP or HTTPS URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Gateway URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Gateway URL cannot contain credentials, a query, or a fragment.');
  }

  return url.toString().replace(/\/$/, '');
}

/**
 * @param {object} [options]
 * @param {boolean} [options.defaultCloseToTray] What an unset `window.close_to_tray` means. The main
 *   process passes the packaged-build default; every other caller only needs the stored value.
 */
function loadAppConfig(configFile, env = process.env, options = {}) {
  const stored = readDocument(configFile);
  const debugStudioEnabled = readDebugStudioEnabled(stored);
  const preferences = { debug_studio_enabled: debugStudioEnabled,
    close_to_tray: readCloseToTray(stored) ?? options.defaultCloseToTray ?? false };
  const managedUrl = env.TINADEC_GATEWAY_URL?.trim();
  if (managedUrl) {
    return { gateway_url: normalizeGatewayUrl(managedUrl), source: 'environment', managed: true, path: configFile,
      ...preferences };
  }

  return { gateway_url: stored.gateway_url ? normalizeGatewayUrl(stored.gateway_url) : DEFAULT_GATEWAY_URL,
    source: stored.gateway_url ? 'user' : 'default', managed: false, path: configFile,
    ...preferences };
}

function readDocumentSource(configFile) {
  try { return fs.readFileSync(configFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function readDocument(configFile) {
  return parse(readDocumentSource(configFile));
}

function readDebugStudioEnabled(document) {
  const developer = document.developer;
  if (developer !== undefined && (!developer || typeof developer !== 'object'
      || Array.isArray(developer) || developer instanceof Date)) {
    throw new Error('desktop.toml developer must be a table.');
  }
  const value = developer?.debug_studio_enabled;
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error('desktop.toml developer.debug_studio_enabled must be a boolean.');
  }
  return value ?? false;
}

/** The window preferences table; a missing table or key leaves the decision to the caller. */
function readCloseToTray(document) {
  const windowTable = document.window;
  if (windowTable !== undefined && (!windowTable || typeof windowTable !== 'object'
      || Array.isArray(windowTable) || windowTable instanceof Date)) {
    throw new Error('desktop.toml window must be a table.');
  }
  const value = windowTable?.close_to_tray;
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error('desktop.toml window.close_to_tray must be a boolean.');
  }
  return value;
}

function writeDocumentSource(configFile, source) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const temporary = `${configFile}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, source, { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temporary, configFile); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function writeDocument(configFile, document) {
  writeDocumentSource(configFile, stringify(document));
}

/**
 * Keep surrounding TOML/comments when a narrow edit has the exact expected meaning.
 *
 * `expected` is the whole document *after* the edit, so a candidate only wins when re-parsing it
 * yields exactly that document: matching another table, a comment, or a multiline string can never
 * take effect. The value is a boolean, so neither half of the replacement needs escaping.
 */
function tableScalarDocumentSource(source, expected, table, key) {
  const value = expected[table][key];
  const setting = `${key} = ${value}`;
  const quotedKey = `(?:${key}|"${key}"|'${key}')`;
  const quotedTable = `(?:${table}|"${table}"|'${table}')`;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const matchesExpected = (candidate) => {
    try { return isDeepStrictEqual(parse(candidate), expected); }
    catch { return false; }
  };

  const scalar = new RegExp(`(${quotedKey}[ \\t]*=[ \\t]*)(true|false)\\b`, 'g');
  for (const match of source.matchAll(scalar)) {
    const position = match.index + match[1].length;
    const candidate = source.slice(0, position) + value + source.slice(position + match[2].length);
    if (matchesExpected(candidate)) return candidate;
  }

  const tableHeader = new RegExp(`^[ \\t]*\\[[ \\t]*${quotedTable}[ \\t]*\\][ \\t]*(?:#[^\\r\\n]*)?(?:\\r?\\n|$)`, 'gm');
  for (const match of source.matchAll(tableHeader)) {
    const position = match.index + match[0].length;
    const separator = match[0].endsWith('\n') ? '' : newline;
    const candidate = source.slice(0, position) + separator + setting + newline + source.slice(position);
    if (matchesExpected(candidate)) return candidate;
  }

  const inline = new RegExp(`(^[ \\t]*${quotedTable}[ \\t]*=[ \\t]*\\{)([^\\r\\n]*)(\\})`, 'gm');
  for (const match of source.matchAll(inline)) {
    const position = match.index + match[1].length;
    const candidate = source.slice(0, position) + ` ${setting}${match[2].trim() ? ', ' : ' '}` + source.slice(position);
    if (matchesExpected(candidate)) return candidate;
  }

  const separator = !source || source.endsWith('\n') ? '' : newline;
  const appended = `${source}${separator}[${table}]${newline}${setting}${newline}`;
  if (matchesExpected(appended)) return appended;
  const dotted = `${table}.${setting}${newline}${source}`;
  if (matchesExpected(dotted)) return dotted;

  // Unusual valid TOML forms still preserve all fields through the existing serializer.
  return stringify(expected);
}

function saveDebugStudioEnabled(configFile, enabled, env = process.env) {
  if (typeof enabled !== 'boolean') throw new Error('Debug Studio enabled must be a boolean.');
  const source = readDocumentSource(configFile);
  const document = parse(source);
  readDebugStudioEnabled(document);
  document.developer ??= Object.create(null);
  document.developer.debug_studio_enabled = enabled;
  writeDocumentSource(configFile, tableScalarDocumentSource(source, document, 'developer', 'debug_studio_enabled'));
  return loadAppConfig(configFile, env);
}

/** Closing the main window hides it to the tray instead of quitting the app. */
function saveCloseToTray(configFile, enabled, env = process.env) {
  if (typeof enabled !== 'boolean') throw new Error('Close to tray must be a boolean.');
  const source = readDocumentSource(configFile);
  const document = parse(source);
  readCloseToTray(document);
  document.window ??= Object.create(null);
  document.window.close_to_tray = enabled;
  writeDocumentSource(configFile, tableScalarDocumentSource(source, document, 'window', 'close_to_tray'));
  return loadAppConfig(configFile, env);
}

function saveGatewayUrl(configFile, value, env = process.env) {
  if (env.TINADEC_GATEWAY_URL?.trim()) {
    throw new Error('Gateway URL is managed by TINADEC_GATEWAY_URL.');
  }

  const gatewayUrl = normalizeGatewayUrl(value);
  const document = readDocument(configFile);
  document.gateway_url = gatewayUrl;
  writeDocument(configFile, document);
  return loadAppConfig(configFile, env);
}

function resetGatewayUrl(configFile, env = process.env) {
  if (env.TINADEC_GATEWAY_URL?.trim()) {
    return loadAppConfig(configFile, env);
  }
  const document = readDocument(configFile);
  delete document.gateway_url;
  writeDocument(configFile, document);
  return loadAppConfig(configFile, env);
}

function saveUserStorageRoot(configFile, root, env = process.env) {
  if (env.TINADEC_HOME?.trim()) throw new Error('User storage root is managed by TINADEC_HOME.');
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('User storage root must be an absolute path.');
  const document = readDocument(configFile);
  document.user_root = path.resolve(root);
  writeDocument(configFile, document);
  return { user_root: document.user_root, path: configFile, restart_required: true };
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  loadAppConfig,
  normalizeGatewayUrl,
  resetGatewayUrl,
  saveGatewayUrl,
  saveCloseToTray,
  saveDebugStudioEnabled,
  saveUserStorageRoot,
};
