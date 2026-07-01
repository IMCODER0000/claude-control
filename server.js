// Claude Control — web panel to drive Claude Code on this Mac over Tailscale.
// Spawns `claude -p --output-format stream-json` per message, streams to browser via WebSocket.
import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn, execSync } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const SESSIONS_PATH = join(DATA_DIR, 'sessions.json');
const PROFILES_PATH = join(DATA_DIR, 'profiles.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---------- config / auth ----------
function loadConfig() {
  if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return null;
}
function saveConfig(c) { writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

function ensureConfig() {
  let cfg = loadConfig();
  if (!cfg) {
    const password = randomBytes(6).toString('base64url'); // ~8 chars
    cfg = { username: 'admin', passwordHash: sha256(password), apiToken: randomBytes(24).toString('hex') };
    saveConfig(cfg);
    console.log('\n=== claude-control 첫 실행: 로그인 정보가 생성되었습니다 ===');
    console.log('   아이디:    admin');
    console.log('   비밀번호:  ' + password);
    console.log('   (변경: node server.js --set-password)\n');
  }
  return cfg;
}

if (process.argv.includes('--set-password')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question('새 아이디: ', (user) => {
    rl.question('새 비밀번호: ', (pw) => {
      const cfg = loadConfig() || { apiToken: randomBytes(24).toString('hex') };
      cfg.username = user.trim();
      cfg.passwordHash = sha256(pw.trim());
      saveConfig(cfg);
      console.log('로그인 정보가 변경되었습니다.');
      rl.close();
      process.exit(0);
    });
  });
} else {
  main();
}

// ---------- sessions store ----------
function loadSessions() {
  if (existsSync(SESSIONS_PATH)) return JSON.parse(readFileSync(SESSIONS_PATH, 'utf8'));
  return {};
}
function saveSessions(s) { writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2)); }

// ---------- profiles (account = engine + auth) ----------
function loadProfiles() {
  if (existsSync(PROFILES_PATH)) { try { return JSON.parse(readFileSync(PROFILES_PATH, 'utf8')); } catch {} }
  return {};
}
function saveProfiles(p) { writeFileSync(PROFILES_PATH, JSON.stringify(p, null, 2)); }
// Env overrides that isolate one account from another for the given CLI.
function profileEnv(p) {
  const env = {};
  if (!p) return env;
  if (p.engine === 'codex') {
    if (p.authMode === 'api-key' && p.apiKey) env.OPENAI_API_KEY = p.apiKey;
    else if (p.configDir) env.CODEX_HOME = p.configDir;
  } else { // claude
    if (p.authMode === 'api-key' && p.apiKey) env.ANTHROPIC_API_KEY = p.apiKey;
    else if (p.configDir) env.CLAUDE_CONFIG_DIR = p.configDir;
  }
  return env;
}
// Shell command the user runs once (in Terminal) to log a profile's account in.
function profileLoginCmd(p) {
  if (!p) return '';
  if (p.authMode === 'api-key') return '(API 키 방식 — 로그인 불필요)';
  if (p.engine === 'codex') return (p.configDir ? `CODEX_HOME="${p.configDir}" ` : '') + 'codex login';
  return (p.configDir ? `CLAUDE_CONFIG_DIR="${p.configDir}" ` : '') + 'claude   # 그다음 /login';
}
// Public (safe) view: never leak API keys to the browser.
function profilePublic(p) {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: !!apiKey, loginCmd: profileLoginCmd(p) };
}

// ---------- engines (Claude / ChatGPT-Codex) ----------
// Both CLIs are spawned headless and their output is normalized to the SAME
// WebSocket event protocol so the browser never needs to know which engine ran.
const hasBin = (bin) => { try { execSync('command -v ' + bin, { stdio: 'ignore' }); return true; } catch { return false; } };
const pickModel = (s, override) => {
  if (override && override !== 'default') return override;
  if (s.model && s.model !== 'default') return s.model;
  return null;
};
const ENGINES = {
  claude: {
    label: 'Claude', bin: 'claude',
    models: [
      { id: 'default', label: '기본' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
    build(s, text, modelOverride) {
      const args = ['-p', text, '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--permission-mode', 'bypassPermissions'];
      const model = pickModel(s, modelOverride);
      if (model) args.push('--model', model);
      if (s.started) args.push('--resume', s.id); else args.push('--session-id', s.id);
      return { bin: 'claude', args };
    },
  },
  codex: {
    label: 'ChatGPT', bin: 'codex',
    models: [
      { id: 'default', label: '기본' },
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-5', label: 'GPT-5' },
    ],
    // NOTE: exact codex flags / resume subcommand vary by version — validate once installed.
    build(s, text, modelOverride) {
      const model = pickModel(s, modelOverride);
      const modelArgs = model ? ['-m', model] : [];
      const common = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
      if (s.engineSessionId) {
        return { bin: 'codex', args: ['exec', 'resume', s.engineSessionId, ...common, ...modelArgs, text] };
      }
      return { bin: 'codex', args: ['exec', ...common, ...modelArgs, text] };
    },
  },
};

function main() {
  const cfg = ensureConfig();
  const sessions = loadSessions();        // id -> {id, title, cwd, engine, profileId, model, ..., messages:[]}
  const profiles = loadProfiles();        // id -> {id, name, engine, authMode, configDir, apiKey}
  const running = new Map();              // sessionId -> child process

  // Seed one default profile per engine (uses each CLI's default login) on first run.
  if (!Object.keys(profiles).length) {
    for (const [key, e] of Object.entries(ENGINES)) {
      const id = 'default-' + key;
      profiles[id] = { id, name: e.label + ' (기본)', engine: key, authMode: 'login-dir', configDir: '', apiKey: '', createdAt: Date.now() };
    }
    saveProfiles(profiles);
  }

  // Never let a stray exception take down the whole server (and every live session with it).
  process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
  // On graceful shutdown, kill children so their 'close' handlers flush in-flight turns to disk.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return; shuttingDown = true;
    for (const child of running.values()) { try { child.kill('SIGTERM'); } catch {} }
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const auth = (req, res, next) => {
    const t = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    if (t === cfg.apiToken) return next();
    res.status(401).json({ error: 'unauthorized' });
  };

  app.post('/api/login', (req, res) => {
    const userOk = !cfg.username || String(req.body.username || '') === cfg.username;
    if (userOk && sha256(String(req.body.password || '')) === cfg.passwordHash) {
      return res.json({ token: cfg.apiToken });
    }
    res.status(401).json({ error: 'bad credentials' });
  });

  app.get('/api/sessions', auth, (req, res) => {
    const list = Object.values(sessions)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(({ messages, ...meta }) => ({ ...meta, msgCount: messages.length }));
    res.json(list);
  });

  app.get('/api/sessions/:id', auth, (req, res) => {
    const s = sessions[req.params.id];
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(s);
  });

  app.post('/api/sessions', auth, (req, res) => {
    const id = randomUUID();
    let cwd = (req.body.cwd || homedir()).replace(/^~/, homedir());
    if (!existsSync(cwd)) return res.status(400).json({ error: 'cwd가 존재하지 않습니다: ' + cwd });
    const now = Date.now();
    const profile = profiles[req.body.profileId];
    const engine = profile ? profile.engine : (ENGINES[req.body.engine] ? req.body.engine : 'claude');
    const profileId = profile ? profile.id : (Object.values(profiles).find((p) => p.engine === engine)?.id || null);
    sessions[id] = {
      id, title: req.body.title || '새 세션', cwd, engine, profileId,
      model: req.body.model || 'default',
      createdAt: now, updatedAt: now, started: false, messages: [],
    };
    saveSessions(sessions);
    res.json(sessions[id]);
  });

  app.patch('/api/sessions/:id', auth, (req, res) => {
    const s = sessions[req.params.id];
    if (!s) return res.status(404).json({ error: 'not found' });
    if (typeof req.body.title === 'string') s.title = req.body.title;
    if (typeof req.body.model === 'string') s.model = req.body.model;
    if (typeof req.body.cwd === 'string') {
      const cwd = req.body.cwd.replace(/^~/, homedir());
      if (!existsSync(cwd)) return res.status(400).json({ error: 'cwd가 존재하지 않습니다' });
      s.cwd = cwd;
    }
    saveSessions(sessions);
    res.json(s);
  });

  app.delete('/api/sessions/:id', auth, (req, res) => {
    const r = running.get(req.params.id);
    if (r) try { r.kill('SIGTERM'); } catch {}
    delete sessions[req.params.id];
    saveSessions(sessions);
    res.json({ ok: true });
  });

  app.get('/api/meta', auth, (req, res) => {
    res.json({ home: homedir(), host: process.env.HOSTNAME || '' });
  });

  app.get('/api/engines', auth, (req, res) => {
    res.json(Object.entries(ENGINES).map(([key, e]) => ({
      key, label: e.label, models: e.models, available: hasBin(e.bin),
    })));
  });

  // ---------- profiles (accounts) ----------
  const sanitizeProfile = (body, base = {}) => {
    const engine = ENGINES[body.engine] ? body.engine : (base.engine || 'claude');
    const authMode = body.authMode === 'api-key' ? 'api-key' : 'login-dir';
    let configDir = typeof body.configDir === 'string' ? body.configDir.replace(/^~/, homedir()).trim() : (base.configDir || '');
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : (base.apiKey || '');
    // create the config dir so the user can log in there immediately
    if (authMode === 'login-dir' && configDir && !existsSync(configDir)) { try { mkdirSync(configDir, { recursive: true }); } catch {} }
    return {
      name: (typeof body.name === 'string' && body.name.trim()) || base.name || (ENGINES[engine].label + ' 계정'),
      engine, authMode, configDir: authMode === 'login-dir' ? configDir : '', apiKey: authMode === 'api-key' ? apiKey : '',
    };
  };

  app.get('/api/profiles', auth, (req, res) => {
    res.json(Object.values(profiles).map(profilePublic));
  });

  app.post('/api/profiles', auth, (req, res) => {
    const id = randomUUID();
    profiles[id] = { id, createdAt: Date.now(), ...sanitizeProfile(req.body) };
    saveProfiles(profiles);
    res.json(profilePublic(profiles[id]));
  });

  app.patch('/api/profiles/:id', auth, (req, res) => {
    const p = profiles[req.params.id];
    if (!p) return res.status(404).json({ error: 'not found' });
    Object.assign(p, sanitizeProfile(req.body, p));
    saveProfiles(profiles);
    res.json(profilePublic(p));
  });

  app.delete('/api/profiles/:id', auth, (req, res) => {
    if (Object.keys(profiles).length <= 1) return res.status(400).json({ error: '마지막 프로필은 삭제할 수 없습니다' });
    delete profiles[req.params.id];
    saveProfiles(profiles);
    res.json({ ok: true });
  });

  // ---------- file system browse (auth + tailnet only) ----------
  const expandPath = (p) => {
    p = String(p || '').trim();
    if (!p || p === '~') return homedir();
    if (p.startsWith('~/')) return join(homedir(), p.slice(2));
    return p;
  };
  const MAX_VIEW = 1024 * 1024; // 1MB text view cap

  app.get('/api/fs/list', auth, (req, res) => {
    try {
      const dir = expandPath(req.query.path);
      const st = statSync(dir);
      if (!st.isDirectory()) return res.status(400).json({ error: '디렉터리가 아닙니다' });
      const entries = readdirSync(dir, { withFileTypes: true }).map((d) => {
        const full = join(dir, d.name);
        let size = 0, mtime = 0, isDir = d.isDirectory();
        try { const s = statSync(full); size = s.size; mtime = s.mtimeMs; isDir = s.isDirectory(); } catch {}
        return { name: d.name, dir: isDir, size, mtime, hidden: d.name.startsWith('.') };
      }).sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name));
      res.json({ path: dir, parent: dir === '/' ? null : dirname(dir), entries });
    } catch (e) { res.status(400).json({ error: e.code === 'EACCES' ? '접근 권한이 없습니다' : e.message }); }
  });

  app.get('/api/fs/read', auth, (req, res) => {
    try {
      const p = expandPath(req.query.path);
      const st = statSync(p);
      if (st.isDirectory()) return res.status(400).json({ error: '디렉터리입니다' });
      const out = { path: p, size: st.size, mtime: st.mtimeMs };
      if (st.size > MAX_VIEW) return res.json({ ...out, tooBig: true });
      const buf = readFileSync(p);
      if (buf.subarray(0, 8000).includes(0)) return res.json({ ...out, binary: true });
      res.json({ ...out, content: buf.toString('utf8') });
    } catch (e) { res.status(400).json({ error: e.code === 'EACCES' ? '접근 권한이 없습니다' : e.message }); }
  });

  app.get('/api/fs/raw', auth, (req, res) => {
    try {
      const p = expandPath(req.query.path);
      const st = statSync(p);
      if (st.isDirectory()) return res.status(400).end();
      if (req.query.dl) res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(p.split('/').pop()) + '"');
      res.sendFile(p);
    } catch { res.status(400).end(); }
  });

  app.use(express.static(join(__dirname, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== cfg.apiToken) { ws.close(4001, 'unauthorized'); return; }

    const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'stop') {
        const child = running.get(msg.sessionId);
        if (child) try { child.kill('SIGTERM'); } catch {}
        return;
      }

      if (msg.type === 'send') {
        const s = sessions[msg.sessionId];
        if (!s) return send({ type: 'error', sessionId: msg.sessionId, message: '세션을 찾을 수 없습니다' });
        if (running.has(s.id)) return send({ type: 'error', sessionId: s.id, message: '아직 실행 중입니다' });
        runAgent(s, String(msg.text || ''), msg.model);
      }
    });

    function runAgent(s, text, modelOverride) {
      const profile = (s.profileId && profiles[s.profileId]) || null;
      const engineKey = profile?.engine || s.engine || 'claude';
      const eng = ENGINES[engineKey] || ENGINES.claude;
      const isCodex = eng.bin === 'codex';

      s.messages.push({ role: 'user', text, ts: Date.now() });
      s.updatedAt = Date.now();
      if ((!s.title || s.title === '새 세션') && text.trim()) s.title = text.trim().slice(0, 40);
      saveSessions(sessions);
      send({ type: 'user_saved', sessionId: s.id, title: s.title });

      const { bin, args } = eng.build(s, text, modelOverride);
      const child = spawn(bin, args, { cwd: s.cwd, env: { ...process.env, ...profileEnv(profile) } });
      running.set(s.id, child);
      // claude -p waits ~3s for stdin if it's left open; we have nothing to pipe in.
      try { child.stdin.end(); } catch {}
      send({ type: 'turn_start', sessionId: s.id, engine: s.engine });

      // accumulate this assistant turn for persistence
      const turn = { role: 'assistant', text: '', thinking: '', tools: [], ts: Date.now(), cost: 0 };
      const toolById = new Map();
      let textStarted = false;

      // spawn failure (e.g. binary not on PATH) emits 'error'; without this handler
      // the unhandled event would crash the whole server and kill every other session.
      child.on('error', (err) => {
        running.delete(s.id);
        const hint = err.code === 'ENOENT'
          ? `${eng.label} CLI(${bin})가 설치되어 있지 않습니다.` + (isCodex ? ' (npm i -g @openai/codex)' : '')
          : `${eng.label} 실행 실패: ${err.message}`;
        send({ type: 'error', sessionId: s.id, message: hint });
        send({ type: 'turn_end', sessionId: s.id, code: -1 });
      });

      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        line = line.trim();
        if (!line) return;
        try { if (isCodex) handleCodexLine(line); else { let ev; try { ev = JSON.parse(line); } catch { return; } handleEvent(ev); } }
        catch (e) { console.error('parse 오류:', e); }
      });

      let stderrBuf = '';
      child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

      child.on('close', (code) => {
        running.delete(s.id);
        s.started = true;
        if (turn.text || turn.tools.length || turn.thinking) s.messages.push(turn);
        s.updatedAt = Date.now();
        saveSessions(sessions);
        if (code !== 0 && !turn.text) {
          send({ type: 'error', sessionId: s.id, message: (stderrBuf || `${eng.label} exited ${code}`).slice(0, 4000) });
        }
        send({ type: 'turn_end', sessionId: s.id, code });
      });

      // ChatGPT / Codex JSONL → normalized events. Tolerant to schema drift across codex versions.
      function emitText(txt) {
        if (!txt) return;
        if (!textStarted) { textStarted = true; send({ type: 'text_start', sessionId: s.id }); }
        turn.text += txt;
        send({ type: 'text_delta', sessionId: s.id, text: txt });
      }
      function handleCodexLine(line) {
        let ev; try { ev = JSON.parse(line); } catch { emitText(line + '\n'); return; }
        const sid = ev.session_id || ev.sessionId || ev.conversation_id || ev.session?.id
          || (ev.type === 'session.created' && (ev.id || ev.session_id));
        if (sid && !s.engineSessionId) s.engineSessionId = sid;
        const type = String(ev.type || '');
        if (/delta/i.test(type) && (ev.delta || ev.text)) { emitText(ev.delta || ev.text); return; }
        const msgText = ev.text || ev.message || ev.content || ev.item?.text || ev.msg?.text || '';
        if (/agent_message|assistant|message|item\.completed/i.test(type) && msgText) { emitText(String(msgText)); return; }
        if (/command|exec|tool|patch|file_change/i.test(type)) {
          const nm = ev.command ? (Array.isArray(ev.command) ? ev.command.join(' ') : ev.command) : (ev.tool || ev.name || 'tool');
          if (ev.stdout || ev.output || ev.result || /completed|end/i.test(type))
            send({ type: 'notice', sessionId: s.id, message: '· ' + String(nm).slice(0, 120) });
          return;
        }
        if (/error/i.test(type) && (ev.message || ev.error)) send({ type: 'notice', sessionId: s.id, message: String(ev.message || ev.error).slice(0, 300) });
      }

      function handleEvent(ev) {
        switch (ev.type) {
          case 'system':
            if (ev.subtype === 'init') send({ type: 'system', sessionId: s.id, model: ev.model, cwd: ev.cwd, tools: (ev.tools || []).length });
            break;
          case 'stream_event': {
            const e = ev.event || {};
            if (e.type === 'content_block_start') {
              const b = e.content_block || {};
              if (b.type === 'tool_use') {
                toolById.set(e.index, { id: b.id, name: b.name, input: {}, result: null });
                send({ type: 'tool_use_start', sessionId: s.id, index: e.index, name: b.name });
              } else if (b.type === 'thinking') {
                send({ type: 'thinking_start', sessionId: s.id });
              } else if (b.type === 'text') {
                send({ type: 'text_start', sessionId: s.id });
              }
            } else if (e.type === 'content_block_delta') {
              const d = e.delta || {};
              if (d.type === 'text_delta') { turn.text += d.text; send({ type: 'text_delta', sessionId: s.id, text: d.text }); }
              else if (d.type === 'thinking_delta') { turn.thinking += d.thinking; send({ type: 'thinking_delta', sessionId: s.id, text: d.thinking }); }
            }
            break;
          }
          case 'assistant':
            for (const block of ev.message?.content || []) {
              if (block.type === 'tool_use') {
                const t = { id: block.id, name: block.name, input: block.input, result: null };
                turn.tools.push(t);
                toolById.set('id:' + block.id, t);
                send({ type: 'tool_use', sessionId: s.id, id: block.id, name: block.name, input: block.input });
              }
            }
            break;
          case 'user':
            for (const block of ev.message?.content || []) {
              if (block.type === 'tool_result') {
                const content = typeof block.content === 'string'
                  ? block.content
                  : (block.content || []).map((c) => c.text || '').join('\n');
                const t = toolById.get('id:' + block.tool_use_id);
                if (t) t.result = { content: content.slice(0, 20000), isError: !!block.is_error };
                send({ type: 'tool_result', sessionId: s.id, toolUseId: block.tool_use_id, content: content.slice(0, 20000), isError: !!block.is_error });
              }
            }
            break;
          case 'result':
            turn.cost = ev.total_cost_usd || 0;
            send({ type: 'result', sessionId: s.id, result: ev.result, isError: !!ev.is_error, cost: ev.total_cost_usd, durationMs: ev.duration_ms, numTurns: ev.num_turns });
            break;
          case 'rate_limit_event':
            if (ev.rate_limit_info?.status && ev.rate_limit_info.status !== 'allowed')
              send({ type: 'notice', sessionId: s.id, message: 'rate limit: ' + ev.rate_limit_info.status });
            break;
        }
      }
    }
  });

  // ---------- bind ----------
  let host = process.env.HOST;
  if (!host) {
    try { host = execSync('tailscale ip -4', { encoding: 'utf8' }).trim().split('\n')[0]; } catch { host = '0.0.0.0'; }
    if (!host) host = '0.0.0.0';
  }
  const port = Number(process.env.PORT || 8787);
  server.listen(port, host, () => {
    console.log(`claude-control 실행 중:  http://${host}:${port}`);
    if (host !== '0.0.0.0') console.log(`윈도우 노트북에서(테일넷):  http://${host}:${port}`);
  });
}
