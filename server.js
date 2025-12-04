const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

// Home Route
app.get("/", (req, res) => {
  res.send("ChatItNow Server is Running!");
});

const server = http.createServer(app);

// Cloud port configuration
const PORT = process.env.PORT || 3001;

const io = new Server(server, {
  // --- MOBILE STABILITY FIX START ---
  connectionStateRecovery: {
    // Allow recovery for up to 10 minutes
    maxDisconnectionDuration: 10 * 60 * 1000,
    skipMiddlewares: true,
  },
  // CRITICAL: Wait 10 MINUTES (600,000ms) before considering a user "dead"
  // This allows users to switch apps for a long time without disconnecting
  pingTimeout: 600000, 
  pingInterval: 25000,
  // --- MOBILE STABILITY FIX END ---
  
  cors: {
    origin: [
      "https://chatitnow.com",
      "https://www.chatitnow.com",
      "http://localhost:5173", 
      "https://chatitnow-frontend.vercel.app"
    ],
    methods: ["GET", "POST"]
  }
});

let waitingQueue = [];

const matchUsers = (socket1, socket2) => {
  const roomID = `${socket1.id}#${socket2.id}`;
  socket1.join(roomID);
  socket2.join(roomID);
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  // Remove both from queue
  waitingQueue = waitingQueue.filter(u => u.socket.id !== socket1.id && u.socket.id !== socket2.id);

  io.to(socket1.id).emit('matched', {
    name: socket2.userData.username,
    field: socket2.userData.field,
    roomID: roomID
  });

  io.to(socket2.id).emit('matched', {
    name: socket1.userData.username,
    field: socket1.userData.field,
    roomID: roomID
  });
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // If the connection was recovered (user came back), restore data
  if (socket.recovered) {
    console.log(`User ${socket.id} recovered connection`);
  }

  socket.on('find_partner', (userData) => {
    socket.userData = userData; 

    // DELAY 1: Wait 3 seconds
    setTimeout(() => {
      if (!socket.connected) return;

      // 1. Priority Match
      const exactMatch = waitingQueue.find(user => 
        user.socket.id !== socket.id &&
        user.userData.field !== '' &&
        user.userData.field === userData.field
      );

      if (exactMatch) {
        matchUsers(socket, exactMatch.socket);
        return;
      }

      // 2. Desperation Match
      const desperateUser = waitingQueue.find(user => 
        user.socket.id !== socket.id &&
        user.openToAny === true
      );

      if (desperateUser) {
        matchUsers(socket, desperateUser.socket);
        return;
      }

      // 3. Queue User
      const queueItem = {
        socket: socket,
        userData: userData,
        openToAny: false 
      };
      waitingQueue.push(queueItem);

      // DELAY 2: Wait 7 seconds then open to random
      setTimeout(() => {
        // Check if socket is still valid and in queue
        if (!socket.connected) return;

        const currentEntry = waitingQueue.find(u => u.socket.id === socket.id);
        if (currentEntry) {
          currentEntry.openToAny = true; 
          const anyMatch = waitingQueue.find(u => u.socket.id !== socket.id);
          if (anyMatch) {
            matchUsers(socket, anyMatch.socket);
          }
        }
      }, 7000); 

    }, 3000); 
  });

  socket.on('send_message', (messageData) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('receive_message', {
        text: messageData.text,
        type: 'stranger'
      });
    }
  });

  socket.on('typing', (isTyping) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('partner_typing', isTyping);
    }
  });

  // --- DISCONNECT HANDLER (The "Cleaner") ---
  const performDisconnect = (userSocket) => {
    // 1. Remove from queue immediately
    waitingQueue = waitingQueue.filter(s => s.socket.id !== userSocket.id);

    // 2. If in a room, notify partner
    if (userSocket.roomID) {
      userSocket.to(userSocket.roomID).emit('partner_disconnected');
      
      const room = io.sockets.adapter.rooms.get(userSocket.roomID);
      if (room) {
        for (const id of room) {
          const s = io.sockets.sockets.get(id);
          if (s) { s.leave(userSocket.roomID); s.roomID = null; }
        }
      }
      userSocket.roomID = null;
    }
  };

  // 1. MANUAL DISCONNECT (User clicked "Next" or "End")
  socket.on('disconnect_partner', () => {
    performDisconnect(socket);
  });

  // 2. AUTO DISCONNECT
  // Only fires after 10 MINUTES of no contact
  socket.on('disconnect', (reason) => {
    console.log(`User ${socket.id} disconnected. Reason: ${reason}`);
    performDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});