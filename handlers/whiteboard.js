function registerWhiteboardHandlers(io, socket, rooms) {

  // Relay a stroke to everyone else in the same room (main or breakout)
  socket.on('wb-stroke', (stroke) => {
    if (!socket.meetingUuid) return;
    rooms.addWbStroke(socket.meetingUuid, stroke);
    const target = socket.currentRoom || socket.meetingUuid;
    socket.to(target).emit('wb-stroke', stroke);
  });

  // Clear the canvas for the whole room
  socket.on('wb-clear', () => {
    if (!socket.meetingUuid) return;
    rooms.clearWbStrokes(socket.meetingUuid);
    const target = socket.currentRoom || socket.meetingUuid;
    socket.to(target).emit('wb-clear');
  });

  // Send existing stroke history to a late opener so they see the current state
  socket.on('wb-request-state', () => {
    if (!socket.meetingUuid) return;
    const strokes = rooms.getWbStrokes(socket.meetingUuid);
    socket.emit('wb-state', { strokes });
  });

}

module.exports = { registerWhiteboardHandlers };
