/*
 * Server-to-server calls into the PHP backend so participant/chat lifecycle
 * events get persisted to the DB. The signaling server has no DB access of
 * its own, so each call forwards the acting socket's own JWT — the backend's
 * existing `jwt` filter resolves the caller (host or self) exactly as it
 * would for a normal API request, so no separate shared-secret auth is needed.
 * All calls are fire-and-forget: a failed/slow persistence call must never
 * block or break the live realtime experience.
 */

const BACKEND_URL = (process.env.BACKEND_URL || 'https://vtalanoa.com').replace(/\/+$/, '');

async function call(token, method, path, body) {
  if (!token) return null;
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[backendApi] ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  } catch (err) {
    console.warn(`[backendApi] ${method} ${path} failed: ${err.message}`);
    return null;
  }
}

/** Builds a { user_id } or { guest_id } identity body from a socket's decoded JWT payload. */
function identityBody(user) {
  if (!user) return null;
  if (user.is_guest) {
    return user.guest_id ? { guest_id: user.guest_id } : null;
  }
  return user.user_id ? { user_id: user.user_id } : null;
}

function admit(token, meetingToken, target) {
  return call(token, 'POST', `/api/meetings/${meetingToken}/admit`, target);
}

function admitAll(token, meetingToken) {
  return call(token, 'POST', `/api/meetings/${meetingToken}/admit-all`, {});
}

function remove(token, meetingToken, target) {
  return call(token, 'POST', `/api/meetings/${meetingToken}/remove`, target);
}

function dropToWaiting(token, meetingToken, target) {
  return call(token, 'POST', `/api/meetings/${meetingToken}/drop-to-waiting`, target);
}

function setMute(token, meetingToken, target, isMuted) {
  return call(token, 'POST', `/api/meetings/${meetingToken}/mute`, { ...target, is_muted: isMuted });
}

function setVideo(token, meetingToken, target, isVideoOff) {
  return call(token, 'POST', `/api/meetings/${meetingToken}/video`, { ...target, is_video_off: isVideoOff });
}

function leave(token, meetingToken) {
  return call(token, 'POST', `/api/meetings/${meetingToken}/leave`, {});
}

function sendChat(token, meetingToken, body) {
  return call(token, 'POST', `/api/chat/${meetingToken}`, body);
}

module.exports = {
  identityBody, admit, admitAll, remove, dropToWaiting, setMute, setVideo, leave, sendChat,
};
