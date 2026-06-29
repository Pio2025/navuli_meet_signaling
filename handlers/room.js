function registerRoomHandlers(io, socket, rooms) {

  socket.on('join-room', ({ meetingUuid, userId, displayName, isHost, waitingRoom }) => {
    const info = { userId, displayName };
    socket.meetingUuid = meetingUuid;

    // Host always admitted directly
    if (isHost) {
      rooms.addAdmitted(meetingUuid, socket.id, info);
      socket.join(meetingUuid);

      const peers = rooms.getAdmitted(meetingUuid)
        .filter(p => p.socketId !== socket.id);
      socket.emit('admitted', { peers });

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
        io.to(meetingUuid).except(socket.id).emit('peer-joined', {
          socketId: socket.id, userId: info.userId, displayName: info.displayName,
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

      socket.to(meetingUuid).emit('peer-joined', {
        socketId: socket.id,
        userId: info.userId,
        displayName: info.displayName,
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

    // Notify everyone in the room EXCEPT the newly admitted participant.
    // Using io.to().except() ensures the HOST also receives peer-joined —
    // socket.to() would exclude the host (the emit sender) which is the bug.
    io.to(socket.meetingUuid).except(socketId).emit('peer-joined', {
      socketId,
      userId: info.userId,
      displayName: info.displayName,
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
      // Same fix: use io.to().except() so the host receives peer-joined
      io.to(socket.meetingUuid).except(socketId).emit('peer-joined', {
        socketId, userId: info.userId, displayName: info.displayName,
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

}

module.exports = { registerRoomHandlers };
