function registerRoomHandlers(io, socket, rooms) {

  socket.on('join-room', ({ meetingUuid, userId, displayName, photoUrl, isHost, waitingRoom, maxParticipants }) => {
    const info = { userId, displayName, photoUrl: photoUrl || '' };
    socket.meetingUuid = meetingUuid;

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

}

module.exports = { registerRoomHandlers };
