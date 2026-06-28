/* In-memory room state */

const state = {};
// state[meetingUuid] = {
//   admitted:  Map<socketId, { userId, displayName, socket }>
//   waiting:   Map<socketId, { userId, displayName }>
// }

function getRoom(meetingUuid) {
  if (!state[meetingUuid]) {
    state[meetingUuid] = { admitted: new Map(), waiting: new Map() };
  }
  return state[meetingUuid];
}

function joinWaiting(meetingUuid, socketId, info) {
  const room = getRoom(meetingUuid);
  room.waiting.set(socketId, info);
}

function admit(meetingUuid, socketId) {
  const room = getRoom(meetingUuid);
  const info = room.waiting.get(socketId);
  if (!info) return null;
  room.waiting.delete(socketId);
  room.admitted.set(socketId, info);
  return info;
}

function admitAll(meetingUuid) {
  const room = getRoom(meetingUuid);
  const admitted = [];
  room.waiting.forEach((info, sid) => {
    room.admitted.set(sid, info);
    admitted.push({ socketId: sid, ...info });
  });
  room.waiting.clear();
  return admitted;
}

function addAdmitted(meetingUuid, socketId, info) {
  const room = getRoom(meetingUuid);
  room.admitted.set(socketId, info);
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
  return info;
}

function leaveAll(socketId, callback) {
  Object.keys(state).forEach(meetingUuid => {
    const room = state[meetingUuid];
    const info = room.admitted.get(socketId) || room.waiting.get(socketId);
    if (info) {
      room.admitted.delete(socketId);
      room.waiting.delete(socketId);
      callback(meetingUuid, info.displayName);
      // Clean up empty rooms
      if (room.admitted.size === 0 && room.waiting.size === 0) {
        delete state[meetingUuid];
      }
    }
  });
}

function destroyRoom(meetingUuid) {
  delete state[meetingUuid];
}

module.exports = { getRoom, joinWaiting, admit, admitAll, addAdmitted, getAdmitted, getWaiting, remove, leaveAll, destroyRoom, setSfuSession };
