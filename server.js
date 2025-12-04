const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

// --- FIX 1: Add a Home Route so you can check if the server is alive ---
app.get("/", (req, res) => {
  res.send("ChatItNow Server is Running!");
});

const server = http.createServer(app);

// Cloud port configuration
const PORT = process.env.PORT || 3001;

const io = new Server(server, {
  cors: {
    // --- FIX 2: Explicitly list your domains for better reliability ---
    origin: [
      "https://chatitnow.com",
      "https://www.chatitnow.com",
      "http://localhost:5173",        // For local testing
      "https://chatitnow-frontend.vercel.app" // For Vercel preview
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

  socket.on('find_partner', (userData) => {
    socket.userData = userData; 

    // DELAY 1: Force 3s wait (for Ad visibility)
    setTimeout(() => {
      if (!socket.connected) return;

      // 1. Priority Match (Same Field)
      const exactMatch = waitingQueue.find(user => 
        user.socket.id !== socket.id &&
        user.userData.field !== '' &&
        user.userData.field === userData.field
      );

      if (exactMatch) {
        matchUsers(socket, exactMatch.socket);
        return;
      }

      // 2. Desperation Match (Someone else waiting too long)
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

      // DELAY 2: Wait 7s before accepting randoms
      setTimeout(() => {
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

  const handleDisconnect = (userSocket) => {
    waitingQueue = waitingQueue.filter(s => s.socket.id !== userSocket.id);
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

  socket.on('disconnect_partner', () => handleDisconnect(socket));
  socket.on('disconnect', () => handleDisconnect(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});