/* In-memory room state */

const state = {};
// state[meetingUuid] = {
//   admitted:           Map<socketId, { userId, displayName, identityKey?, sfuSessionId?, sfuTrackNames? }>
//   waiting:            Map<socketId, { userId, displayName, identityKey? }>
//   admittedIdentities: Set<string>  — identity keys ('u:<userId>' / 'g:<guestId>') ever
//                        admitted, derived server-side from the JWT (never the client-
//                        supplied userId, which is always 0 for guests) — used for
//                        reliable reconnects for both registered users AND guests.
//   hostIdentity:       identity key of whoever last held the live host slot, so a
//                        reconnecting host session is recognized and re-granted host
//                        status instead of falling through to the participant path.
// }

function getRoom(meetingUuid) {
  if (!state[meetingUuid]) {
    state[meetingUuid] = {
      admitted:           new Map(),
      waiting:            new Map(),
      admittedIdentities: new Set(),
      hostIdentity:       null,
      hostSocketId:    null,
      locked:          false,
      cohostSocketIds: new Set(),
      cohostUserIds:   new Set(),
      // Breakout rooms
      breakoutRooms:   {},           // roomKey → { name, participants: Set<socketId> }
      inBreakout:      new Map(),    // socketId → roomKey
      // Whiteboard
      wbStrokes:       [],           // stroke history (max 1 000)
    };
  }
  return state[meetingUuid];
}

function joinWaiting(meetingUuid, socketId, info) {
  const room = getRoom(meetingUuid);
  // Deduplicate: if a logged-in user already has an entry in waiting (different socketId),
  // remove the old entry before adding the new one to prevent duplicate rows.
  if (info.userId && info.userId !== 0 && info.userId !== '0') {
    for (const [sid, entry] of room.waiting.entries()) {
      if (String(entry.userId) === String(info.userId) && sid !== socketId) {
        room.waiting.delete(sid);
      }
    }
  }
  room.waiting.set(socketId, info);
}

function admit(meetingUuid, socketId) {
  const room = getRoom(meetingUuid);
  const info = room.waiting.get(socketId);
  if (!info) return null;
  room.waiting.delete(socketId);
  room.admitted.set(socketId, info);
  if (info.identityKey) room.admittedIdentities.add(info.identityKey);
  return info;
}

function admitAll(meetingUuid) {
  const room = getRoom(meetingUuid);
  const admitted = [];
  room.waiting.forEach((info, sid) => {
    room.admitted.set(sid, info);
    if (info.identityKey) room.admittedIdentities.add(info.identityKey);
    admitted.push({ socketId: sid, ...info });
  });
  room.waiting.clear();
  return admitted;
}

function addAdmitted(meetingUuid, socketId, info) {
  const room = getRoom(meetingUuid);
  room.admitted.set(socketId, info);
  if (info.identityKey) room.admittedIdentities.add(info.identityKey);
}

function wasIdentityAdmitted(meetingUuid, identityKey) {
  if (!identityKey) return false;
  const room = getRoom(meetingUuid);
  return room.admittedIdentities.has(identityKey);
}

// Finds the socketId currently holding an admitted connection for `identityKey`
// (excluding `excludeSocketId`) — used on reconnect to locate and evict the
// stale session, which may still look "connected" from Socket.IO's own
// perspective for up to `pingTimeout` after a real network drop.
function findAdmittedByIdentity(meetingUuid, identityKey, excludeSocketId) {
  if (!identityKey) return null;
  const room = state[meetingUuid];
  if (!room) return null;
  for (const [sid, info] of room.admitted.entries()) {
    if (sid !== excludeSocketId && info.identityKey === identityKey) return sid;
  }
  return null;
}

function getHostIdentity(meetingUuid) {
  return state[meetingUuid]?.hostIdentity ?? null;
}

function setHostIdentity(meetingUuid, identityKey) {
  const room = getRoom(meetingUuid);
  room.hostIdentity = identityKey;
}

// Tracks which single socket currently holds the live "host" slot for a
// meeting, so only the session that actually started/owns the meeting is
// ever granted host privileges — a second device on the same account joining
// while that session is still connected must fall through to the normal
// participant/waiting-room path instead.
function getHostSocketId(meetingUuid) {
  return state[meetingUuid]?.hostSocketId ?? null;
}

function setHostSocketId(meetingUuid, socketId) {
  const room = getRoom(meetingUuid);
  room.hostSocketId = socketId;
}

function clearHostSocketId(meetingUuid, socketId) {
  const room = state[meetingUuid];
  if (room && room.hostSocketId === socketId) room.hostSocketId = null;
}

function setSfuSession(meetingUuid, socketId, sfuSessionId, sfuTrackNames) {
  const room = getRoom(meetingUuid);
  const info = room.admitted.get(socketId);
  if (info) {
    info.sfuSessionId   = sfuSessionId;
    info.sfuTrackNames  = sfuTrackNames;
  }
}

function getAdmitted(meetingUuid) {
  const room = getRoom(meetingUuid);
  return Array.from(room.admitted.entries()).map(([sid, info]) => ({ socketId: sid, ...info }));
}

function getWaiting(meetingUuid) {
  const room = getRoom(meetingUuid);
  return Array.from(room.waiting.entries()).map(([sid, info]) => ({ socketId: sid, ...info }));
}

function remove(meetingUuid, socketId) {
  const room = getRoom(meetingUuid);
  const info = room.admitted.get(socketId) || room.waiting.get(socketId);
  room.admitted.delete(socketId);
  room.waiting.delete(socketId);
  if (room.hostSocketId === socketId) room.hostSocketId = null;
  return info;
}

function leaveAll(socketId, callback) {
  Object.keys(state).forEach(meetingUuid => {
    const room = state[meetingUuid];
    const info = room.admitted.get(socketId) || room.waiting.get(socketId);
    if (info) {
      room.admitted.delete(socketId);
      room.waiting.delete(socketId);
      if (room.hostSocketId === socketId) room.hostSocketId = null;
      callback(meetingUuid, info.displayName);
      // Clean up empty rooms (keep admittedIdentities alive until host ends meeting)
      if (room.admitted.size === 0 && room.waiting.size === 0) {
        delete state[meetingUuid];
      }
    }
  });
}

function dropToWaiting(meetingUuid, socketId) {
  const room = getRoom(meetingUuid);
  const info = room.admitted.get(socketId);
  if (!info) return null;
  room.admitted.delete(socketId);
  // Strip SFU session so they get a fresh one if re-admitted
  room.waiting.set(socketId, { userId: info.userId, displayName: info.displayName });
  return info;
}

function destroyRoom(meetingUuid) {
  delete state[meetingUuid];
}

function isLocked(meetingUuid) {
  return state[meetingUuid]?.locked ?? false;
}

function setLocked(meetingUuid, locked) {
  const room = getRoom(meetingUuid);
  room.locked = locked;
}

function addCoHost(meetingUuid, socketId) {
  const room = getRoom(meetingUuid);
  room.cohostSocketIds.add(socketId);
  const info = room.admitted.get(socketId);
  if (info?.userId && info.userId !== 0 && info.userId !== '0') {
    room.cohostUserIds.add(String(info.userId));
  }
}

function removeCoHost(meetingUuid, socketId) {
  const room = getRoom(meetingUuid);
  room.cohostSocketIds.delete(socketId);
}

function isCoHost(meetingUuid, socketId) {
  return state[meetingUuid]?.cohostSocketIds.has(socketId) ?? false;
}

function isCoHostUser(meetingUuid, userId) {
  if (!userId || userId === 0 || userId === '0') return false;
  return state[meetingUuid]?.cohostUserIds.has(String(userId)) ?? false;
}

function getCoHosts(meetingUuid) {
  return Array.from(state[meetingUuid]?.cohostSocketIds ?? []);
}

// ── Breakout Rooms ─────────────────────────────────────────────────────────

function setBreakoutRoom(meetingUuid, roomKey, name, socketIds) {
  const room = getRoom(meetingUuid);
  room.breakoutRooms[roomKey] = { name, participants: new Set(socketIds) };
  socketIds.forEach(sid => room.inBreakout.set(sid, roomKey));
}

function assignToBreakout(meetingUuid, socketId, roomKey) {
  const room = getRoom(meetingUuid);
  room.inBreakout.set(socketId, roomKey);
  if (room.breakoutRooms[roomKey]) {
    room.breakoutRooms[roomKey].participants.add(socketId);
  }
}

function getBreakoutKey(meetingUuid, socketId) {
  return state[meetingUuid]?.inBreakout.get(socketId) ?? null;
}

function getBreakoutRoomParticipants(meetingUuid, roomKey) {
  const br = state[meetingUuid]?.breakoutRooms[roomKey];
  return br ? Array.from(br.participants) : [];
}

function getAllBreakoutParticipants(meetingUuid) {
  const room = state[meetingUuid];
  if (!room) return [];
  const result = [];
  room.inBreakout.forEach((roomKey, socketId) => result.push({ socketId, roomKey }));
  return result;
}

function leaveBreakout(meetingUuid, socketId) {
  const room = state[meetingUuid];
  if (!room) return;
  const key = room.inBreakout.get(socketId);
  if (key && room.breakoutRooms[key]) {
    room.breakoutRooms[key].participants.delete(socketId);
  }
  room.inBreakout.delete(socketId);
}

function clearAllBreakouts(meetingUuid) {
  const room = state[meetingUuid];
  if (!room) return;
  room.inBreakout.clear();
  room.breakoutRooms = {};
}

function hasActiveBreakouts(meetingUuid) {
  return (state[meetingUuid]?.inBreakout.size ?? 0) > 0;
}

// ── Whiteboard ─────────────────────────────────────────────────────────────

const WB_MAX_STROKES = 1000;

function addWbStroke(meetingUuid, stroke) {
  const room = getRoom(meetingUuid);
  room.wbStrokes.push(stroke);
  if (room.wbStrokes.length > WB_MAX_STROKES) {
    room.wbStrokes = room.wbStrokes.slice(-WB_MAX_STROKES);
  }
}

function getWbStrokes(meetingUuid) {
  return state[meetingUuid]?.wbStrokes ?? [];
}

function clearWbStrokes(meetingUuid) {
  const room = state[meetingUuid];
  if (room) room.wbStrokes = [];
}

module.exports = {
  getRoom, joinWaiting, admit, admitAll, addAdmitted, getAdmitted,
  getWaiting, remove, leaveAll, destroyRoom, setSfuSession,
  dropToWaiting, wasIdentityAdmitted, findAdmittedByIdentity,
  getHostIdentity, setHostIdentity,
  getHostSocketId, setHostSocketId, clearHostSocketId,
  isLocked, setLocked, addCoHost, removeCoHost, isCoHost, isCoHostUser, getCoHosts,
  // Breakout
  setBreakoutRoom, assignToBreakout, getBreakoutKey, getBreakoutRoomParticipants,
  getAllBreakoutParticipants, leaveBreakout, clearAllBreakouts, hasActiveBreakouts,
  // Whiteboard
  addWbStroke, getWbStrokes, clearWbStrokes,
};
