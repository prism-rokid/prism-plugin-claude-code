const PLUGIN = 'prism-terminal-control';
const DESCRIPTOR = '/.prism/claudecode/mod-bridge.json';
const CLIENT_INSTANCE = Math.random().toString(36).slice(2) + Date.now().toString(36);

async function descriptor($) {
  const home = await $.env.get('HOME');
  if (!home) throw new Error('HOME unavailable');
  return JSON.parse(await $.fs.read(home + DESCRIPTOR));
}

async function request($, path, body) {
  const value = await descriptor($);
  const response = await $.http.fetch('http://127.0.0.1:' + value.port + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + value.token, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, clientInstanceId: CLIENT_INSTANCE })
  });
  if (!response.ok && response.status !== 204) throw new Error('Prism bridge HTTP ' + response.status);
  return response.text ? JSON.parse(response.text) : {};
}

export function register(on) {
  let activeTurnId;
  let polling = false;
  let previousSessionId;
  let timerStarted = false;

  on('session.start', async ($, e, next) => {
    try {
      const identity = async (kind) => ({
        kind,
        sessionId: await $.session.id(),
        clientInstanceId: CLIENT_INSTANCE,
        previousSessionId,
        cwd: await $.session.cwd(),
        version: (await $.session.version()).version,
        surface: await $.session.surfaces(),
        activeTurnId: activeTurnId || null
      });
      try { await request($, '/event', await identity('session.start')); } catch { try { $.ui.status('Prism bridge offline; retrying locally'); } catch {} }
      previousSessionId = await $.session.id();
      if (!timerStarted) {
        timerStarted = true;
        $.clock.every(300, async () => {
        if (polling) return;
        polling = true;
        try {
          const state = await identity('session.current');
          await request($, '/event', state);
          previousSessionId = state.sessionId;
          const command = await request($, '/next', { sessionId: state.sessionId });
          if (!command?.id) return;
          if (command.action === 'read') {
            const draft = await $.prompt.read();
            await request($, '/event', { kind: 'read', id: command.id, sessionId: state.sessionId, draft });
          } else if (command.action === 'submit') {
            await request($, '/event', { kind: 'submit-dispatched', id: command.id, sessionId: state.sessionId });
            void $.prompt.submit({ text: command.text, asUser: true }).then(
              value => request($, '/event', { kind: 'submit-settled', id: command.id, sessionId: state.sessionId, origin: value?.origin, dropped: typeof value?.drop === 'string', text: command.text }),
              error => request($, '/event', { kind: 'submit-error', id: command.id, sessionId: state.sessionId, error: String(error) })
            ).catch(() => {});
          } else if (command.action === 'abort') {
            const turnId = command.turnId || activeTurnId;
            if (!turnId) throw new Error('no_active_turn');
            await $.turn.abort({ turnId });
            await request($, '/event', { kind: 'abort-returned', id: command.id, sessionId: state.sessionId, turnId });
          }
        } catch (error) {
          try { await request($, '/event', { kind: 'bridge-error', sessionId: await $.session.id(), error: String(error) }); } catch {}
        } finally { polling = false; }
        });
      }
    } catch (error) {
      try { $.ui.status('Prism Mod bridge unavailable'); } catch {}
    }
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    try { await request($, '/event', { kind: 'prompt.submit', sessionId: await $.session.id(), origin: e.origin }); } catch {}
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    activeTurnId = e.turnId;
    try { await request($, '/event', { kind: 'turn.start', sessionId: await $.session.id(), turnId: e.turnId, text: e.text }); } catch {}
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e);
    try { await request($, '/event', { kind: 'turn.complete', sessionId: await $.session.id(), turnId: e.turnId, reason: e.reason, isAborted: e.isAborted }); } catch {}
    if (activeTurnId === e.turnId) activeTurnId = undefined;
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    try { await request($, '/event', { kind: 'session.end', sessionId: e.sessionId || await $.session.id(), reason: e.reason }); } catch {}
    return next(e);
  });
}
