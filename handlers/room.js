function registerRoomHandlers(io, socket, rooms) {

  socket.on('join-room', ({ meetingUuid, userId, displayName, photoUrl, isHost, waitingRoom, maxParticipants }) => {
    const info = { userId, displayName, photoUrl: photoUrl || '' };
    socket.meetingUuid  = meetingUuid;
    socket.currentRoom  = meetingUuid;  // updated when entering a breakout

    // Enforce participant capacity (host is always allowed in)
    if (!isHost) {
      const limit   = Math.min(Math.max(parseInt(maxParticipants) || 300, 2), 500);
      const current = rooms.getAdmitted(meetingUuid).length + rooms.getWaiting(meetingUuid).length;
      if (current >= limit) {
        socket.emit('meeting-full', { limit });
        console.log(`[room] FULL          meeting=${meetingUuid}  limit=${limit}  current=${current}  name="${displayName}"`);
        return;
      }
    }

    // Lock check — block new participants; reconnects and co-host userIds are exempt
    if (!isHost && rooms.isLocked(meetingUuid)) {
      const wasAdmitted = userId && rooms.wasUserAdmitted(meetingUuid, userId);
      const isCoHostU   = userId && rooms.isCoHostUser(meetingUuid, userId);
      if (!wasAdmitted && !isCoHostU) {
        socket.emit('meeting-locked');
        console.log(`[room] LOCKED        meeting=${meetingUuid}  name="${displayName}"`);
        return;
      }
    }

    // Host always admitted directly
    if (isHost) {
      rooms.addAdmitted(meetingUuid, socket.id, info);
      socket.join(meetingUuid);

      const peers = rooms.getAdmitted(meetingUuid)
        .filter(p => p.socketId !== socket.id);
      socket.emit('admitted', { peers });
      socket.emit('meeting-lock-status', { locked: rooms.isLocked(meetingUuid) });

      // Send current waiting list to host
      const waiting = rooms.getWaiting(meetingUuid);
      socket.emit('waiting-room-update', { waiting });

      console.log(`[room] HOST joined   meeting=${meetingUuid}  name="${displayName}"  peers=${peers.length}`);
      return;
    }

    if (waitingRoom) {
      // Reconnecting logged-in user who was previously admitted → skip waiting room
      if (rooms.wasUserAdmitted(meetingUuid, userId)) {
        rooms.addAdmitted(meetingUuid, socket.id, info);
        socket.join(meetingUuid);
        const peers = rooms.getAdmitted(meetingUuid).filter(p => p.socketId !== socket.id);
        socket.emit('admitted', { peers });
        socket.emit('meeting-lock-status', { locked: rooms.isLocked(meetingUuid) });
        io.to(meetingUuid).except(socket.id).emit('peer-joined', {
          socketId: socket.id, userId: info.userId, displayName: info.displayName, photoUrl: info.photoUrl,
        });
        const waiting = rooms.getWaiting(meetingUuid);
        socket.emit('waiting-room-update', { waiting });
        console.log(`[room] RECONNECTED   meeting=${meetingUuid}  name="${displayName}"  peers=${peers.length}`);
        return;
      }

      // New participant — hold in waiting room
      rooms.joinWaiting(meetingUuid, socket.id, info);
      const waiting = rooms.getWaiting(meetingUuid);
      socket.to(meetingUuid).emit('waiting-room-update', { waiting });
      socket.emit('you-are-waiting');
      console.log(`[room] WAITING       meeting=${meetingUuid}  name="${displayName}"  queue=${waiting.length}`);
    } else {
      // No waiting room — admit directly like the host path
      rooms.addAdmitted(meetingUuid, socket.id, info);
      socket.join(meetingUuid);

      const peers = rooms.getAdmitted(meetingUuid)
        .filter(p => p.socketId !== socket.id);
      socket.emit('admitted', { peers });
      socket.emit('meeting-lock-status', { locked: rooms.isLocked(meetingUuid) });

      socket.to(meetingUuid).emit('peer-joined', {
        socketId: socket.id,
        userId: info.userId,
        displayName: info.displayName,
        photoUrl: info.photoUrl,
      });
      console.log(`[room] JOINED        meeting=${meetingUuid}  name="${displayName}"  peers=${peers.length}`);
    }
  });

  socket.on('admit-participant', ({ socketId }) => {
    const info = rooms.admit(socket.meetingUuid, socketId);
    if (!info) return;

    const admittedSocket = io.sockets.sockets.get(socketId);
    if (!admittedSocket) return;

    console.log(`[room] ADMITTED      meeting=${socket.meetingUuid}  name="${info.displayName}"`);
    admittedSocket.join(socket.meetingUuid);

    // Send existing peers (with SFU session info) to newly admitted participant
    const peers = rooms.getAdmitted(socket.meetingUuid)
      .filter(p => p.socketId !== socketId);
    admittedSocket.emit('admitted', { peers });
    admittedSocket.emit('meeting-lock-status', { locked: rooms.isLocked(socket.meetingUuid) });

    // Notify everyone in the room EXCEPT the newly admitted participant.
    // Using io.to().except() ensures the HOST also receives peer-joined —
    // socket.to() would exclude the host (the emit sender) which is the bug.
    io.to(socket.meetingUuid).except(socketId).emit('peer-joined', {
      socketId,
      userId: info.userId,
      displayName: info.displayName,
      photoUrl: info.photoUrl,
    });

    // Refresh waiting list for host
    const waiting = rooms.getWaiting(socket.meetingUuid);
    socket.emit('waiting-room-update', { waiting });
  });

  socket.on('admit-all', () => {
    const admitted = rooms.admitAll(socket.meetingUuid);
    admitted.forEach(({ socketId, ...info }) => {
      const s = io.sockets.sockets.get(socketId);
      if (!s) return;
      s.join(socket.meetingUuid);
      const peers = rooms.getAdmitted(socket.meetingUuid)
        .filter(p => p.socketId !== socketId);
      s.emit('admitted', { peers });
      s.emit('meeting-lock-status', { locked: rooms.isLocked(socket.meetingUuid) });
      // Same fix: use io.to().except() so the host receives peer-joined
      io.to(socket.meetingUuid).except(socketId).emit('peer-joined', {
        socketId, userId: info.userId, displayName: info.displayName, photoUrl: info.photoUrl,
      });
    });
    socket.emit('waiting-room-update', { waiting: [] });
  });

  // Soft kick: move participant back to waiting room
  socket.on('drop-to-waiting', ({ socketId }) => {
    const info = rooms.dropToWaiting(socket.meetingUuid, socketId);
    if (!info) return;

    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.leave(socket.meetingUuid);
      s.emit('dropped-to-waiting');
    }

    // Notify remaining room members
    io.to(socket.meetingUuid).emit('peer-left', { socketId, displayName: info.displayName });

    // Refresh waiting list for host
    const waiting = rooms.getWaiting(socket.meetingUuid);
    socket.emit('waiting-room-update', { waiting });

    console.log(`[room] DROPPED       meeting=${socket.meetingUuid}  name="${info.displayName}"`);
  });

  // Hard remove: permanently eject participant
  socket.on('remove-participant', ({ socketId }) => {
    const info = rooms.remove(socket.meetingUuid, socketId);
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.emit('removed-from-meeting');
      s.leave(socket.meetingUuid);
    }
    io.to(socket.meetingUuid).emit('peer-left', { socketId, displayName: info?.displayName || 'Participant' });

    // Refresh waiting list in case they were in waiting
    const waiting = rooms.getWaiting(socket.meetingUuid);
    socket.emit('waiting-room-update', { waiting });
  });

  socket.on('mute-request', ({ to }) => {
    io.to(to).emit('mute-request');
  });

  socket.on('unmute-request', ({ to }) => {
    io.to(to).emit('unmute-request');
  });

  socket.on('poll-create', ({ pollId, question, options }) => {
    if (!socket.meetingUuid) return;
    const info = rooms.getAdmitted(socket.meetingUuid).find(p => p.socketId === socket.id);
    socket.to(socket.meetingUuid).emit('poll-created', {
      pollId, question, options,
      creatorName: info?.displayName || 'Participant',
    });
  });

  socket.on('poll-vote', ({ pollId, optionIndex }) => {
    if (!socket.meetingUuid) return;
    socket.to(socket.meetingUuid).emit('poll-vote-update', { pollId, optionIndex });
  });

  socket.on('screen-share-start', (data) => {
    socket.to(socket.meetingUuid).emit('screen-share-start', { socketId: socket.id, ...data });
  });

  socket.on('screen-share-stop', () => {
    socket.to(socket.meetingUuid).emit('screen-share-stop', { socketId: socket.id });
  });

  socket.on('recording-started', (data) => {
    socket.to(socket.meetingUuid).emit('recording-started', { socketId: socket.id, ...data });
  });

  socket.on('recording-stopped', () => {
    socket.to(socket.meetingUuid).emit('recording-stopped', { socketId: socket.id });
  });

  socket.on('mute-status', ({ isMuted }) => {
    socket.to(socket.meetingUuid).emit('peer-mute-status', { socketId: socket.id, isMuted });
  });

  socket.on('end-meeting', () => {
    if (socket.meetingUuid) {
      socket.to(socket.meetingUuid).emit('meeting-ended');
    }
  });
  
  socket.on('cam-status', ({ isCamOff }) => {
    if (socket.meetingUuid) {
      socket.to(socket.meetingUuid).emit('peer-cam-status', { socketId: socket.id, isCamOff });
    }
  });

  socket.on('raise-hand', () => {
    if (socket.meetingUuid) {
      socket.to(socket.meetingUuid).emit('peer-raise-hand', { socketId: socket.id });
    }
  });

  socket.on('lower-hand', () => {
    if (socket.meetingUuid) {
      socket.to(socket.meetingUuid).emit('peer-lower-hand', { socketId: socket.id });
    }
  });

  socket.on('lock-meeting', () => {
    if (!socket.meetingUuid) return;
    rooms.setLocked(socket.meetingUuid, true);
    io.to(socket.meetingUuid).emit('meeting-lock-status', { locked: true });
    console.log(`[room] LOCK ON       meeting=${socket.meetingUuid}`);
  });

  socket.on('unlock-meeting', () => {
    if (!socket.meetingUuid) return;
    rooms.setLocked(socket.meetingUuid, false);
    io.to(socket.meetingUuid).emit('meeting-lock-status', { locked: false });
    console.log(`[room] LOCK OFF      meeting=${socket.meetingUuid}`);
  });

  socket.on('assign-cohost', ({ socketId }) => {
    if (!socket.meetingUuid) return;
    rooms.addCoHost(socket.meetingUuid, socketId);
    io.to(socketId).emit('you-are-cohost');
    io.to(socket.meetingUuid).emit('cohost-assigned', { socketId });
    const peer = rooms.getAdmitted(socket.meetingUuid).find(p => p.socketId === socketId);
    console.log(`[room] COHOST+       meeting=${socket.meetingUuid}  name="${peer?.displayName}"`);
  });

  socket.on('revoke-cohost', ({ socketId }) => {
    if (!socket.meetingUuid) return;
    rooms.removeCoHost(socket.meetingUuid, socketId);
    io.to(socketId).emit('cohost-revoked-self');
    io.to(socket.meetingUuid).emit('cohost-revoked', { socketId });
    console.log(`[room] COHOST-       meeting=${socket.meetingUuid}  socketId=${socketId}`);
  });

  // Relay transcript segments to all other participants in the room
  socket.on('transcript-segment', ({ speaker, text }) => {
    if (!socket.meetingUuid) return;
    socket.to(socket.meetingUuid).emit('remote-transcript-segment', { speaker, text });
  });

  // ── Breakout Rooms ────────────────────────────────────────────────────────

  // Host opens breakout rooms: brRooms = [{ name, socketIds: [] }, …]
  socket.on('open-breakout-rooms', ({ rooms: brRooms }) => {
    if (!socket.meetingUuid) return;
    const uuid = socket.meetingUuid;

    const summary = [];

    brRooms.forEach((br, idx) => {
      const roomKey = `br${idx}`;
      const roomId  = `${uuid}:${roomKey}`;

      rooms.setBreakoutRoom(uuid, roomKey, br.name, br.socketIds);

      // Build peer list for this breakout (with SFU session data)
      const brPeers = br.socketIds.map(sid => {
        const peer = rooms.getAdmitted(uuid).find(p => p.socketId === sid);
        return peer ? { socketId: sid, ...peer } : null;
      }).filter(Boolean);

      br.socketIds.forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (!s) return;

        s.leave(uuid);
        s.join(roomId);
        s.currentRoom = roomId;

        const peers = brPeers.filter(p => p.socketId !== sid);
        s.emit('assigned-to-breakout', { roomKey, roomId, roomName: br.name, peers });
      });

      summary.push({ roomKey, roomId, name: br.name, count: br.socketIds.length });
      console.log(`[room] BR-OPEN   meeting=${uuid}  room=${roomId}  n=${br.socketIds.length}`);
    });

    socket.emit('breakout-rooms-opened', { rooms: summary });
  });

  // Host ends all breakout rooms — return everyone to main
  socket.on('end-breakout-rooms', () => {
    if (!socket.meetingUuid) return;
    const uuid = socket.meetingUuid;

    const all = rooms.getAllBreakoutParticipants(uuid);
    const mainPeers = rooms.getAdmitted(uuid);

    all.forEach(({ socketId, roomKey }) => {
      const s = io.sockets.sockets.get(socketId);
      if (!s) return;

      const roomId = `${uuid}:${roomKey}`;
      s.leave(roomId);
      s.join(uuid);
      s.currentRoom = uuid;

      const peers = mainPeers.filter(p => p.socketId !== socketId);
      s.emit('returned-to-main', { peers });
    });

    rooms.clearAllBreakouts(uuid);
    socket.emit('breakout-rooms-ended');
    io.to(uuid).emit('breakout-rooms-ended');
    console.log(`[room] BR-END    meeting=${uuid}  returned=${all.length}`);
  });

  // Participant voluntarily returns to main session
  socket.on('return-from-breakout', () => {
    if (!socket.meetingUuid) return;
    const uuid    = socket.meetingUuid;
    const roomKey = rooms.getBreakoutKey(uuid, socket.id);
    if (!roomKey) return;

    const roomId = `${uuid}:${roomKey}`;
    socket.leave(roomId);
    socket.join(uuid);
    socket.currentRoom = uuid;
    rooms.leaveBreakout(uuid, socket.id);

    const peers = rooms.getAdmitted(uuid).filter(p => p.socketId !== socket.id);
    socket.emit('returned-to-main', { peers });
    console.log(`[room] BR-RETURN meeting=${uuid}  socket=${socket.id}`);
  });

  // Host broadcasts a text message to all breakout rooms + main
  socket.on('broadcast-to-breakouts', ({ message }) => {
    if (!socket.meetingUuid) return;
    const uuid = socket.meetingUuid;

    io.to(uuid).emit('host-broadcast', { message });

    const sent = new Set();
    rooms.getAllBreakoutParticipants(uuid).forEach(({ roomKey }) => {
      const roomId = `${uuid}:${roomKey}`;
      if (!sent.has(roomId)) {
        io.to(roomId).emit('host-broadcast', { message });
        sent.add(roomId);
      }
    });
    console.log(`[room] BR-BCAST  meeting=${uuid}  msg="${message.slice(0,40)}"`);
  });

  // Host joins a specific breakout room to observe
  socket.on('join-breakout-to-observe', ({ roomKey }) => {
    if (!socket.meetingUuid) return;
    const uuid   = socket.meetingUuid;
    const roomId = `${uuid}:${roomKey}`;

    socket.leave(uuid);
    socket.join(roomId);
    socket.currentRoom = roomId;

    const peerIds = rooms.getBreakoutRoomParticipants(uuid, roomKey);
    const peers   = peerIds.map(sid => {
      const p = rooms.getAdmitted(uuid).find(a => a.socketId === sid);
      return p ? { socketId: sid, ...p } : null;
    }).filter(Boolean);

    socket.emit('joined-breakout-to-observe', { roomKey, roomId, peers });
    console.log(`[room] BR-OBSERVE meeting=${uuid}  room=${roomId}`);
  });

  // Host leaves the observed breakout room and returns to main
  socket.on('leave-observed-breakout', () => {
    if (!socket.meetingUuid) return;
    const uuid = socket.meetingUuid;
    const cur  = socket.currentRoom;

    if (cur && cur !== uuid) {
      socket.leave(cur);
      socket.join(uuid);
      socket.currentRoom = uuid;
    }

    const peers = rooms.getAdmitted(uuid).filter(p => p.socketId !== socket.id);
    socket.emit('returned-to-main', { peers });
  });

}

module.exports = { registerRoomHandlers };
